import { sql, withTenant, type TransactionClient } from '@barbearia/db';
import { audit } from '@barbearia/identity';
import { instantToLocal, type TipoDeNotificacao } from '@barbearia/core';
import { reservarDisparoPromocional, confirmarDisparoPromocional, liberarDisparoPromocional } from '../disparo-promocional.js';
import { cifrarBaileys, decifrarBaileys } from '../baileys/cofre.js';

export class WhatsAppManualError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export interface EscopoManual { tenantId: string; locationId: string }
export interface AtorManual extends EscopoManual { staffId: string; staffName: string; podeAssumir?: boolean }

/** Uma inserção por lote, sem rede; UNIQUE mantém a intenção entre retomadas. */
export async function prepararFilaManual(tenantId: string, agora: Date, campanhaId?: string): Promise<boolean> {
  return withTenant(tenantId, async tx => {
    if (campanhaId) {
      const [campanha] = await tx.$queryRaw<{ id: string }[]>`SELECT c.id FROM campaigns c
        JOIN whatsapp_templates w ON w.id = c.template_id
        WHERE c.id = ${campanhaId}::uuid AND w.transport = 'manual'`;
      if (!campanha) return false;
      await tx.$executeRaw`INSERT INTO whatsapp_manual_queue
        (tenant_id, location_id, customer_id, template_id, campaign_target_id, template_body, kind, created_at)
        SELECT t.tenant_id, w.location_id, t.customer_id, w.id, t.id, w.body, c.kind, ${agora}
        FROM campaign_targets t JOIN campaigns c ON c.id = t.campaign_id
        JOIN whatsapp_templates w ON w.id = c.template_id
        WHERE c.id = ${campanhaId}::uuid AND c.status = 'enviando' AND w.transport = 'manual'
          AND t.sent_at IS NULL AND t.skipped_reason IS NULL
        ON CONFLICT (campaign_target_id) DO NOTHING`;
      await tx.$executeRaw`UPDATE campaigns c SET status = 'enviada' WHERE c.id = ${campanhaId}::uuid
        AND c.status = 'enviando' AND NOT EXISTS (SELECT 1 FROM campaign_targets t WHERE t.campaign_id = c.id AND t.sent_at IS NULL AND t.skipped_reason IS NULL)`;
      return true;
    }
    await tx.$executeRaw`INSERT INTO whatsapp_manual_queue
      (tenant_id, location_id, customer_id, template_id, automation_send_id, template_body, kind, created_at)
      SELECT s.tenant_id, w.location_id, s.customer_id, w.id, s.id, w.body, a.kind, ${agora}
      FROM automation_sends s JOIN automations a ON a.id = s.automation_id
      JOIN whatsapp_templates w ON w.id = a.template_id
      WHERE a.active AND w.transport = 'manual' AND s.sent_at IS NULL AND s.skipped_reason IS NULL
        AND s.scheduled_for <= ${agora} ON CONFLICT (automation_send_id) DO NOTHING`;
    return true;
  });
}

interface LinhaManual {
  id: string; customer_id: string; template_id: string; kind: TipoDeNotificacao;
  campaign_target_id: string | null; automation_send_id: string | null;
  template_body: string; status: 'pendente' | 'em_atendimento' | 'enviado' | 'descartado';
  claimed_by: string | null; claimed_at: Date | null; sent_at: Date | null;
  payload_cipher: string | null; reason: string | null; created_at: Date;
  name: string; phone_e164: string | null; accepts_marketing: boolean; anonymized_at: Date | null;
  timezone: string; barbearia: string; local_enabled: boolean; ativa: boolean;
  origem: string; operador: string | null; enviado_por: string | null;
}
const colunas = sql`q.*, c.name, c.phone_e164, c.accepts_marketing, c.anonymized_at, l.timezone,
  tn.name AS barbearia, w.local_enabled, COALESCE(a.active, true) AS ativa,
  COALESCE(ca.name, a.name) AS origem, st.name AS operador, se.name AS enviado_por`;
const tabelas = sql`whatsapp_manual_queue q JOIN customers c ON c.id = q.customer_id
  JOIN locations l ON l.id = q.location_id JOIN tenants tn ON tn.id = q.tenant_id
  JOIN whatsapp_templates w ON w.id = q.template_id
  LEFT JOIN campaign_targets ct ON ct.id = q.campaign_target_id LEFT JOIN campaigns ca ON ca.id = ct.campaign_id
  LEFT JOIN automation_sends aus ON aus.id = q.automation_send_id LEFT JOIN automations a ON a.id = aus.automation_id
  LEFT JOIN staff_users st ON st.id = q.claimed_by LEFT JOIN staff_users se ON se.id = q.sent_by`;

export async function filaWhatsAppManual(p: EscopoManual & { staffId?: string; antes?: string; visao?: 'pendentes' | 'historico' }) {
  return withTenant(p.tenantId, async tx => {
    const linhas = await tx.$queryRaw<LinhaManual[]>(sql`SELECT ${colunas} FROM ${tabelas}
      WHERE q.location_id = ${p.locationId}::uuid
        AND (${p.visao ?? null}::text IS NULL OR (${p.visao ?? null} = 'pendentes' AND q.status IN ('pendente','em_atendimento'))
          OR (${p.visao ?? null} = 'historico' AND q.status IN ('enviado','descartado')))
        AND (${p.antes ?? null}::uuid IS NULL OR (q.created_at, q.id) <
          (SELECT created_at, id FROM whatsapp_manual_queue WHERE id = ${p.antes ?? null}::uuid AND location_id = ${p.locationId}::uuid))
      ORDER BY q.created_at DESC, q.id DESC LIMIT 51`);
    return { itens: linhas.slice(0, 50).map(l => ({ id: l.id, clienteId: l.customer_id, cliente: l.name, origem: l.origem, fuso: l.timezone,
      tipo: l.campaign_target_id ? 'campanha' as const : 'automacao' as const, estado: l.status,
      minhaReserva: l.claimed_by === p.staffId, operadorId: l.claimed_by, operador: l.operador, abertoEm: l.claimed_at?.toISOString() ?? null,
      enviadoEm: l.sent_at?.toISOString() ?? null, enviadoPor: l.enviado_por, motivo: l.reason,
      criadoEm: l.created_at.toISOString(), disponivel: l.ativa && l.local_enabled && l.accepts_marketing && !l.anonymized_at,
    })), proximo: linhas.length > 50 ? linhas[49]?.id ?? null : null };
  });
}

const intentKey = (l: LinhaManual) => l.campaign_target_id ? `promo:campanha:${l.campaign_target_id}` : `promo:automacao:${l.automation_send_id}`;
const escopoCifra = (p: EscopoManual, id: string) => `manual:${p.tenantId}:${p.locationId}:${id}`;
interface ConteudoManual { telefone: string; texto: string }
export function linkWhatsAppManual(c: ConteudoManual): string {
  if (!/^\+[1-9][0-9]{7,14}$/.test(c.telefone) || !c.texto || c.texto.length > 4096) throw new WhatsAppManualError('manual_conteudo', 'Confira o telefone e a mensagem.', 400);
  return `https://wa.me/${c.telefone.slice(1)}?text=${encodeURIComponent(c.texto)}`;
}
async function obter(tx: TransactionClient, p: AtorManual, id: string): Promise<LinhaManual> {
  const [ator] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM staff_users WHERE id = ${p.staffId}::uuid AND active`;
  const [l] = await tx.$queryRaw<LinhaManual[]>(sql`SELECT ${colunas} FROM ${tabelas}
    WHERE q.id = ${id}::uuid AND q.location_id = ${p.locationId}::uuid FOR UPDATE OF q`);
  if (!ator || !l) throw new WhatsAppManualError('manual_ausente', 'Esta mensagem não está disponível nesta unidade.', 404);
  return l;
}
async function elegivel(tx: TransactionClient, l: LinhaManual, agora: Date): Promise<void> {
  if (!l.ativa || !l.local_enabled) throw new WhatsAppManualError('manual_desligado', 'A automação ou a mensagem foi desligada. Descarte este item ou reative a configuração.');
  const [saida] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM whatsapp_inbound
    WHERE customer_id = ${l.customer_id}::uuid AND handled_at IS NULL AND payload = 'parar_de_receber:' LIMIT 1`;
  if (!l.accepts_marketing || l.anonymized_at || saida) throw new WhatsAppManualError('manual_sem_consentimento', 'Este cliente não aceita mais promoções. Descarte a mensagem.');
  if (!l.phone_e164) throw new WhatsAppManualError('manual_sem_telefone', 'Cadastre o telefone do cliente antes de abrir a conversa.');
  const hora = instantToLocal(l.timezone, agora).minutes;
  if (hora < 480 || hora >= 1260) throw new WhatsAppManualError('manual_horario', 'Abra as mensagens entre 8h e 21h no horário desta unidade.');
}

/** A reserva não vence sozinha: uma conversa já aberta pode continuar na outra aba. */
export async function abrirWhatsAppManual(p: AtorManual & { id: string; agora: Date }) {
  return withTenant(p.tenantId, async tx => {
    const l = await obter(tx, p, p.id);
    if (l.status !== 'pendente' && l.status !== 'em_atendimento') throw new WhatsAppManualError('manual_finalizado', 'Esta mensagem já foi finalizada.');
    if (l.claimed_by && l.claimed_by !== p.staffId) throw new WhatsAppManualError('manual_ocupado', 'Outro operador está cuidando desta mensagem. Aguarde ou peça que libere o item.');
    await elegivel(tx, l, p.agora);
    let conteudo: ConteudoManual;
    if (l.payload_cipher) {
      conteudo = JSON.parse(decifrarBaileys(l.payload_cipher, escopoCifra(p, p.id))) as ConteudoManual;
      if (conteudo.telefone !== l.phone_e164) throw new WhatsAppManualError('manual_telefone_alterado', 'O telefone do cliente mudou. Feche a conversa antiga e libere o item antes de preparar novamente.');
    }
    else {
      const reserva = await reservarDisparoPromocional(tx, { tenantId: p.tenantId, customerId: l.customer_id,
        intentKey: intentKey(l), tipo: l.kind, agora: p.agora, timeZone: l.timezone });
      if (!reserva.nossa) throw new WhatsAppManualError(`manual_${reserva.motivo}`, 'O cliente já tem uma mensagem promocional reservada ou atingiu o limite de envios. Tente em outro dia.');
      const variaveis = [l.name, l.barbearia];
      const texto = l.template_body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => {
        const v = variaveis[Number(n) - 1];
        if (!v) throw new WhatsAppManualError('manual_variavel', 'Confira as variáveis da mensagem.', 400);
        return v;
      });
      conteudo = { telefone: l.phone_e164!, texto: `${texto}\n\nSe não quiser mais receber promoções, responda PARAR.` };
      linkWhatsAppManual(conteudo);
      await tx.$executeRaw`UPDATE notification_send_intents SET manual_pending = true WHERE intent_key = ${intentKey(l)}`;
      await tx.$executeRaw`UPDATE whatsapp_manual_queue SET status = 'em_atendimento', claimed_by = ${p.staffId}::uuid,
        claimed_at = ${p.agora}, payload_cipher = ${cifrarBaileys(JSON.stringify(conteudo), escopoCifra(p, p.id))}
        WHERE id = ${p.id}::uuid`;
      await audit(tx, { actorId: p.staffId, actorName: p.staffName, action: 'whatsapp.manual_opened', entity: 'whatsapp_manual_queue', entityId: p.id });
    }
    // Não devolve token e não presume que abrir o link resultou em envio.
    return { url: linkWhatsAppManual(conteudo), texto: conteudo.texto, telefone: conteudo.telefone };
  });
}

export async function concluirWhatsAppManual(p: AtorManual & { id: string; agora: Date; acao: 'enviado' | 'liberar' | 'descartar' | 'optout' | 'assumir' }) {
  return withTenant(p.tenantId, async tx => {
    const l = await obter(tx, p, p.id);
    if (l.status === 'enviado' && p.acao === 'enviado') return { ok: true as const };
    if (l.status === 'descartado' && p.acao === 'descartar') return { ok: true as const };
    if (l.status === 'enviado' || l.status === 'descartado') throw new WhatsAppManualError('manual_finalizado', 'Esta mensagem já foi finalizada.');
    if (p.acao === 'assumir') {
      if (!p.podeAssumir || l.status !== 'em_atendimento') throw new WhatsAppManualError('manual_assumir_negado', 'Somente quem gerencia o WhatsApp pode assumir um atendimento em andamento.', 403);
      await tx.$executeRaw`UPDATE whatsapp_manual_queue SET claimed_by = ${p.staffId}::uuid WHERE id = ${p.id}::uuid`;
      await audit(tx, { actorId: p.staffId, actorName: p.staffName, action: 'whatsapp.manual_assumir', entity: 'whatsapp_manual_queue', entityId: p.id, before: { operadorId: l.claimed_by } });
      return { ok: true as const };
    }
    if (l.claimed_by && l.claimed_by !== p.staffId) throw new WhatsAppManualError('manual_ocupado', 'Somente o operador que abriu pode concluir ou liberar esta mensagem.');
    if (p.acao === 'enviado') {
      if (l.status !== 'em_atendimento') throw new WhatsAppManualError('manual_nao_aberto', 'Abra a conversa e envie a mensagem antes de confirmar.');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`barberdock:promo:${p.tenantId}:${l.customer_id}`}, 0))`;
      // A confirmação pode ocorrer no dia seguinte à abertura: a cota acompanha o envio declarado.
      await tx.$executeRaw`UPDATE notification_send_intents SET quota_at = ${p.agora}, manual_pending = false,
        quota_date = ${instantToLocal(l.timezone, p.agora).date}::date WHERE intent_key = ${intentKey(l)}`;
      const confirmou = await confirmarDisparoPromocional(tx, { intentKey: intentKey(l), tipo: l.kind, customerId: l.customer_id,
        phoneMasked: null, enviadoEm: p.agora });
      if (!confirmou) throw new WhatsAppManualError('manual_reserva', 'Não foi possível confirmar a reserva desta mensagem.');
      await tx.$executeRaw`UPDATE whatsapp_manual_queue SET status = 'enviado', sent_at = ${p.agora}, sent_by = ${p.staffId}::uuid,
        payload_cipher = NULL WHERE id = ${p.id}::uuid`;
      if (l.campaign_target_id) await tx.$executeRaw`UPDATE campaign_targets SET sent_at = ${p.agora} WHERE id = ${l.campaign_target_id}::uuid`;
      if (l.automation_send_id) await tx.$executeRaw`UPDATE automation_sends SET sent_at = ${p.agora} WHERE id = ${l.automation_send_id}::uuid`;
    } else {
      await liberarDisparoPromocional(tx, intentKey(l));
      if (p.acao === 'liberar') {
        await tx.$executeRaw`UPDATE whatsapp_manual_queue SET status = 'pendente', claimed_at = NULL, claimed_by = NULL,
          payload_cipher = NULL WHERE id = ${p.id}::uuid`;
      } else {
        if (p.acao === 'optout') {
          await tx.$executeRaw`INSERT INTO customer_consents (tenant_id, customer_id, purpose, granted, text_version, decided_at)
            VALUES (${p.tenantId}::uuid, ${l.customer_id}::uuid, 'marketing', false, 'whatsapp-manual-parar-v1', ${p.agora})`;
        }
        const motivo = p.acao === 'optout' ? 'optou_por_nao_receber' : 'descartado_pelo_operador';
        await tx.$executeRaw`UPDATE whatsapp_manual_queue SET status = 'descartado', discarded_at = ${p.agora},
          discarded_by = ${p.staffId}::uuid, reason = ${motivo}, payload_cipher = NULL WHERE id = ${p.id}::uuid`;
        if (l.campaign_target_id) await tx.$executeRaw`UPDATE campaign_targets SET skipped_reason = ${motivo} WHERE id = ${l.campaign_target_id}::uuid`;
        if (l.automation_send_id) await tx.$executeRaw`UPDATE automation_sends SET skipped_reason = ${motivo} WHERE id = ${l.automation_send_id}::uuid`;
      }
    }
    if (l.campaign_target_id) await tx.$executeRaw`UPDATE campaigns c SET status = 'enviada'
      WHERE c.id = (SELECT campaign_id FROM campaign_targets WHERE id = ${l.campaign_target_id}::uuid)
        AND NOT EXISTS (SELECT 1 FROM campaign_targets t WHERE t.campaign_id = c.id AND t.sent_at IS NULL AND t.skipped_reason IS NULL)`;
    await audit(tx, { actorId: p.staffId, actorName: p.staffName, action: `whatsapp.manual_${p.acao}`,
      entity: 'whatsapp_manual_queue', entityId: p.id, after: { confirmacao: p.acao === 'enviado' ? 'operador' : null } });
    return { ok: true as const };
  });
}
