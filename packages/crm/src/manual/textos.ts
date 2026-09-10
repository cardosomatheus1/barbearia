import { randomUUID } from 'node:crypto';
import { withTenant } from '@barbearia/db';
import { audit } from '@barbearia/identity';
import { tipoDeCampanhaValido, type TipoDeNotificacao } from '@barbearia/core';
import { validarCorpoBaileys } from '../baileys/textos.js';
import { WhatsAppManualError, type AtorManual, type EscopoManual } from './fila.js';

export async function textosWhatsAppManual(p: EscopoManual) {
  return withTenant(p.tenantId, tx => tx.$queryRaw<{ id: string; titulo: string; corpo: string; habilitado: boolean }[]>`
    SELECT id, titulo, body AS corpo, local_enabled AS habilitado FROM whatsapp_templates
    WHERE location_id = ${p.locationId}::uuid AND transport = 'manual' ORDER BY created_at DESC, id DESC`);
}
export async function salvarTextoWhatsAppManual(p: AtorManual & { id?: string; titulo: string; corpo: string; habilitado: boolean }) {
  const tipo: TipoDeNotificacao = 'retorno';
  if (!p.titulo.trim() || p.titulo.length > 80 || !tipoDeCampanhaValido(tipo) || !validarCorpoBaileys(tipo, p.corpo)) {
    throw new WhatsAppManualError('manual_texto', 'Confira o nome e o texto. Use {{1}} para o cliente e {{2}} para a barbearia.', 400);
  }
  return withTenant(p.tenantId, async tx => {
    const [local] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM locations WHERE id = ${p.locationId}::uuid`;
    const [ator] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM staff_users WHERE id = ${p.staffId}::uuid AND active`;
    if (!local || !ator) throw new WhatsAppManualError('manual_ausente', 'Unidade indisponível.', 404);
    const id = p.id ?? randomUUID();
    if (p.id) {
      const n = await tx.$executeRaw`UPDATE whatsapp_templates SET titulo = ${p.titulo.trim()}, body = ${p.corpo.trim()},
        local_enabled = ${p.habilitado}, updated_at = now()
        WHERE id = ${id}::uuid AND location_id = ${p.locationId}::uuid AND transport = 'manual'`;
      if (!n) throw new WhatsAppManualError('manual_ausente', 'Mensagem indisponível nesta unidade.', 404);
    } else {
      await tx.$executeRaw`INSERT INTO whatsapp_templates (id, tenant_id, location_id, kind, name, titulo, body, transport, local_enabled)
        VALUES (${id}::uuid, ${p.tenantId}::uuid, ${p.locationId}::uuid, ${tipo}::notification_kind,
          ${`manual_${id.replaceAll('-', '')}`}, ${p.titulo.trim()}, ${p.corpo.trim()}, 'manual', ${p.habilitado})`;
    }
    await audit(tx, { actorId: p.staffId, actorName: p.staffName, action: 'whatsapp.manual_text_changed', entity: 'whatsapp_template', entityId: id });
    return { id };
  });
}

export async function configuracoesWhatsAppManual(p: EscopoManual) {
  return withTenant(p.tenantId, async tx => {
    const campanhas = await tx.$queryRaw<{ id: string; nome: string; mensagem: string; total: number; enviados: number; descartados: number }[]>`
      SELECT c.id, c.name AS nome, w.titulo AS mensagem, count(t.id)::int AS total,
        count(t.id) FILTER (WHERE t.sent_at IS NOT NULL)::int AS enviados,
        count(t.id) FILTER (WHERE t.skipped_reason IS NOT NULL)::int AS descartados
      FROM campaigns c JOIN whatsapp_templates w ON w.id = c.template_id
      LEFT JOIN campaign_targets t ON t.campaign_id = c.id
      WHERE w.transport = 'manual' AND w.location_id = ${p.locationId}::uuid
      GROUP BY c.id, w.titulo ORDER BY c.created_at DESC LIMIT 50`;
    const automacoes = await tx.$queryRaw<{ id: string; nome: string; mensagem: string; ativa: boolean; gatilho: string; limiar: number | null; enviados: number; alcancados: number }[]>`
      SELECT a.id, a.name AS nome, w.titulo AS mensagem, a.active AS ativa, a.trigger::text AS gatilho,
        a.threshold AS limiar, count(s.id) FILTER (WHERE s.sent_at IS NOT NULL)::int AS enviados,
        count(s.id) FILTER (WHERE s.goal_met_at IS NOT NULL)::int AS alcancados
      FROM automations a JOIN whatsapp_templates w ON w.id = a.template_id
      LEFT JOIN automation_sends s ON s.automation_id = a.id
      WHERE w.transport = 'manual' AND w.location_id = ${p.locationId}::uuid
      GROUP BY a.id, w.titulo ORDER BY a.created_at DESC LIMIT 50`;
    return { campanhas, automacoes };
  });
}
export async function ativarAutomacaoManual(p: AtorManual & { id: string; ativa: boolean }) {
  return withTenant(p.tenantId, async tx => {
    const n = await tx.$executeRaw`UPDATE automations a SET active = ${p.ativa}, updated_at = now()
      FROM whatsapp_templates w WHERE a.id = ${p.id}::uuid AND w.id = a.template_id
        AND w.transport = 'manual' AND w.location_id = ${p.locationId}::uuid`;
    if (!n) throw new WhatsAppManualError('manual_ausente', 'Automação indisponível nesta unidade.', 404);
    await audit(tx, { actorId: p.staffId, actorName: p.staffName, action: 'automation.changed', entity: 'automations', entityId: p.id, after: { ativa: p.ativa } });
    return { ok: true as const };
  });
}
