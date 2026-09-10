import { withTenant } from '@barbearia/db';

/** Sete dias para respostas correlacionadas; depois só a identidade do envio permanece. */
export async function expirarConteudoBaileys(tenantId: string, agora = new Date()): Promise<number> {
  return withTenant(tenantId, async tx => {
    await tx.$executeRaw`UPDATE whatsapp_baileys_sessions SET qr_cipher = NULL, qr_until = NULL
      WHERE qr_until <= ${agora}`;
    await tx.$executeRaw`UPDATE whatsapp_baileys_outbox SET status = 'failed', last_error = 'prazo_expirado', updated_at = ${agora}
      WHERE status = 'queued' AND expires_at <= ${agora}`;
    return tx.$executeRaw`UPDATE whatsapp_baileys_outbox SET payload_cipher = NULL, customer_id = NULL,
      recipient_hash = NULL, redacted_at = ${agora}, updated_at = ${agora},
      status = CASE WHEN status = 'sending' THEN 'uncertain' ELSE status END
      WHERE id IN (SELECT id FROM whatsapp_baileys_outbox WHERE payload_cipher IS NOT NULL
        AND created_at < ${agora}::timestamptz - interval '7 days' ORDER BY created_at LIMIT 500)`;
  });
}
