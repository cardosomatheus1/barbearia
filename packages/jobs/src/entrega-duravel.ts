import { withTenant } from '@barbearia/db';
import { maskPhone, WhatsAppDeliveryUnknownError, type TipoDeNotificacao } from '@barbearia/core';
import { registrarDesfechoDaNotificacao } from './notificacao-desfecho.js';

/** Reserva antes da rede; falha conhecida permite retry, dúvida exige conciliação. */
export async function executarEntregaDuravel(p: {
  tenantId: string; intentKey: string; customerId: string | null; tipo: TipoDeNotificacao;
  telefone: string; agora: Date; enviar: () => Promise<void>;
}): Promise<boolean> {
  const reserva = await withTenant(p.tenantId, async tx => {
    const [nova] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO notification_send_intents
      (tenant_id,intent_key,status) VALUES (${p.tenantId}::uuid,${p.intentKey},'sending')
      ON CONFLICT (tenant_id,intent_key) DO NOTHING RETURNING id`;
    if (nova) return 'nossa';
    const [anterior] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM notification_send_intents WHERE intent_key=${p.intentKey}`;
    return anterior?.status === 'sent' ? 'sent' : 'uncertain';
  });
  if (reserva !== 'nossa') return reserva === 'sent';
  try { await p.enviar(); }
  catch (erro) {
    if (erro instanceof WhatsAppDeliveryUnknownError) {
      await withTenant(p.tenantId, tx => registrarDesfechoDaNotificacao(tx, {
        ...p, estado: 'uncertain', phoneMasked: maskPhone(p.telefone),
      }));
      return false;
    }
    await withTenant(p.tenantId, tx => tx.$executeRaw`DELETE FROM notification_send_intents
      WHERE intent_key=${p.intentKey} AND status='sending'`);
    throw erro;
  }
  return withTenant(p.tenantId, tx => registrarDesfechoDaNotificacao(tx, {
    ...p, estado: 'sent', phoneMasked: maskPhone(p.telefone),
  }));
}
