import type { TransactionClient } from '@barbearia/db';
import { decifrarBaileys } from '../baileys/cofre.js';
/** Exporta o fato declarado pelo operador, sem confundi-lo com entrega/leitura. */
export async function dadosManuaisDoTitular(tx: TransactionClient, tenantId: string, customerId: string): Promise<readonly Record<string, unknown>[]> {
  const itens = await tx.$queryRaw<{ id: string; location_id: string; status: string; created_at: Date; claimed_at: Date | null;
    sent_at: Date | null; discarded_at: Date | null; reason: string | null; template_body: string; payload_cipher: string | null }[]>`
    SELECT id, location_id, status, created_at, claimed_at, sent_at, discarded_at, reason, template_body, payload_cipher
    FROM whatsapp_manual_queue WHERE customer_id = ${customerId}::uuid ORDER BY created_at, id`;
  return itens.map(i => ({ preparada_em: i.created_at, aberta_em: i.claimed_at, envio_confirmado_em: i.sent_at,
    descartada_em: i.discarded_at, estado: i.status, motivo: i.reason, confirmacao: 'operador', mensagem_base: i.template_body,
    conteudo_pendente: i.payload_cipher ? JSON.parse(decifrarBaileys(i.payload_cipher, `manual:${tenantId}:${i.location_id}:${i.id}`)) as unknown : null }));
}
