import type { TransactionClient } from '@barbearia/db';
import type { TipoDeNotificacao } from '@barbearia/core';

/** O ACK tardio acrescenta o desfecho ao histórico imutável, com uma única cota enviada. */
export async function registrarDesfechoDaNotificacao(tx: TransactionClient, p: {
  intentKey: string; tipo: TipoDeNotificacao; customerId: string | null;
  appointmentId?: string | null; phoneMasked: string | null;
  estado: 'sent' | 'uncertain'; wamid?: string | null; agora: Date;
}): Promise<boolean> {
  const [i] = await tx.$queryRaw<{ status: string; notification_id: string | null; wamid: string | null }[]>`
    SELECT status, notification_id, wamid FROM notification_send_intents WHERE intent_key = ${p.intentKey} FOR UPDATE`;
  if (!i) return false;
  if (i.status === 'sent' && i.notification_id) return true;
  const status = p.estado === 'sent' ? 'sent' : 'failed';
  const motivo = p.estado === 'sent' ? null : 'entrega_incerta';
  if (i.notification_id && p.estado === 'uncertain') return true;
  const [n] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO notifications
    (tenant_id, kind, customer_id, appointment_id, status, reason, phone_masked, sent_at, previous_notification_id)
    VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid, ${p.tipo}::notification_kind,
      ${p.customerId}::uuid, ${p.appointmentId ?? null}::uuid, ${status}::notification_status,
      ${motivo}, ${p.phoneMasked}, ${p.agora}, ${i.notification_id}::uuid) RETURNING id`;
  if (!n) throw new Error('notificacao_nao_registrada');
  const id = n.id;
  const wamid = p.wamid ?? i.wamid;
  await tx.$executeRaw`UPDATE notification_send_intents SET notification_id = ${id}::uuid,
    status = ${p.estado}, wamid = ${wamid}, updated_at = ${p.agora} WHERE intent_key = ${p.intentKey}`;
  if (wamid) await tx.$executeRaw`UPDATE whatsapp_messages SET notification_id = ${id}::uuid WHERE wamid = ${wamid}`;
  return true;
}
