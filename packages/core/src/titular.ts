/**
 * O pedido do titular — vocabulário, e por que ele mora aqui.
 *
 * `PedidoDoTitular` em `crm` e `PedidoNaTela` em `apps/web` soletravam as duas
 * uniões, e a tela de LGPD montava os rótulos num `Record<string, string>`. O
 * `estado` era lido **sem rede** (`${ESTADO[pedido.estado]} em ${data(...)}`), e
 * `data_request_status` é enum do Postgres: um quarto valor renderizaria
 * literalmente `undefined em 12/03/2026` na linha do pedido de um titular.
 *
 * Mora em `core` e não em `crm` pelo mesmo motivo de `METODOS_DA_BAIXA`: a tela
 * precisa da lista, e `apps/web` depende só de `core`. `crm` reexporta.
 */

export const TIPOS_DE_PEDIDO_DO_TITULAR = ['export', 'deletion'] as const;
export type TipoDePedidoDoTitular = (typeof TIPOS_DE_PEDIDO_DO_TITULAR)[number];

export const ROTULO_DO_PEDIDO_DO_TITULAR: Readonly<Record<TipoDePedidoDoTitular, string>> = {
  export: 'Cópia dos dados',
  deletion: 'Exclusão dos dados',
};

export const ESTADOS_DO_PEDIDO_DO_TITULAR = ['open', 'done', 'refused'] as const;
export type EstadoDoPedidoDoTitular = (typeof ESTADOS_DO_PEDIDO_DO_TITULAR)[number];

export const ROTULO_DO_ESTADO_DO_PEDIDO: Readonly<Record<EstadoDoPedidoDoTitular, string>> = {
  open: 'Em aberto',
  done: 'Atendido',
  refused: 'Recusado',
};
