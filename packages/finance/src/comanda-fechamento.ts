import type { Pagamento } from '@barbearia/core';
import type { TransactionClient } from '@barbearia/db';
import { ComandaError } from './comanda-tipos.js';

/**
 * A mesma Idempotency-Key só pode representar a mesma intenção de fechamento.
 * Ordenar as parcelas evita que cash+pix e pix+cash gerem fingerprints distintos.
 */
export function fingerprintDoFechamento(params: {
  readonly orderId: string;
  readonly pagamentos: readonly Pagamento[];
  readonly resgateQuantidade?: number;
  readonly servicoDoPacote?: string;
  readonly servicoDaAssinatura?: string;
}): string {
  return JSON.stringify({
    orderId: params.orderId,
    pagamentos: [...params.pagamentos]
      .map((p) => [p.forma, p.valorCents] as const)
      .sort(([formaA, valorA], [formaB, valorB]) =>
        formaA === formaB ? valorA - valorB : formaA.localeCompare(formaB),
      ),
    resgateQuantidade: params.resgateQuantidade ?? null,
    servicoDoPacote: params.servicoDoPacote ?? null,
    servicoDaAssinatura: params.servicoDaAssinatura ?? null,
  });
}

export function recusarDescontoEmVendaDePacote(descontoCents: number): void {
  if (descontoCents <= 0) return;
  throw new ComandaError(
    'desconto_invalido',
    'Venda de pacote não recebe desconto geral da comanda; ajuste o preço no catálogo.',
    'pacote_com_desconto',
  );
}

/**
 * Pacote é ativo pré-pago. Seu preço congelado sustenta o reembolso futuro;
 * reduzir somente o total da comanda permitiria devolver mais do que entrou.
 */
export async function exigirPacoteSemDescontoGeral(
  tx: TransactionClient,
  orderId: string,
  descontoCents: number,
): Promise<void> {
  if (descontoCents <= 0) return;
  const pacote = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM order_items
     WHERE order_id = ${orderId}::uuid AND package_id IS NOT NULL
     LIMIT 1
  `;
  if (pacote[0]) recusarDescontoEmVendaDePacote(descontoCents);
}
