import { randomBytes, randomUUID } from 'node:crypto';
import { withTenant } from '@barbearia/db';
import { WhatsAppDeliveryUnknownError, type TipoDeNotificacao } from '@barbearia/core';
import { cifrarBaileys, decifrarBaileys, hashBaileys } from './cofre.js';
import { BaileysError, comPosse, canalDaUnidade, type EscopoBaileys, type PosseBaileys } from './sessao.js';
import { estadoDoAck, type EstadoEnvioBaileys } from './semantica.js';

export interface ConteudoBaileys {
  tipo?: TipoDeNotificacao; telefone: string; texto: string; customerId: string | null; templateId: string | null; appointmentId: string | null;
}
export interface EnvioBaileys {
  id: string; attempt: number; location_id: string; generation: string; intent_key: string; message_id: string;
  payload_cipher: string | null; payload_hash: string; recipient_hash: string | null;
  status: EstadoEnvioBaileys; last_error: string | null; expires_at: Date;
}
export function referenciaBaileys(locationId: string, messageId: string): string { return `baileys:${locationId}:${messageId}`; }
function escopoDoEnvio(p: EscopoBaileys, id: string): string { return `${p.tenantId}:${p.locationId}:outbox:${id}`; }
export function conteudoDoEnvio(p: EscopoBaileys, r: EnvioBaileys): ConteudoBaileys {
  if (!r.payload_cipher) throw new BaileysError('baileys_conteudo_expirado', 'O conteúdo desta mensagem já foi removido pela retenção.');
  return JSON.parse(decifrarBaileys(r.payload_cipher, escopoDoEnvio(p, r.id))) as ConteudoBaileys;
}

/** Reserva cifrada antes da rede. A mesma intenção nunca muda conteúdo nem sessão. */
export async function prepararEnvioBaileys(p: EscopoBaileys & { intentKey: string; conteudo: ConteudoBaileys }): Promise<EnvioBaileys> {
  const c = p.conteudo;
  if (!/^\+[1-9][0-9]{7,14}$/.test(c.telefone) || !c.texto.trim() || c.texto.length > 4096 ||
    !p.intentKey || p.intentKey.length > 200) throw new BaileysError('baileys_mensagem_invalida', 'Confira destinatário e mensagem.', 400);
  const corpo = JSON.stringify({ telefone: c.telefone, texto: c.texto, customerId: c.customerId,
    templateId: c.templateId, appointmentId: c.appointmentId, ...(c.tipo ? { tipo: c.tipo } : {}) });
  const hash = hashBaileys(corpo);
  return withTenant(p.tenantId, async tx => {
    await tx.$queryRaw`SELECT id FROM locations WHERE id = ${p.locationId}::uuid FOR UPDATE`;
    const [existe] = await tx.$queryRaw<EnvioBaileys[]>`SELECT * FROM whatsapp_baileys_outbox
      WHERE location_id = ${p.locationId}::uuid AND intent_key = ${p.intentKey} ORDER BY attempt DESC LIMIT 1`;
    if (existe && existe.status !== 'failed') {
      if (existe.payload_hash !== hash) throw new BaileysError('baileys_intencao_divergente', 'Esta tentativa já pertence a outra mensagem.');
      return existe;
    }
    if (await canalDaUnidade(p, tx) !== 'baileys') throw new BaileysError('canal_divergente', 'O canal da unidade foi alterado. Confira a mensagem.');
    const [s] = await tx.$queryRaw<{ generation: string }[]>`SELECT generation FROM whatsapp_baileys_sessions
      WHERE location_id = ${p.locationId}::uuid AND desired AND status = 'conectado' AND lease_until > now() FOR UPDATE`;
    if (!s) throw new BaileysError('baileys_desconectado', 'Conecte o WhatsApp da unidade antes de enviar.');
    if (c.customerId) {
      const [cliente] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM customers WHERE id = ${c.customerId}::uuid AND phone_e164 = ${c.telefone}`;
      if (!cliente) throw new BaileysError('baileys_cliente_divergente', 'O destinatário precisa ser conferido.', 400);
    }
    if (c.templateId) {
      const [template] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM whatsapp_templates
        WHERE id = ${c.templateId}::uuid AND location_id = ${p.locationId}::uuid AND transport = 'baileys' AND local_enabled`;
      if (!template) throw new BaileysError('baileys_texto_indisponivel', 'Escolha um texto disponível para esta conexão.');
    }
    if (c.appointmentId) {
      const [a] = await tx.$queryRaw<{ id: string }[]>`SELECT a.id FROM appointments a JOIN customers c ON c.id = a.customer_id
        WHERE a.id = ${c.appointmentId}::uuid AND a.location_id = ${p.locationId}::uuid AND c.phone_e164 = ${c.telefone}`;
      if (!a) throw new BaileysError('baileys_agendamento_divergente', 'O horário não pertence ao destinatário.', 400);
    }
    const attempt = (existe?.attempt ?? 0) + 1;
    const id = randomUUID(); const cipher = cifrarBaileys(corpo, escopoDoEnvio(p, id));
    const messageId = `BD${randomBytes(18).toString('hex').toUpperCase()}`;
    await tx.$executeRaw`INSERT INTO whatsapp_baileys_outbox
      (id, tenant_id, location_id, generation, intent_key, attempt, message_id, customer_id, payload_cipher, payload_hash)
      VALUES (${id}::uuid, ${p.tenantId}::uuid, ${p.locationId}::uuid, ${s.generation}::uuid,
        ${p.intentKey}, ${attempt}, ${messageId}, ${c.customerId}::uuid, ${cipher}, ${hash}) ON CONFLICT (location_id, intent_key, attempt) DO NOTHING`;
    const [r] = await tx.$queryRaw<EnvioBaileys[]>`SELECT * FROM whatsapp_baileys_outbox
      WHERE location_id = ${p.locationId}::uuid AND intent_key = ${p.intentKey} AND attempt = ${attempt}`;
    if (!r || r.payload_hash !== hash) throw new BaileysError('baileys_intencao_divergente', 'Esta tentativa já pertence a outra mensagem.');
    const referencia = referenciaBaileys(p.locationId, r.message_id);
    await tx.$executeRaw`UPDATE notification_send_intents SET wamid = ${referencia}
      WHERE intent_key = ${p.intentKey} AND status IN ('sending','uncertain')`;
    if (p.intentKey.startsWith('promo:manual:')) await tx.$executeRaw`UPDATE whatsapp_manual_send_intents
      SET wamid = ${referencia} WHERE id = ${p.intentKey.slice('promo:manual:'.length)}::uuid AND status = 'enviando'`;
    return r;
  });
}

export async function proximoEnvioBaileys(p: PosseBaileys): Promise<EnvioBaileys | null> {
  return comPosse(p, async tx => {
    await tx.$executeRaw`UPDATE whatsapp_baileys_outbox SET status = 'failed', last_error = 'prazo_expirado', updated_at = now()
      WHERE location_id = ${p.locationId}::uuid AND status = 'queued' AND (expires_at <= now() OR generation <> ${p.generation}::uuid)`;
    const [s] = await tx.$queryRaw<{ location_id: string }[]>`SELECT location_id FROM whatsapp_baileys_sessions
      WHERE location_id = ${p.locationId}::uuid AND status = 'conectado' AND (next_send_at IS NULL OR next_send_at <= now())`;
    if (!s) return null;
    const [r] = await tx.$queryRaw<EnvioBaileys[]>`SELECT * FROM whatsapp_baileys_outbox
      WHERE location_id = ${p.locationId}::uuid AND generation = ${p.generation}::uuid AND status = 'queued'
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!r) return null;
    await tx.$executeRaw`UPDATE whatsapp_baileys_outbox SET status = 'sending', started_at = now(), updated_at = now() WHERE id = ${r.id}::uuid`;
    await tx.$executeRaw`UPDATE whatsapp_baileys_sessions SET next_send_at = now() + interval '2 seconds' WHERE location_id = ${p.locationId}::uuid`;
    return { ...r, status: 'sending' };
  });
}

export async function destinoDoEnvio(p: PosseBaileys, id: string, jid: string): Promise<void> {
  const hash = hashBaileys(jid);
  await comPosse(p, tx => tx.$executeRaw`UPDATE whatsapp_baileys_outbox SET recipient_hash = ${hash}
    WHERE id = ${id}::uuid AND location_id = ${p.locationId}::uuid AND generation = ${p.generation}::uuid AND status = 'sending'`);
}
export async function falhaDoEnvio(p: PosseBaileys, id: string, incerta: boolean, codigo: string): Promise<void> {
  await comPosse(p, tx => tx.$executeRaw`UPDATE whatsapp_baileys_outbox SET status = ${incerta ? 'uncertain' : 'failed'},
    last_error = ${codigo}, updated_at = now() WHERE id = ${id}::uuid AND location_id = ${p.locationId}::uuid
      AND generation = ${p.generation}::uuid AND status IN ('sending', 'uncertain')`);
}

/** Recibo do socket autenticado, vinculado à sessão, mensagem e destinatário. */
export async function aplicarReciboBaileys(p: PosseBaileys, messageId: string, jid: string, status: unknown): Promise<boolean> {
  const estado = estadoDoAck(status); if (!estado) return false;
  const hash = hashBaileys(jid); const ordem = { sent: 1, delivered: 2, read: 3, failed: 0 }[estado];
  return comPosse(p, async tx => {
    const [r] = await tx.$queryRaw<EnvioBaileys[]>`UPDATE whatsapp_baileys_outbox SET status = ${estado},
      accepted_at = CASE WHEN ${estado} <> 'failed' THEN COALESCE(accepted_at, now()) ELSE accepted_at END,
      delivered_at = CASE WHEN ${estado} IN ('delivered','read') THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
      read_at = CASE WHEN ${estado} = 'read' THEN COALESCE(read_at, now()) ELSE read_at END,
      last_error = CASE WHEN ${estado} = 'failed' THEN 'mensagem_recusada' ELSE NULL END, updated_at = now()
      WHERE location_id = ${p.locationId}::uuid AND generation = ${p.generation}::uuid
        AND payload_cipher IS NOT NULL AND message_id = ${messageId} AND recipient_hash = ${hash}
        AND ((status IN ('sending','uncertain')) OR
          (${estado} <> 'failed' AND ${ordem} > CASE status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 10 END))
      RETURNING *`;
    if (!r) return false;
    const c = conteudoDoEnvio(p, r); const wamid = referenciaBaileys(p.locationId, r.message_id);
    await tx.$executeRaw`INSERT INTO whatsapp_messages (tenant_id, wamid, customer_id, template_id, status, failure_reason, delivered_at, read_at)
      VALUES (${p.tenantId}::uuid, ${wamid}, ${c.customerId}::uuid, ${c.templateId}::uuid,
        ${estado === 'sent' ? 'enviada' : estado === 'delivered' ? 'entregue' : estado === 'read' ? 'lida' : 'falhou'}::whatsapp_message_status,
        ${estado === 'failed' ? 'Mensagem recusada pelo WhatsApp' : null}, ${estado === 'delivered' || estado === 'read' ? new Date() : null},
        ${estado === 'read' ? new Date() : null})
      ON CONFLICT (wamid) DO UPDATE SET status = EXCLUDED.status, failure_reason = EXCLUDED.failure_reason,
        delivered_at = COALESCE(whatsapp_messages.delivered_at, EXCLUDED.delivered_at), read_at = COALESCE(whatsapp_messages.read_at, EXCLUDED.read_at)`;
    return true;
  });
}

export async function textoParaRetryBaileys(p: PosseBaileys, messageId: string, jid: string): Promise<string | null> {
  return comPosse(p, async tx => {
    const [r] = await tx.$queryRaw<EnvioBaileys[]>`SELECT * FROM whatsapp_baileys_outbox
      WHERE location_id = ${p.locationId}::uuid AND generation = ${p.generation}::uuid AND payload_cipher IS NOT NULL AND message_id = ${messageId} AND recipient_hash = ${hashBaileys(jid)}
        AND status IN ('sending','uncertain','sent','delivered') AND created_at > now() - interval '1 day'`;
    return r ? conteudoDoEnvio(p, r).texto : null;
  });
}

export class EntregaBaileysIncerta extends WhatsAppDeliveryUnknownError {
  constructor(readonly referencia: string) { super('O WhatsApp ainda não confirmou esta mensagem. O sistema continuará acompanhando.'); }
}

/** API e worker compartilham a outbox; apenas o dono do socket transmite. */
export async function aguardarEnvioBaileys(p: EscopoBaileys, id: string, prazoMs = 20_000): Promise<{ wamid: string }> {
  const inicio = Date.now();
  let ultimo: EnvioBaileys | null = null;
  do {
    const [r] = await withTenant(p.tenantId, tx => tx.$queryRaw<EnvioBaileys[]>`
      SELECT * FROM whatsapp_baileys_outbox WHERE id = ${id}::uuid AND location_id = ${p.locationId}::uuid`);
    if (!r) throw new BaileysError('baileys_envio_ausente', 'Esta mensagem não está disponível.', 404);
    ultimo = r;
    if (['sent','delivered','read'].includes(r.status)) return { wamid: referenciaBaileys(p.locationId, r.message_id) };
    if (r.status === 'failed') throw new BaileysError('baileys_envio_recusado', 'A mensagem não foi aceita pelo WhatsApp. Confira a conexão e o destinatário.');
    if (Date.now() - inicio >= prazoMs) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (true);
  if (!ultimo) throw new Error('baileys_envio_ausente');
  throw new EntregaBaileysIncerta(referenciaBaileys(p.locationId, ultimo.message_id));
}
