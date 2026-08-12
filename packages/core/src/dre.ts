/**
 * DRE gerencial (bloco 52, SPEC §3.10).
 *
 * ```
 *   Receita de serviços
 * + Receita de produtos
 * + Receita de assinaturas
 * ──────────────────────────
 * − Comissões
 * − CMV
 * − Taxas de pagamento
 * − Despesas operacionais
 * ──────────────────────────
 * = Resultado
 * ```
 *
 * ## Não existe tabela de DRE
 *
 * Cada linha é **derivada** do fato que já está gravado: a receita sai da
 * comanda paga, o CMV do movimento de estoque com custo congelado, a taxa de
 * `orders.fee_cents`, a despesa da conta paga do bloco 51. Uma tabela de
 * resultado seria um número que alguém sobrescreve — e a pergunta que chega ao
 * balcão nunca é "quanto deu", é *"por que caiu?"*. Mesma decisão do saldo de
 * estoque e do saldo de fidelidade.
 *
 * ## O custo da fidelidade é uma linha própria
 *
 * Quando o cliente paga R$ 5 com crédito, a receita continua sendo o preço do
 * serviço e o dinheiro que entrou é R$ 5 menor. A diferença é custo de
 * marketing, e até este bloco ela não era registrada em lugar nenhum: o caixa
 * batia — resgate não entra na gaveta — e o resultado do mês superestimava a
 * margem pelo valor resgatado.
 *
 * Ela fica **fora** de "despesas operacionais" de propósito. Aquela linha soma
 * contas digitadas pelo balcão; esta é derivada da venda. Misturá-las faria a
 * única linha que ninguém digita desaparecer dentro da que todo mundo confere.
 */

/** Tudo em centavos inteiros, e cada campo é uma linha do relatório. */
export interface FatosDoDre {
  readonly receitaServicosCents: number;
  readonly receitaProdutosCents: number;
  readonly receitaAssinaturasCents: number;
  readonly comissoesCents: number;
  readonly cmvCents: number;
  readonly taxasCents: number;
  readonly fidelidadeCents: number;
  readonly despesasCents: number;
}

export interface Dre extends FatosDoDre {
  readonly receitaBrutaCents: number;
  readonly custoTotalCents: number;
  readonly resultadoCents: number;
  /**
   * Margem em pontos-base sobre a receita bruta, como toda alíquota do produto.
   * Nula quando não houve receita: dividir por zero produziria `Infinity`, e
   * "margem de ∞%" num mês sem venda é pior que campo vazio.
   */
  readonly margemBps: number | null;
}

export function montarDre(fatos: FatosDoDre): Dre {
  const receitaBrutaCents =
    fatos.receitaServicosCents + fatos.receitaProdutosCents + fatos.receitaAssinaturasCents;

  const custoTotalCents =
    fatos.comissoesCents
    + fatos.cmvCents
    + fatos.taxasCents
    + fatos.fidelidadeCents
    + fatos.despesasCents;

  const resultadoCents = receitaBrutaCents - custoTotalCents;

  return {
    ...fatos,
    receitaBrutaCents,
    custoTotalCents,
    resultadoCents,
    margemBps:
      receitaBrutaCents > 0 ? Math.round((resultadoCents / receitaBrutaCents) * 10_000) : null,
  };
}

// ---------------------------------------------------------------------------
// O comparativo
// ---------------------------------------------------------------------------

export type SentidoDaVariacao = 'melhorou' | 'piorou' | 'igual';

export interface VariacaoDaLinha {
  readonly atualCents: number;
  readonly anteriorCents: number;
  readonly deltaCents: number;
  /**
   * Variação percentual em pontos-base. Nula quando o período anterior foi
   * zero: "subiu ∞%" não é informação, e é o que aparece no segundo mês de toda
   * barbearia nova.
   */
  readonly variacaoBps: number | null;
  readonly sentido: SentidoDaVariacao;
}

/**
 * Compara duas linhas, sabendo se ela é receita ou custo.
 *
 * O sentido **não** é o sinal do delta: despesa que sobe é pior, receita que
 * sobe é melhor. Uma seta verde para cima em "Comissões" seria a tela dizendo o
 * contrário do que o número significa — e é a única coisa que quem abre o
 * relatório olha antes de ler o valor.
 */
export function compararLinha(
  atualCents: number,
  anteriorCents: number,
  natureza: 'receita' | 'custo',
): VariacaoDaLinha {
  const deltaCents = atualCents - anteriorCents;
  const melhorQuandoSobe = natureza === 'receita';

  let sentido: SentidoDaVariacao = 'igual';
  if (deltaCents !== 0) {
    const subiu = deltaCents > 0;
    sentido = subiu === melhorQuandoSobe ? 'melhorou' : 'piorou';
  }

  return {
    atualCents,
    anteriorCents,
    deltaCents,
    variacaoBps:
      anteriorCents !== 0 ? Math.round((deltaCents / Math.abs(anteriorCents)) * 10_000) : null,
    sentido,
  };
}

export const LINHAS_DO_DRE = [
  { campo: 'receitaServicosCents', rotulo: 'Serviços', natureza: 'receita' },
  { campo: 'receitaProdutosCents', rotulo: 'Produtos', natureza: 'receita' },
  { campo: 'receitaAssinaturasCents', rotulo: 'Assinaturas', natureza: 'receita' },
  { campo: 'comissoesCents', rotulo: 'Comissões', natureza: 'custo' },
  { campo: 'cmvCents', rotulo: 'Custo dos produtos vendidos', natureza: 'custo' },
  { campo: 'taxasCents', rotulo: 'Taxas de pagamento', natureza: 'custo' },
  { campo: 'fidelidadeCents', rotulo: 'Programa de fidelidade', natureza: 'custo' },
  { campo: 'despesasCents', rotulo: 'Despesas operacionais', natureza: 'custo' },
] as const satisfies readonly {
  campo: keyof FatosDoDre;
  rotulo: string;
  natureza: 'receita' | 'custo';
}[];

export interface DreComparado {
  readonly atual: Dre;
  readonly anterior: Dre;
  readonly linhas: readonly (VariacaoDaLinha & {
    readonly campo: keyof FatosDoDre;
    readonly rotulo: string;
    readonly natureza: 'receita' | 'custo';
  })[];
  readonly receitaBruta: VariacaoDaLinha;
  readonly resultado: VariacaoDaLinha;
}

/**
 * O relatório com o período anterior ao lado.
 *
 * *"Filtrável por unidade e período, com comparativo contra o período
 * anterior."* O comparativo é o relatório: um resultado de R$ 12.400 sozinho não
 * responde nada — o que o dono precisa saber é se subiu ou desceu, e por causa
 * de qual linha.
 */
export function compararDre(atual: Dre, anterior: Dre): DreComparado {
  return {
    atual,
    anterior,
    linhas: LINHAS_DO_DRE.map((linha) => ({
      ...compararLinha(atual[linha.campo], anterior[linha.campo], linha.natureza),
      campo: linha.campo,
      rotulo: linha.rotulo,
      natureza: linha.natureza,
    })),
    receitaBruta: compararLinha(atual.receitaBrutaCents, anterior.receitaBrutaCents, 'receita'),
    resultado: compararLinha(atual.resultadoCents, anterior.resultadoCents, 'receita'),
  };
}

/**
 * O período imediatamente anterior, do mesmo tamanho.
 *
 * "Mês anterior" seria errado para um recorte de sete dias e para um de
 * quarenta: o comparativo tem que ser contra uma janela do **mesmo tamanho**,
 * senão a queda que a tela mostra é só a diferença de duração.
 */
export function periodoAnterior(de: string, ate: string): { de: string; ate: string } {
  const inicio = Date.parse(`${de}T00:00:00Z`);
  const fim = Date.parse(`${ate}T00:00:00Z`);
  const dias = Math.round((fim - inicio) / 86_400_000) + 1;

  const fimAnterior = inicio - 86_400_000;
  const inicioAnterior = fimAnterior - (dias - 1) * 86_400_000;

  const dia = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { de: dia(inicioAnterior), ate: dia(fimAnterior) };
}
