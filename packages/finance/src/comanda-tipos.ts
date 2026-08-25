import type { DescontoDaComanda, FormaDePagamento, ItemDaComanda } from '@barbearia/core';

export type ComandaFailure =
  | 'comanda_nao_encontrada'
  | 'comanda_fechada'
  | 'item_invalido'
  | 'desconto_invalido'
  | 'desconto_acima_do_teto'
  | 'pagamento_invalido'
  | 'caixa_fechado'
  | 'cliente_nao_encontrado'
  | 'cobranca_em_curso'
  | 'servico_desconhecido'
  | 'profissional_desconhecido'
  | 'idempotencia_conflitante';

export class ComandaError extends Error {
  constructor(
    readonly code: ComandaFailure,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ComandaError';
  }
}

/**
 * A comanda como **esta** conta pode vê-la.
 *
 * Redigir e não recusar. Somar `customers.view` ao `@Exige` das seis rotas que
 * devolvem uma comanda era o conserto óbvio e estava errado: `@Exige` é
 * conjuntivo, e um papel de balcão a quem o dono negasse a permissão para
 * proteger a base perdia o **PDV inteiro** — abrir comanda, lançar item,
 * fechar venda. Estado sem saída na interface (§6 pergunta 3) criado por uma
 * permissão que protege três campos de um objeto de trinta.
 *
 * Os três são os que o comentário da leitura nomeia: `customerName`,
 * `conta.saldoCents` e `conta.limiteCents`. O id vai junto — ele é a chave da
 * ficha, do extrato de fiado e do saldo de fidelidade, e redigir o nome
 * deixando o id passar entrega a mesma pessoa por outra coluna.
 *
 * `conta` inteira e não os dois números: sem saldo e sem teto ela não responde
 * mais nada, e um objeto com zeros diria "pode fiar à vontade" — o número
 * errado com cara de certo.
 *
 * Mora aqui e não no controller porque a varredura que cobra `customers.view`
 * lê o **fonte** e precisa enxergar a redação acontecendo: um método privado
 * do controller ela não alcança, e a saída seria uma isenção por nome de
 * arquivo — a lista que ninguém revisa.
 */
export function comandaVisivel(params: {
  readonly comanda: Comanda;
  readonly podeVerCliente: boolean;
}): Comanda {
  if (params.podeVerCliente) return params.comanda;
  return { ...params.comanda, customerId: null, customerName: null, conta: null };
}

export interface Comanda {
  readonly id: string;
  readonly status: 'open' | 'paid' | 'cancelled' | 'refunded';
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly appointmentId: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly itens: readonly (ItemDaComanda & { readonly professionalName: string | null })[];
  readonly desconto: DescontoDaComanda | null;
  readonly gorjetaCents: number;
  /** De quem é a gorjeta (SPEC §3.6). Nulo é rateada entre quem atendeu. */
  readonly gorjetaProfessionalId: string | null;
  readonly subtotalCents: number;
  readonly descontoCents: number;
  readonly totalCents: number;
  readonly trocoCents: number;
  readonly pagamentos: readonly { readonly forma: FormaDePagamento; readonly valorCents: number }[];
  /** Saldo e limite de quem vai pagar, para a tela saber se pode fiar. */
  readonly conta: { readonly saldoCents: number; readonly limiteCents: number } | null;
}
