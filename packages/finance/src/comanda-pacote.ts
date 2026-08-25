import type { TransactionClient } from '@barbearia/db';
import { ComandaError } from './comanda-tipos.js';

/**
 * Fotografia do catálogo no instante em que o pacote entra na comanda.
 *
 * O catálogo pode mudar enquanto o atendimento continua aberto. O item precisa
 * guardar o contrato aceito naquele instante; o fechamento não tem permissão
 * para reinterpretá-lo com os termos atuais.
 */
export type SnapshotDePacote = {
  readonly serviceId: string;
  readonly quantity: number;
  readonly priceCents: number;
  readonly validityDays: number | null;
  readonly transferable: boolean;
};

export async function snapshotDePacoteAtivo(
  tx: TransactionClient,
  packageId: string,
): Promise<SnapshotDePacote> {
  const pacote = await tx.$queryRaw<{
    service_id: string;
    quantity: number;
    price_cents: number;
    validity_days: number | null;
    transferable: boolean;
  }[]>`
    SELECT service_id, quantity, price_cents, validity_days, transferable
      FROM packages
     WHERE id = ${packageId}::uuid AND active
  `;
  const encontrado = pacote[0];
  if (!encontrado) {
    throw new ComandaError('servico_desconhecido', 'Pacote não encontrado.');
  }
  return {
    serviceId: encontrado.service_id,
    quantity: encontrado.quantity,
    priceCents: encontrado.price_cents,
    validityDays: encontrado.validity_days,
    transferable: encontrado.transferable,
  };
}

export type ItemDePacoteCongelado = {
  readonly package_id: string;
  /** Quantas compras iguais deste pacote existem na linha da comanda. */
  readonly quantity: number;
  /** Preço de uma compra do pacote, congelado em order_items. */
  readonly unit_price_cents: number;
  readonly package_snapshot_service_id: string;
  readonly package_snapshot_quantity: number;
  readonly package_snapshot_validity_days: number | null;
  readonly package_snapshot_transferable: boolean;
};

export async function itensDePacoteDaComanda(
  tx: TransactionClient,
  orderId: string,
): Promise<readonly ItemDePacoteCongelado[]> {
  return tx.$queryRaw<ItemDePacoteCongelado[]>`
    SELECT package_id, quantity, unit_price_cents,
           package_snapshot_service_id, package_snapshot_quantity,
           package_snapshot_validity_days, package_snapshot_transferable
      FROM order_items
     WHERE order_id = ${orderId}::uuid AND package_id IS NOT NULL
     ORDER BY position
  `;
}
