import { withTenant } from '@barbearia/db';
import { maskPhone } from '@barbearia/core';
import { registrarDesfechoDaNotificacao } from '@barbearia/jobs';
import { conteudoDoEnvio, referenciaBaileys, type EnvioBaileys } from './outbox.js';

/** Recupera o resultado após timeout/crash do chamador, sem transmitir novamente. */
export async function conciliarEnviosBaileys(tenantId: string, agora = new Date()): Promise<number> {
  return withTenant(tenantId, async tx => {
    const linhas = await tx.$queryRaw<(EnvioBaileys & { accepted_at: Date })[]>`
      SELECT o.* FROM whatsapp_baileys_outbox o
      JOIN notification_send_intents i ON i.intent_key = o.intent_key
        AND i.wamid = 'baileys:' || o.location_id::text || ':' || o.message_id
      WHERE o.payload_cipher IS NOT NULL AND o.status IN ('sent','delivered','read')
        AND (i.status <> 'sent' OR i.notification_id IS NULL)
        AND i.updated_at < ${agora}::timestamptz - interval '30 seconds'
      ORDER BY o.created_at LIMIT 100 FOR UPDATE OF i SKIP LOCKED`;
    let conciliados = 0;
    for (const r of linhas) {
      const c = conteudoDoEnvio({ tenantId, locationId: r.location_id }, r);
      if (!c.tipo) continue;
      const wamid = referenciaBaileys(r.location_id, r.message_id);
      const confirmou = await registrarDesfechoDaNotificacao(tx, {
        intentKey: r.intent_key, tipo: c.tipo, customerId: c.customerId, appointmentId: c.appointmentId,
        phoneMasked: maskPhone(c.telefone), estado: 'sent', wamid, agora: r.accepted_at,
      });
      if (!confirmou) continue;
      if (r.intent_key.startsWith('promo:campanha:')) {
        await tx.$executeRaw`UPDATE campaign_targets SET sent_at = COALESCE(sent_at, ${r.accepted_at}),
          wamid = ${wamid}, skipped_reason = NULL WHERE id = ${r.intent_key.slice('promo:campanha:'.length)}::uuid
            AND (wamid IS NULL OR wamid = ${wamid})`;
      } else if (r.intent_key.startsWith('promo:automacao:')) {
        await tx.$executeRaw`UPDATE automation_sends SET sent_at = COALESCE(sent_at, ${r.accepted_at}), skipped_reason = NULL
          WHERE id = ${r.intent_key.slice('promo:automacao:'.length)}::uuid`;
      } else if (r.intent_key.startsWith('promo:manual:')) {
        await tx.$executeRaw`UPDATE whatsapp_manual_send_intents SET status = 'enviado', wamid = ${wamid}, updated_at = ${agora}
          WHERE id = ${r.intent_key.slice('promo:manual:'.length)}::uuid AND (wamid IS NULL OR wamid = ${wamid})`;
      }
      conciliados += 1;
    }
    return conciliados;
  });
}
