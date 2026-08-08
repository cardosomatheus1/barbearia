/**
 * A comanda: o que o cliente consumiu e quanto ele paga.
 *
 * Aritmética pura, em **centavos inteiros**. Nenhum `float` entra aqui, e não é
 * preciosismo: `0.1 + 0.2` não é `0.3`, e um sistema que soma preço em ponto
 * flutuante fecha o caixa com um centavo de diferença que ninguém explica —
 * exatamente a divergência que a SPEC §3.10 manda registrar em vez de silenciar.
 *
 * A comanda é a fronteira entre agenda e dinheiro. Até aqui o produto sabia
 * quem vem e quando; a partir daqui sabe quanto entrou.
 */

/**
 * O que pode entrar numa comanda.
 *
 * `service` nasce do agendamento — a SPEC §3.1 é explícita: a comanda nasce
 * pré-preenchida e o barbeiro só acrescenta o extra. Os outros são o extra.
 */
export const TIPOS_DE_ITEM = ['service', 'product', 'consumable'] as const;
export type TipoDeItem = (typeof TIPOS_DE_ITEM)[number];

export interface ItemDaComanda {
  readonly id: string;
  readonly tipo: TipoDeItem;
  readonly descricao: string;
  readonly quantidade: number;
  readonly precoUnitarioCents: number;
  /**
   * Quem executou **este item**.
   *
   * A comissão é por item, não por comanda: corte com um barbeiro e barba com
   * outro é caso real (SPEC §3.1). Guardar só o dono da comanda tornaria o
   * fechamento do mês uma discussão.
   */
  readonly professionalId: string | null;
}

export type TipoDeDesconto = 'amount' | 'percent';

export interface DescontoDaComanda {
  readonly tipo: TipoDeDesconto;
  /** Centavos quando `amount`; pontos percentuais inteiros quando `percent`. */
  readonly valor: number;
  readonly motivo?: string | null;
}

export interface TotaisDaComanda {
  readonly subtotalCents: number;
  readonly descontoCents: number;
  readonly gorjetaCents: number;
  readonly totalCents: number;
}

/**
 * Soma a comanda.
 *
 * Ordem que importa: **desconto sobre o subtotal, gorjeta por fora**. Aplicar
 * percentual de gorjeta sobre um total já descontado faz o barbeiro receber
 * menos porque a casa deu desconto — e a gorjeta não é da casa.
 *
 * O desconto nunca ultrapassa o subtotal. Sem esse teto, "R$ 100 de desconto"
 * numa comanda de R$ 70 viraria total negativo, e total negativo vira crédito
 * que ninguém autorizou.
 */
export function somarComanda(params: {
  readonly itens: readonly ItemDaComanda[];
  readonly desconto?: DescontoDaComanda | null;
  readonly gorjetaCents?: number;
}): TotaisDaComanda {
  const subtotalCents = params.itens.reduce(
    (soma, item) => soma + item.precoUnitarioCents * item.quantidade,
    0,
  );

  const bruto = params.desconto ? valorDoDesconto(params.desconto, subtotalCents) : 0;
  const descontoCents = Math.min(Math.max(0, bruto), subtotalCents);
  const gorjetaCents = Math.max(0, Math.trunc(params.gorjetaCents ?? 0));

  return {
    subtotalCents,
    descontoCents,
    gorjetaCents,
    totalCents: subtotalCents - descontoCents + gorjetaCents,
  };
}

/**
 * Percentual vira centavos com **arredondamento para baixo**.
 *
 * Meio centavo de desconto não existe, e arredondar para cima daria ao cliente
 * um centavo que a casa não decidiu dar — pouco por comanda, e a conta que não
 * fecha no fim do mês.
 */
function valorDoDesconto(desconto: DescontoDaComanda, subtotalCents: number): number {
  if (desconto.tipo === 'amount') return Math.trunc(desconto.valor);
  const pontos = Math.min(Math.max(0, Math.trunc(desconto.valor)), 100);
  return Math.floor((subtotalCents * pontos) / 100);
}

export type FalhaDaComanda =
  | 'item_invalido'
  | 'quantidade_invalida'
  | 'preco_invalido'
  | 'desconto_invalido'
  | 'gorjeta_invalida';

/** Valida um item antes de entrar na comanda. */
export function validarItem(item: {
  readonly tipo: string;
  readonly descricao: string;
  readonly quantidade: number;
  readonly precoUnitarioCents: number;
}): FalhaDaComanda | null {
  if (!TIPOS_DE_ITEM.includes(item.tipo as TipoDeItem)) return 'item_invalido';
  if (!item.descricao.trim()) return 'item_invalido';
  if (!Number.isInteger(item.quantidade) || item.quantidade < 1) return 'quantidade_invalida';
  // Preço zero é legítimo — cortesia, brinde, item de cortesia da casa. Negativo
  // não é: desconto tem campo próprio, e preço negativo o esconderia do
  // relatório que separa receita de desconto.
  if (!Number.isInteger(item.precoUnitarioCents) || item.precoUnitarioCents < 0) {
    return 'preco_invalido';
  }
  return null;
}

export function validarDesconto(desconto: DescontoDaComanda): FalhaDaComanda | null {
  if (!Number.isInteger(desconto.valor) || desconto.valor < 0) return 'desconto_invalido';
  if (desconto.tipo === 'percent' && desconto.valor > 100) return 'desconto_invalido';
  if (desconto.tipo !== 'amount' && desconto.tipo !== 'percent') return 'desconto_invalido';
  return null;
}

// -- Pagamento ----------------------------------------------------------------

export const FORMAS_DE_PAGAMENTO = [
  'cash',
  'pix',
  'debit',
  'credit',
  'link',
  'transfer',
] as const;

export type FormaDePagamento = (typeof FORMAS_DE_PAGAMENTO)[number];

/** Só dinheiro entra na gaveta. O resto some no extrato do adquirente. */
export const ENTRA_NA_GAVETA: readonly FormaDePagamento[] = ['cash'];

export interface Pagamento {
  readonly forma: FormaDePagamento;
  readonly valorCents: number;
}

export type FalhaDoPagamento =
  | 'forma_invalida'
  | 'valor_invalido'
  | 'falta_pagar'
  | 'pagou_demais';

/**
 * O pagamento fecha a comanda?
 *
 * Divisão entre formas é caso comum — R$ 50 no Pix e R$ 70 no crédito (SPEC
 * §3.2). O que não se aceita é fechar com diferença: faltando, a comanda
 * continua aberta; sobrando, ou é troco (dinheiro) ou é erro de digitação.
 *
 * **Troco só existe em dinheiro.** Pagar R$ 100 em cartão numa conta de R$ 70 é
 * digitação errada, e aceitar isso produziria receita que nunca entrou.
 */
export function conferirPagamento(params: {
  readonly totalCents: number;
  readonly pagamentos: readonly Pagamento[];
}): { readonly falha: FalhaDoPagamento | null; readonly trocoCents: number } {
  for (const pagamento of params.pagamentos) {
    if (!FORMAS_DE_PAGAMENTO.includes(pagamento.forma)) {
      return { falha: 'forma_invalida', trocoCents: 0 };
    }
    if (!Number.isInteger(pagamento.valorCents) || pagamento.valorCents <= 0) {
      return { falha: 'valor_invalido', trocoCents: 0 };
    }
  }

  const pago = params.pagamentos.reduce((soma, p) => soma + p.valorCents, 0);
  if (pago < params.totalCents) return { falha: 'falta_pagar', trocoCents: 0 };

  const sobra = pago - params.totalCents;
  if (sobra === 0) return { falha: null, trocoCents: 0 };

  const emDinheiro = params.pagamentos
    .filter((p) => ENTRA_NA_GAVETA.includes(p.forma))
    .reduce((soma, p) => soma + p.valorCents, 0);

  if (sobra > emDinheiro) return { falha: 'pagou_demais', trocoCents: 0 };
  return { falha: null, trocoCents: sobra };
}

/**
 * Quanto entra na gaveta com esta comanda.
 *
 * Só dinheiro, e já **descontado o troco**: quem paga R$ 100 numa conta de R$ 70
 * deixa R$ 70 na gaveta, não R$ 100. Somar o valor recebido sem tirar o troco é
 * como o fechamento do dia acusa sobra que não existe.
 */
export function entraNaGaveta(params: {
  readonly pagamentos: readonly Pagamento[];
  readonly trocoCents: number;
}): number {
  const dinheiro = params.pagamentos
    .filter((p) => ENTRA_NA_GAVETA.includes(p.forma))
    .reduce((soma, p) => soma + p.valorCents, 0);
  return Math.max(0, dinheiro - params.trocoCents);
}

// -- Caixa --------------------------------------------------------------------

export type TipoDeMovimento = 'opening' | 'sale' | 'withdrawal' | 'supply' | 'adjustment';

export interface MovimentoDeCaixa {
  readonly tipo: TipoDeMovimento;
  /** Positivo entra, negativo sai. Sangria é negativa; suprimento é positivo. */
  readonly valorCents: number;
}

/**
 * Quanto **deveria** ter na gaveta.
 *
 * O esperado é a soma dos movimentos, e nada mais. Ele existe para ser
 * comparado com o que o operador contou — e a diferença entre os dois é a
 * divergência, que a SPEC manda registrar, nunca silenciar.
 */
export function esperadoNaGaveta(movimentos: readonly MovimentoDeCaixa[]): number {
  return movimentos.reduce((soma, movimento) => soma + movimento.valorCents, 0);
}

export interface Fechamento {
  readonly esperadoCents: number;
  readonly contadoCents: number;
  /** Positivo é sobra, negativo é falta. Zero é o normal. */
  readonly divergenciaCents: number;
}

/**
 * Fecha o caixa.
 *
 * O fechamento é **cego** por opção da barbearia (SPEC §3.10): o operador conta
 * sem ver o esperado. Isso não muda a conta — muda quem sabe o número antes de
 * contar, e é o que reduz o ajuste conveniente.
 *
 * A divergência é sempre gravada, inclusive zero. Guardar só quando diferente
 * tornaria impossível distinguir "conferiu e bateu" de "ninguém conferiu".
 */
export function fecharCaixa(params: {
  readonly movimentos: readonly MovimentoDeCaixa[];
  readonly contadoCents: number;
}): Fechamento {
  const esperadoCents = esperadoNaGaveta(params.movimentos);
  return {
    esperadoCents,
    contadoCents: params.contadoCents,
    divergenciaCents: params.contadoCents - esperadoCents,
  };
}
