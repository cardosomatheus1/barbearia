import { sql, type TransactionClient } from '@barbearia/db';
import { WhatsAppManualError } from './fila.js';
export interface CriacaoManual { chave: string; hash: string }
/** A trava cobre consulta, criação e público, dentro da mesma transação. */
export async function criacaoManualExistente(tx: TransactionClient, p: {
  tenantId: string; staffId: string; criacaoManual?: CriacaoManual;
}, origem: 'campanha' | 'automacao'): Promise<string | null> {
  if (!p.criacaoManual) return null;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`manual:${origem}:${p.tenantId}:${p.staffId}:${p.criacaoManual.chave}`}, 0))`;
  const tabela = origem === 'campanha' ? sql`campaigns` : sql`automations`;
  const [existente] = await tx.$queryRaw<{ id: string; manual_request_hash: string }[]>(sql`SELECT id, manual_request_hash FROM ${tabela}
    WHERE created_by = ${p.staffId}::uuid AND manual_request_key = ${p.criacaoManual.chave}::uuid`);
  if (!existente) return null;
  if (existente.manual_request_hash !== p.criacaoManual.hash) throw new WhatsAppManualError('manual_criacao_divergente', 'Este pedido já foi usado com outros dados. Atualize a página antes de criar novamente.');
  return existente.id;
}
