/**
 * DRE gerencial (bloco 52, SPEC §3.10).
 *
 * ```
 *   Receita de serviços
 * + Receita de produtos
 * + Receita de assinaturas
 * ──────────────────────────
 * − Descontos concedidos
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
 *
 * ## O desconto é custo, e a receita continua bruta
 *
 * O desconto tem exatamente o mesmo formato de defeito que o resgate de
 * fidelidade descrito acima, e passou despercebido pela mesma razão: o caixa
 * bate — a comanda já fecha pelo valor com desconto — e nada fica vermelho.
 * Só o resultado do mês ficava maior, no valor exato do que a casa abriu mão.
 * Uma venda de R$ 100 com R$ 20 de desconto entrava como R$ 100 de receita
 * contra R$ 36 de comissão, e o relatório mostrava R$ 63,21 de sobra sobre
 * R$ 80 que de fato entraram.
 *
 * Ele entra como **custo**, e não como redução da receita, porque é o que a
 * convenção deste código já diz: *"`bruto` ignora taxa e desconto, senão
 * 'bruto' quer dizer 'bruto menos uma coisa'"*. E porque desconto é decisão —
 * tem permissão própria (`finance.discount`) e teto próprio
 * (`tenants.max_discount_bps`): esconder o total concedido dentro de uma
 * receita menor tiraria da tela justamente o número que essas duas guardas
 * existem para controlar.
 */

/** Tudo em centavos inteiros, e cada campo é uma linha do relatório. */
export interface FatosDoDre {
  readonly receitaServicosCents: number;
  readonly receitaProdutosCents: number;
  readonly receitaAssinaturasCents: number;
  readonly descontosCents: number;
  readonly comissoesCents: number;
  readonly cmvCents: number;
  readonly taxasCents: number;
  readonly fidelidadeCents: number;
  readonly despesasCents: number;
  /**
   * O que **venceu no período e não foi pago** — a ressalva da linha de despesa.
   *
   * Não entra em conta nenhuma: o DRE é de caixa, e a regra de que a despesa é
   * a conta **paga** continua valendo inteira. Ele existe para a tela poder
   * dizer o que o número não diz.
   *
   * Sem isso o relatório fazia o oposto do que a barbearia viveu: agosto com
   * seis contas vencidas e nenhuma paga mostrava *"Despesas operacionais −R$
   * 0,00 · ↓ -100,0%"* **em verde**, e "margem de 57,0%" no rodapé. O dono lia
   * uma melhora onde o que houve foi ele não ter pago o aluguel — e é a
   * convenção do número de relatório que ignora parte do dado, com a seta
   * verde por cima.
   */
  readonly despesasEmAbertoCents: number;
  /**
   * A gorjeta do período — **repasse**, e por isso fora das duas somas.
   *
   * SPEC §3.6: *"nunca entra na base de comissão nem no faturamento da casa (é
   * repasse)"* e *"aparece separada no DRE"*. Ela não é receita (o dinheiro é do
   * barbeiro) nem custo (a casa não abriu mão de nada): é dinheiro que passou
   * pela conta. Somá-la em qualquer um dos dois lados mudaria o resultado por um
   * valor que nunca foi da barbearia.
   *
   * Aparece porque o dono precisa saber quanto passou — são R$ 2.628,33 em 447
   * comandas na base de demonstração —, e porque o extrato de cada barbeiro
   * mostra a parte dele: sem o total aqui, os dois lados não têm como conferir.
   */
  readonly gorjetasCents: number;
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
    fatos.descontosCents
    + fatos.comissoesCents
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
  { campo: 'receitaServicosCents', rotulo: 'Serviços', curto: 'serviço', natureza: 'receita' },
  { campo: 'receitaProdutosCents', rotulo: 'Produtos', curto: 'produto', natureza: 'receita' },
  { campo: 'receitaAssinaturasCents', rotulo: 'Assinaturas', curto: 'assinatura', natureza: 'receita' },
  { campo: 'descontosCents', rotulo: 'Descontos concedidos', curto: 'desconto', natureza: 'custo' },
  { campo: 'comissoesCents', rotulo: 'Comissões', curto: 'comissão', natureza: 'custo' },
  { campo: 'cmvCents', rotulo: 'Custo dos produtos vendidos', curto: 'insumo', natureza: 'custo' },
  { campo: 'taxasCents', rotulo: 'Taxas de pagamento', curto: 'taxa', natureza: 'custo' },
  { campo: 'fidelidadeCents', rotulo: 'Programa de fidelidade', curto: 'fidelidade', natureza: 'custo' },
  { campo: 'despesasCents', rotulo: 'Despesas operacionais', curto: 'despesa', natureza: 'custo' },
] as const satisfies readonly {
  campo: keyof FatosDoDre;
  rotulo: string;
  /** O nome curto, para a legenda do cartão. */
  curto: string;
  natureza: 'receita' | 'custo';
}[];

/**
 * Os componentes de um dos dois totais, por extenso, para a legenda do cartão.
 *
 * Derivada de `LINHAS_DO_DRE` e não escrita à mão (bloco 103). O cartão "Saiu"
 * enumerava cinco dos **seis** componentes do número que exibia — faltava
 * "desconto" —, e a lista logo abaixo trazia "Descontos concedidos" dentro
 * daquele mesmo total. Quem conferia a soma não fechava, e a legenda e o número
 * discordavam na mesma tela (§6, pergunta 6).
 *
 * Derivada, a linha nova que alguém acrescentar em `LINHAS_DO_DRE` aparece na
 * legenda sem ninguém lembrar dela.
 */
export function componentesDo(natureza: 'receita' | 'custo'): string {
  const nomes = LINHAS_DO_DRE.filter((l) => l.natureza === natureza).map((l) => l.curto);
  if (nomes.length <= 1) return nomes[0] ?? '';
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
}

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
