/**
 * Comissão: quanto do que entrou é de quem executou.
 *
 * Tudo aqui é puro — sem banco, sem relógio. O que este arquivo decide é a
 * regra; quem a aplica sobre dados reais é `packages/finance`.
 *
 * A SPEC §3.4 lista as decisões que "precisam estar explícitas", e a razão é
 * sempre a mesma: comissão é o número que o barbeiro confere no fim do mês.
 * Ambiguidade aqui não vira bug de software, vira briga — e a briga acontece
 * uma vez por mês, com o dono tendo que explicar de cabeça uma conta que o
 * sistema fez.
 *
 * Quatro decisões que este arquivo toma e que valem ser lidas antes de mexer:
 *
 * 1. **O desconto é rateado entre os itens, proporcional ao valor.** A comanda
 *    tem um desconto só; a comissão é por item, e itens podem ser de barbeiros
 *    diferentes. Sem ratear, o desconto cairia inteiro sobre o primeiro item da
 *    lista — e quem cortou o cabelo pagaria sozinho o desconto que o dono deu
 *    na comanda inteira.
 *
 * 2. **A gorjeta nunca entra na base.** Ela já é 100% do profissional; incluí-la
 *    faria a casa comissionar dinheiro que nunca foi dela.
 *
 * 3. **Faixa progressiva é marginal**, como imposto de renda: os primeiros
 *    R$ 5.000 a 40%, e só o que passa disso a 45%. A alternativa — a alíquota
 *    da faixa atingida valendo para tudo — é outra regra, e produz um degrau em
 *    que vender um real a mais aumenta a comissão em centenas. Se a barbearia
 *    quiser o degrau, isso é uma modalidade nova e explícita, não um ajuste
 *    silencioso desta.
 *
 * 4. **Percentual em pontos-base, nunca fração.** 40% é `4000`, não `0.4`.
 *    Dinheiro é inteiro em todo o sistema e a alíquota não podia ser a única
 *    porta de entrada de ponto flutuante.
 */

export const MODOS_DE_COMISSAO = ['percent', 'fixed', 'tiers'] as const;
export type ModoDeComissao = (typeof MODOS_DE_COMISSAO)[number];

/** Base sobre a qual a comissão incide. A SPEC pede que seja configurável. */
export const BASES_DE_COMISSAO = ['liquido', 'bruto'] as const;
export type BaseDeComissao = (typeof BASES_DE_COMISSAO)[number];

/**
 * O que fazer com o desconto.
 *
 * `reduz_base` é o padrão da SPEC: quem deu o desconto divide o custo dele com
 * quem executou. `custo_da_casa` existe porque o desconto costuma ser decisão
 * do dono, e fazer o barbeiro pagar por uma cortesia que ele não ofereceu é a
 * segunda maior fonte de discussão depois da própria alíquota.
 */
export const TRATAMENTOS_DO_DESCONTO = ['reduz_base', 'custo_da_casa'] as const;
export type TratamentoDoDesconto = (typeof TRATAMENTOS_DO_DESCONTO)[number];

/**
 * O que fazer com a taxa do adquirente (bloco 36).
 *
 * A terceira escolha que a SPEC §3.4 exige que seja explícita, e a que ficou
 * de fora por seis blocos — não por esquecimento, mas porque **a alíquota do
 * adquirente não existia em lugar nenhum do produto**. Oferecer "rateada" antes
 * disso daria zero em toda comanda: campo que o motor aceita e ninguém
 * preenche.
 *
 * `absorvida` é o padrão e é o que o produto sempre fez, por omissão: a casa
 * paga a maquininha inteira. `rateada` é a outra prática real do setor — o
 * barbeiro divide o custo do meio de pagamento que o cliente escolheu.
 *
 * Ela é diferente do desconto num ponto que importa: **o desconto é decisão de
 * alguém, a taxa não é de ninguém.** Quem escolheu crédito em três vezes foi o
 * cliente, e é por isso que ratear a taxa é defensável onde ratear o desconto
 * costuma não ser.
 */
export const TRATAMENTOS_DA_TAXA = ['absorvida', 'rateada'] as const;
export type TratamentoDaTaxa = (typeof TRATAMENTOS_DA_TAXA)[number];

/**
 * A taxa de uma venda, em centavos, a partir da alíquota de cada meio.
 *
 * Pontos-base inteiros como toda alíquota do produto (319 = 3,19%), e
 * arredondamento por meio de pagamento e não sobre o total: é assim que o
 * adquirente cobra, uma tarifa por transação. Somar primeiro e aplicar uma
 * alíquota média daria um número que não bate com nenhum extrato.
 */
export function taxaDaVenda(params: {
  readonly pagamentos: readonly { readonly forma: string; readonly valorCents: number }[];
  readonly aliquotasBps: ReadonlyMap<string, number>;
  /**
   * O troco, que **sai** da base da taxa.
   *
   * Achado da revisão do bloco 36. O balcão digita o que o cliente entregou —
   * R$ 100 numa conta de R$ 60 —, e cobrar taxa sobre os R$ 40 que voltaram
   * para o bolso do cliente é cobrar tarifa de dinheiro que nunca ficou com a
   * barbearia. Ele sempre sai do dinheiro vivo, como em `entraNaGaveta`.
   */
  readonly trocoCents?: number;
}): number {
  let troco = Math.max(0, params.trocoCents ?? 0);
  let taxa = 0;

  for (const pagamento of params.pagamentos) {
    let valor = pagamento.valorCents;
    if (pagamento.forma === 'cash' && troco > 0) {
      const abatido = Math.min(troco, valor);
      valor -= abatido;
      troco -= abatido;
    }

    const bps = params.aliquotasBps.get(pagamento.forma) ?? 0;
    if (bps <= 0 || valor <= 0) continue;
    taxa += Math.round((valor * bps) / 10_000);
  }

  return taxa;
}

/**
 * A parte da taxa que desce da base do barbeiro.
 *
 * Também achado da revisão. A taxa é cobrada sobre **tudo** que passou no
 * aparelho — inclusive a gorjeta —, mas ela é rateada só sobre os itens, cuja
 * soma é o subtotal. Numerador e denominador diferentes: o barbeiro pagava
 * tarifa sobre a própria gorjeta, que a decisão nº 2 deste arquivo diz que
 * "nunca entra na base" e que a tela chama de "dinheiro que nunca foi da casa".
 *
 * A regra que sobra é explicável em uma frase: **desce da sua base a taxa sobre
 * o que você vendeu** — não sobre a gorjeta, que é sua, nem sobre o troco, que
 * voltou para o cliente.
 */
export function taxaSobreOsItens(params: {
  readonly taxaCents: number;
  /** Receita comissionável: soma dos itens menos o desconto. */
  readonly receitaCents: number;
  /** O que foi de fato cobrado no aparelho: receita mais gorjeta. */
  readonly cobradoCents: number;
}): number {
  if (params.taxaCents <= 0 || params.cobradoCents <= 0) return 0;
  if (params.receitaCents <= 0) return 0;
  if (params.receitaCents >= params.cobradoCents) return params.taxaCents;
  return Math.round((params.taxaCents * params.receitaCents) / params.cobradoCents);
}

/** Uma faixa progressiva. `ateCents` nulo é "daí para cima". */
export interface FaixaDeComissao {
  readonly ateCents: number | null;
  readonly pontosBase: number;
}

export interface RegraDeComissao {
  readonly id: string;
  /** Nulo = vale para qualquer profissional. */
  readonly professionalId: string | null;
  /** Nulo = vale para qualquer serviço. */
  readonly serviceId: string | null;
  /** Nulo = vale para qualquer categoria. */
  readonly categoryId: string | null;
  readonly modo: ModoDeComissao;
  /** Pontos-base em `percent` (4000 = 40%); centavos em `fixed`. */
  readonly valor: number;
  readonly faixas: readonly FaixaDeComissao[];
}

export interface ItemComissionavel {
  readonly id: string;
  readonly professionalId: string | null;
  readonly serviceId: string | null;
  readonly categoryId: string | null;
  /** Preço unitário × quantidade, antes de desconto. */
  readonly totalCents: number;
}

export type ComissaoFailure =
  | 'aliquota_invalida'
  | 'valor_invalido'
  | 'faixas_invalidas'
  | 'faixas_ausentes';

export function validarRegra(regra: {
  readonly modo: ModoDeComissao;
  readonly valor: number;
  readonly faixas?: readonly FaixaDeComissao[];
}): ComissaoFailure | null {
  if (regra.modo === 'percent') {
    // Acima de 100% a casa paga para atender. É erro de digitação, não escolha.
    if (!Number.isInteger(regra.valor) || regra.valor < 0 || regra.valor > 10_000) {
      return 'aliquota_invalida';
    }
    return null;
  }

  if (regra.modo === 'fixed') {
    if (!Number.isInteger(regra.valor) || regra.valor < 0) return 'valor_invalido';
    return null;
  }

  const faixas = regra.faixas ?? [];
  if (faixas.length === 0) return 'faixas_ausentes';

  let anterior = 0;
  for (const [i, faixa] of faixas.entries()) {
    if (!Number.isInteger(faixa.pontosBase) || faixa.pontosBase < 0 || faixa.pontosBase > 10_000) {
      return 'aliquota_invalida';
    }
    const ultima = i === faixas.length - 1;
    // Só a última pode ser aberta: duas abertas deixariam indefinido qual vale.
    if (faixa.ateCents === null) {
      if (!ultima) return 'faixas_invalidas';
      continue;
    }
    if (!ultima && faixas[i + 1]?.ateCents === null) {
      // ok: a próxima é a aberta
    }
    if (!Number.isInteger(faixa.ateCents) || faixa.ateCents <= anterior) return 'faixas_invalidas';
    anterior = faixa.ateCents;
  }

  // Sem faixa aberta no fim, faturamento acima do último teto ficaria sem
  // alíquota — e o barbeiro deixaria de receber justo no melhor mês.
  if (faixas[faixas.length - 1]?.ateCents !== null) return 'faixas_invalidas';
  return null;
}

/**
 * Rateia o desconto da comanda entre os itens, proporcional ao valor.
 *
 * A soma das partes é **exatamente** o desconto, sempre. Isso não sai de
 * arredondar cada parte: três itens iguais dividindo dez centavos dariam
 * 3+3+3=9, e um centavo sumiria da conta da casa a cada comanda. O resto é
 * distribuído pelo método do maior resto, e o desempate é pelo maior valor —
 * determinístico, para que a mesma comanda dê sempre o mesmo resultado.
 */
/**
 * O mesmo rateio, para a taxa do adquirente (bloco 36).
 *
 * Delega em vez de repetir: é a mesma conta e o mesmo critério de sobra, e duas
 * cópias divergiriam no primeiro ajuste — sempre na que ninguém está olhando.
 * O nome próprio existe porque `ratearDesconto({descontoCents: taxa})` na linha
 * de chamada é mentira sobre o que está sendo rateado.
 */
export function ratearTaxa(params: {
  readonly itens: readonly ItemComissionavel[];
  readonly taxaCents: number;
}): ReadonlyMap<string, number> {
  return ratearDesconto({ itens: params.itens, descontoCents: params.taxaCents });
}

export function ratearDesconto(params: {
  readonly itens: readonly ItemComissionavel[];
  readonly descontoCents: number;
}): ReadonlyMap<string, number> {
  const rateio = new Map<string, number>();
  const total = params.itens.reduce((soma, item) => soma + item.totalCents, 0);

  if (params.descontoCents <= 0 || total <= 0) {
    for (const item of params.itens) rateio.set(item.id, 0);
    return rateio;
  }

  // Desconto maior que o total zeraria a base; não há o que ratear além dele.
  const desconto = Math.min(params.descontoCents, total);

  const restos: { id: string; resto: number; valor: number }[] = [];
  let distribuido = 0;

  for (const item of params.itens) {
    const exato = (item.totalCents * desconto) / total;
    const piso = Math.floor(exato);
    rateio.set(item.id, piso);
    distribuido += piso;
    restos.push({ id: item.id, resto: exato - piso, valor: item.totalCents });
  }

  restos.sort((a, b) => b.resto - a.resto || b.valor - a.valor || (a.id < b.id ? -1 : 1));

  let sobra = desconto - distribuido;
  for (const { id } of restos) {
    if (sobra <= 0) break;
    rateio.set(id, (rateio.get(id) ?? 0) + 1);
    sobra -= 1;
  }

  return rateio;
}

/**
 * A regra que vale para um item: a **mais específica** ganha.
 *
 * A ordem existe porque as regras se sobrepõem de propósito: a barbearia
 * define 40% no geral, 50% na barba, e 45% na barba do Ruan porque ele é quem
 * traz aquele cliente. Sem uma ordem declarada, qual das três vale viraria
 * detalhe de implementação — e mudaria sozinho no dia em que alguém reordenasse
 * um `ORDER BY`.
 */
export function escolherRegra(
  regras: readonly RegraDeComissao[],
  alvo: {
    readonly professionalId: string | null;
    readonly serviceId: string | null;
    readonly categoryId: string | null;
  },
): RegraDeComissao | null {
  const cabe = (regra: RegraDeComissao): boolean =>
    (regra.professionalId === null || regra.professionalId === alvo.professionalId) &&
    (regra.serviceId === null || regra.serviceId === alvo.serviceId) &&
    (regra.categoryId === null || regra.categoryId === alvo.categoryId);

  const peso = (regra: RegraDeComissao): number =>
    (regra.professionalId !== null ? 4 : 0) +
    (regra.serviceId !== null ? 2 : 0) +
    (regra.categoryId !== null ? 1 : 0);

  let escolhida: RegraDeComissao | null = null;
  for (const regra of regras) {
    if (!cabe(regra)) continue;
    if (!escolhida) {
      escolhida = regra;
      continue;
    }
    const diferenca = peso(regra) - peso(escolhida);
    // Empate de especificidade é decidido pelo id, e não pela ordem da lista:
    // a mesma configuração precisa dar o mesmo resultado em toda consulta.
    if (diferenca > 0 || (diferenca === 0 && regra.id < escolhida.id)) escolhida = regra;
  }

  return escolhida;
}

/** A base de um item, já com o desconto tratado conforme a configuração. */
export function baseDoItem(params: {
  readonly item: ItemComissionavel;
  readonly descontoRateadoCents: number;
  readonly base: BaseDeComissao;
  readonly tratamentoDoDesconto: TratamentoDoDesconto;
  /** A parte da taxa do adquirente que cabe a este item (bloco 36). */
  readonly taxaRateadaCents?: number;
  readonly tratamentoDaTaxa?: TratamentoDaTaxa;
}): number {
  /**
   * `bruto` ignora **as duas** deduções, e é o que a palavra significa.
   *
   * Deixar a taxa descer sobre a base bruta faria "bruto" querer dizer "bruto,
   * menos uma coisa" — que é o tipo de definição que ninguém consegue explicar
   * para o barbeiro no dia do acerto.
   */
  if (params.base === 'bruto') return params.item.totalCents;

  const desconto =
    params.tratamentoDoDesconto === 'custo_da_casa' ? 0 : params.descontoRateadoCents;
  const taxa = params.tratamentoDaTaxa === 'rateada' ? (params.taxaRateadaCents ?? 0) : 0;

  return Math.max(0, params.item.totalCents - desconto - taxa);
}

const porCento = (valorCents: number, pontosBase: number): number =>
  Math.round((valorCents * pontosBase) / 10_000);

/**
 * Comissão de faixas, marginal.
 *
 * Cada faixa incide **só sobre a parte que cai nela**. Com 40% até 5.000 e 45%
 * acima, faturar 6.000 rende 2.000 + 450, não 2.700. Ver a decisão 3 no topo do
 * arquivo.
 */
export function aplicarFaixas(
  faixas: readonly FaixaDeComissao[],
  baseCents: number,
): number {
  if (baseCents <= 0) return 0;

  let comissao = 0;
  let piso = 0;

  for (const faixa of faixas) {
    const teto = faixa.ateCents ?? Number.POSITIVE_INFINITY;
    const naFaixa = Math.min(baseCents, teto) - piso;
    if (naFaixa <= 0) break;
    comissao += porCento(naFaixa, faixa.pontosBase);
    piso = teto;
    if (baseCents <= teto) break;
  }

  return comissao;
}

export interface LancamentoDeComissao {
  readonly itemId: string;
  readonly professionalId: string;
  readonly regraId: string;
  readonly modo: ModoDeComissao;
  readonly valor: number;
  readonly faixas: readonly FaixaDeComissao[];
  readonly baseCents: number;
  /** Estorno entra com sinal negativo e é somado como qualquer outro. */
  readonly sinal: 1 | -1;
}

export interface ComissaoDoProfissional {
  readonly professionalId: string;
  readonly baseCents: number;
  readonly comissaoCents: number;
}

/**
 * Fecha a conta de cada profissional no período.
 *
 * Por que a soma acontece aqui e não item a item na hora da venda: **faixa
 * progressiva depende do acumulado**. A alíquota do corte de terça só é
 * conhecida depois de saber quanto o barbeiro faturou até o fim do mês — e um
 * estorno no dia 28 pode derrubar a faixa de todo o período.
 *
 * Por isso o lançamento guarda a **base** e a regra, nunca um valor pronto. O
 * valor é derivado, e derivado é o que permite o estorno corrigir o passado sem
 * reescrever linha nenhuma.
 *
 * `percent` e `fixed` são somados por lançamento; só `tiers` precisa do
 * acumulado. Um barbeiro pode ter regras dos dois tipos no mesmo mês — o corte
 * por faixa e o produto com percentual fixo —, e nesse caso a faixa incide só
 * sobre a base dos lançamentos que caíram nela.
 */
export function comissaoDoPeriodo(
  lancamentos: readonly LancamentoDeComissao[],
): readonly ComissaoDoProfissional[] {
  const porProfissional = new Map<
    string,
    { base: number; direta: number; porRegraDeFaixa: Map<string, { base: number; faixas: readonly FaixaDeComissao[] }> }
  >();

  for (const lancamento of lancamentos) {
    const conta =
      porProfissional.get(lancamento.professionalId) ??
      { base: 0, direta: 0, porRegraDeFaixa: new Map() };
    porProfissional.set(lancamento.professionalId, conta);

    const base = lancamento.baseCents * lancamento.sinal;
    conta.base += base;

    if (lancamento.modo === 'percent') {
      conta.direta += porCento(base, lancamento.valor);
    } else if (lancamento.modo === 'fixed') {
      // Valor fixo é por item vendido, não por real faturado.
      conta.direta += lancamento.valor * lancamento.sinal;
    } else {
      const acumulado =
        conta.porRegraDeFaixa.get(lancamento.regraId) ??
        { base: 0, faixas: lancamento.faixas };
      acumulado.base += base;
      conta.porRegraDeFaixa.set(lancamento.regraId, acumulado);
    }
  }

  return [...porProfissional]
    .map(([professionalId, conta]) => {
      let comissao = conta.direta;
      for (const { base, faixas } of conta.porRegraDeFaixa.values()) {
        comissao += aplicarFaixas(faixas, base);
      }
      return { professionalId, baseCents: conta.base, comissaoCents: comissao };
    })
    .sort((a, b) => (a.professionalId < b.professionalId ? -1 : 1));
}
