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
/**
 * `package` entrou no bloco 42 e é diferente dos outros três.
 *
 * Os três primeiros são coisas entregues **agora**: o corte, a pomada, a água. O
 * pacote é dinheiro recebido por serviço que ainda não aconteceu — a receita
 * dele é reconhecida conforme o uso, não na venda (SPEC §4.7).
 *
 * Ele fica na mesma lista porque, para a comanda, é um item como qualquer outro:
 * tem descrição, preço e entra no total. O que muda é o **relatório**, e é lá
 * que a distinção vive.
 */
export const TIPOS_DE_ITEM = ['service', 'product', 'consumable', 'package'] as const;
export type TipoDeItem = (typeof TIPOS_DE_ITEM)[number];

export interface ItemDaComanda {
  readonly id: string;
  readonly tipo: TipoDeItem;
  /**
   * O serviço que este item vende, quando é um serviço.
   *
   * A tela do balcão casa o pacote do cliente com o item por **id**, nunca pela
   * descrição: a recepção edita o texto, e um "Corte + escova" deixaria de casar
   * com o pacote de corte em silêncio.
   */
  readonly serviceId: string | null;
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
  | 'desconto_acima_do_teto'
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

/**
 * O teto de desconto da barbearia (bloco 30).
 *
 * Puro e em pontos-base inteiros, como toda alíquota do produto: 2000 é 20%. A
 * conta é feita sobre o **subtotal**, que é o que o desconto de fato reduz — o
 * total já traz gorjeta, que não é da casa e não pode inflar o teto.
 *
 * O arredondamento é para baixo. Com teto de 20% sobre R$ 33,33, o máximo é
 * R$ 6,66 e não R$ 6,67: quem escreveu "vinte por cento" não autorizou o
 * centavo que passa.
 */
export function tetoDoDesconto(subtotalCents: number, tetoBps: number): number {
  const bps = Math.min(Math.max(0, Math.trunc(tetoBps)), 10_000);
  return Math.floor((subtotalCents * bps) / 10_000);
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
  /**
   * Fiado: o cliente leva agora e paga depois.
   *
   * A SPEC §3.10 o marca como **obrigatório para migrar** — o incumbente tem
   * (`get_controle_fiados`) e a barbearia de bairro usa. Ele é a única forma
   * que **não é dinheiro entrando**: vira saldo devedor do cliente, e o dinheiro
   * só aparece quando ele volta para pagar.
   */
  'fiado',
  /**
   * Resgate de fidelidade (bloco 41, SPEC §4.8).
   *
   * Forma de pagamento e **não desconto**, e a diferença não é semântica:
   * desconto é a casa abrindo mão de receita, com permissão própria e teto
   * (`finance.discount`, `tenants.max_discount_bps`); resgate é o cliente
   * gastando um crédito que já é dele. Como desconto, o teto do bloco 30
   * barraria o cliente de usar o próprio saldo, e o relatório de descontos
   * concedidos passaria a incluir dinheiro já provisionado.
   *
   * Como `fiado`, não é dinheiro entrando **agora** — mas por motivo oposto: o
   * fiado é receita que ainda vem, e o resgate é receita que já veio, na venda
   * que gerou o saldo. Contá-lo de novo aqui seria faturar duas vezes o mesmo
   * corte.
   */
  'fidelidade',
  /**
   * Pacote (bloco 42, SPEC §4.7).
   *
   * O cliente pagou cinco cortes adiantado; este é o momento em que ele usa um.
   * Como o resgate de fidelidade, não é dinheiro entrando agora — mas por um
   * motivo diferente e mais forte: o dinheiro entrou **na venda do pacote**, e
   * o que acontece aqui é o reconhecimento da receita que já estava diferida.
   *
   * O item do corte continua com o preço congelado da unidade, e é de propósito:
   * é ele que dá base à comissão do barbeiro, que não pode cair só porque o
   * cliente pagou adiantado.
   */
  'pacote',
  /**
   * A assinatura do clube quita a conta (bloco 45).
   *
   * Como o pacote: o item do corte continua com o preço de tabela — é ele que
   * dá base à comissão do barbeiro, que não pode cair porque o cliente é
   * assinante — e a mensalidade cobre.
   */
  'assinatura',
] as const;

export type FormaDePagamento = (typeof FORMAS_DE_PAGAMENTO)[number];

/** Só dinheiro entra na gaveta. O resto some no extrato do adquirente. */
export const ENTRA_NA_GAVETA: readonly FormaDePagamento[] = ['cash'];

/**
 * O que o cliente pode escolher **sozinho**, sem alguém do balcão.
 *
 * Fiado e fidelidade ficam de fora: o primeiro cria dívida, o segundo gasta
 * saldo. Os dois passam por quem opera a comanda.
 */
export const FORMAS_DO_CLIENTE: readonly FormaDePagamento[] = [
  'cash', 'pix', 'debit', 'credit', 'link', 'transfer',
];

/**
 * Formas que não trazem dinheiro agora.
 *
 * Separado de `ENTRA_NA_GAVETA` de propósito: cartão não entra na gaveta mas é
 * receita realizada; fiado não entra na gaveta **e não é receita ainda**. Somar
 * os dois no faturamento do dia é como a barbearia acha que faturou o que
 * ninguém pagou.
 */
export const NAO_E_RECEITA_AGORA: readonly FormaDePagamento[] = ['fiado'];

export interface Pagamento {
  readonly forma: FormaDePagamento;
  readonly valorCents: number;
}

export type FalhaDoPagamento =
  | 'forma_invalida'
  | 'valor_invalido'
  | 'falta_pagar'
  | 'pagou_demais'
  | 'fiado_sem_cliente'
  | 'fiado_acima_do_limite';

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
  /**
   * A conta do cliente. Obrigatória se alguma parcela for fiado — sem cliente
   * identificado a dívida não teria dono, e a barbearia descobriria no fim do
   * mês que fiou para "ninguém".
   */
  readonly conta?: ContaDoCliente | null;
}): { readonly falha: FalhaDoPagamento | null; readonly trocoCents: number } {
  for (const pagamento of params.pagamentos) {
    if (!FORMAS_DE_PAGAMENTO.includes(pagamento.forma)) {
      return { falha: 'forma_invalida', trocoCents: 0 };
    }
    if (!Number.isInteger(pagamento.valorCents) || pagamento.valorCents <= 0) {
      return { falha: 'valor_invalido', trocoCents: 0 };
    }
  }

  const fiadoCents = params.pagamentos
    .filter((p) => p.forma === 'fiado')
    .reduce((soma, p) => soma + p.valorCents, 0);

  if (fiadoCents > 0) {
    if (!params.conta) return { falha: 'fiado_sem_cliente', trocoCents: 0 };
    if (!podeFiar({ conta: params.conta, valorCents: fiadoCents })) {
      return { falha: 'fiado_acima_do_limite', trocoCents: 0 };
    }
  }

  const pago = params.pagamentos.reduce((soma, p) => soma + p.valorCents, 0);
  if (pago < params.totalCents) return { falha: 'falta_pagar', trocoCents: 0 };

  const sobra = pago - params.totalCents;
  if (sobra === 0) return { falha: null, trocoCents: 0 };

  // Ninguém fia e leva troco. Se sobrou com fiado na conta, o operador digitou
  // errado — e o desfecho seria a barbearia dar dinheiro a quem ficou devendo.
  if (fiadoCents > 0) return { falha: 'pagou_demais', trocoCents: 0 };

  /**
   * Nem resgata fidelidade e leva troco (bloco 41).
   *
   * Mesma forma da regra acima e motivo pior: numa conta de R$ 50 paga com
   * R$ 40 em dinheiro e R$ 20 de saldo, o troco de R$ 10 sairia da gaveta — e a
   * barbearia estaria **comprando de volta** o próprio programa de fidelidade,
   * em espécie. Repetido a cada visita, o cashback vira caixa eletrônico.
   *
   * O resgate certo nunca passa do que falta pagar, e é o que `valorDoResgate`
   * garante do outro lado. Esta linha é a guarda para quando o valor não vier
   * dali.
   */
  const fidelidadeCents = params.pagamentos
    .filter((p) => p.forma === 'fidelidade')
    .reduce((soma, p) => soma + p.valorCents, 0);
  if (fidelidadeCents > 0) return { falha: 'pagou_demais', trocoCents: 0 };

  // Nem consome pacote e leva troco, pelo mesmo motivo: o corte grátis viraria
  // saque, e cinco cortes por R$ 250 viram R$ 250 na mão.
  const pacoteCents = params.pagamentos
    .filter((p) => p.forma === 'pacote')
    .reduce((soma, p) => soma + p.valorCents, 0);
  if (pacoteCents > 0) return { falha: 'pagou_demais', trocoCents: 0 };

  // Nem a assinatura vira troco (bloco 45): a mensalidade paga o corte, não a
  // gaveta. Com troco, o assinante sacaria dinheiro do próprio plano todo mês.
  const assinaturaCents = params.pagamentos
    .filter((p) => p.forma === 'assinatura')
    .reduce((soma, p) => soma + p.valorCents, 0);
  if (assinaturaCents > 0) return { falha: 'pagou_demais', trocoCents: 0 };

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

export const TIPOS_DE_MOVIMENTO_DE_CAIXA = [
  'opening',
  'sale',
  'withdrawal',
  'supply',
  'adjustment',
  'debt_payment',
  'bill_payment',
  'bill_receipt',
] as const;

export type TipoDeMovimento = (typeof TIPOS_DE_MOVIMENTO_DE_CAIXA)[number];

/**
 * Como cada movimento se chama no extrato da gaveta.
 *
 * Estava escrito na tela do caixa, e ficar lá era o defeito que a §6 do
 * `CLAUDE.md` nomeia: um tipo novo no domínio aparecia para quem confere como
 * o literal cru do banco. `bill_payment` e `bill_receipt` são separados de
 * sangria e suprimento justamente porque significam outra coisa para quem
 * confere o dia — e um mapa escrito na tela seria o lugar onde essa distinção
 * se perderia.
 */
export const ROTULO_DO_MOVIMENTO_DE_CAIXA: Readonly<Record<TipoDeMovimento, string>> = {
  opening: 'Abertura',
  sale: 'Venda',
  withdrawal: 'Sangria',
  supply: 'Suprimento',
  adjustment: 'Ajuste',
  debt_payment: 'Fiado recebido',
  bill_payment: 'Conta paga',
  bill_receipt: 'Conta recebida',
};

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

// -- Fiado --------------------------------------------------------------------

/**
 * A conta do cliente.
 *
 * `saldoCents` negativo é dívida; positivo é crédito (troco que ficou, pacote
 * pago adiantado). Um número só, com sinal, em vez de duas colunas: duas
 * colunas permitiriam a mesma pessoa dever e ter crédito ao mesmo tempo, e a
 * conversa no balcão é sempre "quanto o senhor deve".
 */
export interface ContaDoCliente {
  readonly saldoCents: number;
  /**
   * Quanto esta pessoa pode dever. Zero significa **não fia**.
   *
   * Por cliente, não por barbearia: fiar é decisão de confiança, e o valor que
   * a barbearia aceita do vizinho de vinte anos não é o que aceita de quem
   * entrou hoje.
   */
  readonly limiteCents: number;
}

/**
 * Esta pessoa pode fiar este valor?
 *
 * A conta é sobre a **dívida depois**, não sobre o valor pedido: quem já deve
 * R$ 80 com limite de R$ 100 fia R$ 20, não R$ 100.
 */
export function podeFiar(params: {
  readonly conta: ContaDoCliente;
  readonly valorCents: number;
}): boolean {
  if (params.valorCents <= 0) return false;
  const dividaDepois = params.valorCents - params.conta.saldoCents;
  return dividaDepois <= params.conta.limiteCents;
}

/** Quanto ainda cabe de fiado nesta conta. Nunca negativo. */
export function fiadoDisponivel(conta: ContaDoCliente): number {
  return Math.max(0, conta.limiteCents + conta.saldoCents);
}

/**
 * O que a comanda produz de verdade, por forma de pagamento.
 *
 * Três números que a barbearia confunde e não deveria:
 *
 * - **na gaveta** — o que o operador vai contar no fechamento;
 * - **receita agora** — o que de fato entrou, em qualquer forma;
 * - **a receber** — o fiado, que ainda não é dinheiro nenhum.
 *
 * Somar fiado ao faturamento do dia é como a barbearia comemora um mês que não
 * aconteceu; e não registrá-lo em lugar nenhum é como ela esquece de cobrar.
 */
export interface ResultadoDoPagamento {
  readonly naGavetaCents: number;
  readonly receitaAgoraCents: number;
  readonly aReceberCents: number;
  readonly trocoCents: number;
}

export function resultadoDoPagamento(params: {
  readonly pagamentos: readonly Pagamento[];
  readonly trocoCents: number;
}): ResultadoDoPagamento {
  let naGaveta = 0;
  let receita = 0;
  let aReceber = 0;

  for (const pagamento of params.pagamentos) {
    if (NAO_E_RECEITA_AGORA.includes(pagamento.forma)) {
      aReceber += pagamento.valorCents;
      continue;
    }
    receita += pagamento.valorCents;
    if (ENTRA_NA_GAVETA.includes(pagamento.forma)) naGaveta += pagamento.valorCents;
  }

  return {
    naGavetaCents: Math.max(0, naGaveta - params.trocoCents),
    receitaAgoraCents: Math.max(0, receita - params.trocoCents),
    aReceberCents: aReceber,
    trocoCents: params.trocoCents,
  };
}
