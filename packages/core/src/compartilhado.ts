/**
 * O que é da rede e o que é da loja (bloco 59, SPEC §1.1).
 *
 * > *"Fidelidade, assinatura e crédito são configuráveis como `por empresa` ou
 * > `por unidade`."*
 *
 * ## Dois bolsos, não um recorte
 *
 * A leitura ingênua de "por unidade" é filtrar o saldo pela loja. Ela quebra no
 * dia da troca: a barbearia que passa de `empresa` para `unidade` em maio faria
 * os 300 pontos de abril sumirem, porque eles não têm loja — foram ganhos quando
 * loja não importava.
 *
 * Por isso o escopo é **congelado em cada lançamento**, como o modo desde o
 * bloco 44, e o saldo de uma loja é a soma de dois bolsos:
 *
 * - o **compartilhado**, com o que foi ganho sob `empresa` e vale em qualquer
 *   unidade;
 * - o **da loja**, com o que foi ganho sob `unidade` naquela loja.
 *
 * ## O resgate tira do compartilhado primeiro
 *
 * E é o que impede o mesmo ponto de ser gasto duas vezes. Se o resgate saísse
 * sempre do bolso da loja, um saldo compartilhado de 300 seria gasto em L1 —
 * deixando o bolso de L1 em −300 — e continuaria inteiro para gastar em L2.
 *
 * Tirando do compartilhado primeiro, o bolso que encolhe é o que todo mundo
 * enxerga. É também a ordem que o cliente espera: primeiro o que vale em toda
 * parte, depois o que só vale aqui.
 */

export const ESCOPOS = ['empresa', 'unidade'] as const;
export type EscopoMultiunidade = (typeof ESCOPOS)[number];

export const ROTULO_DO_ESCOPO: Readonly<Record<EscopoMultiunidade, string>> = {
  empresa: 'Vale em todas as unidades',
  unidade: 'Vale só na unidade onde foi ganho',
};

/** O que cada linha do razão precisa carregar para caber num bolso. */
export interface LinhaComBolso {
  readonly escopo: EscopoMultiunidade;
  readonly unidadeId: string | null;
}

/**
 * Esta linha entra no saldo desta loja?
 *
 * O compartilhado entra sempre — inclusive quando ele guarda a loja em que a
 * pessoa estava, porque ali a loja informa e não recorta. O da loja entra só na
 * sua.
 */
export function contaParaAUnidade(linha: LinhaComBolso, unidadeId: string | null): boolean {
  if (linha.escopo === 'empresa') return true;
  return linha.unidadeId !== null && linha.unidadeId === unidadeId;
}

/**
 * Separa o razão nos dois bolsos daquela loja.
 *
 * Devolve os dois para quem chama poder rodar o FIFO de vencimento **dentro de
 * cada um**: consumir a entrada mais antiga é regra do bolso, não do cliente —
 * uma saída do bolso da loja não pode comer um lote compartilhado sem que a
 * linha diga que comeu.
 */
export function separarPorBolso<T extends LinhaComBolso>(
  linhas: readonly T[],
  unidadeId: string | null,
): { readonly compartilhado: readonly T[]; readonly daUnidade: readonly T[] } {
  return {
    compartilhado: linhas.filter((l) => l.escopo === 'empresa'),
    daUnidade: linhas.filter(
      (l) => l.escopo === 'unidade' && l.unidadeId !== null && l.unidadeId === unidadeId,
    ),
  };
}

export interface DivisaoDoResgate {
  /** Quanto sai do bolso que vale em toda parte. */
  readonly doCompartilhado: number;
  /** Quanto sai do bolso desta loja. */
  readonly daUnidade: number;
}

/**
 * De onde sai um resgate, quando há dois bolsos.
 *
 * Compartilhado primeiro, sempre. Devolve zero nos dois quando o pedido não cabe
 * — e não uma divisão parcial: resgatar menos do que se pediu é decidir pelo
 * cliente que ele aceita o troco em nada, e a tela precisa dizer quanto falta.
 */
export function dividirResgate(params: {
  readonly quantidade: number;
  readonly saldoCompartilhado: number;
  readonly saldoDaUnidade: number;
}): DivisaoDoResgate | null {
  const { quantidade, saldoCompartilhado, saldoDaUnidade } = params;
  if (quantidade <= 0) return null;
  if (quantidade > saldoCompartilhado + saldoDaUnidade) return null;

  const doCompartilhado = Math.min(quantidade, saldoCompartilhado);
  return { doCompartilhado, daUnidade: quantidade - doCompartilhado };
}

/**
 * Sob qual escopo um lançamento novo nasce.
 *
 * Sai do cadastro **no momento da gravação** e é congelado ali. É a única
 * leitura do interruptor que existe: toda pergunta posterior — saldo, extrato,
 * expiração — lê o escopo da linha, nunca o do cadastro.
 *
 * Sem unidade conhecida, nasce compartilhado mesmo com o interruptor em
 * `unidade`. É o que o `CHECK` do banco também impõe, e a alternativa seria
 * recusar o acúmulo: o cliente perderia os pontos de uma venda por uma coluna
 * que ninguém preencheu.
 */
export function escopoDoLancamento(
  configurado: EscopoMultiunidade,
  unidadeId: string | null,
): EscopoMultiunidade {
  return configurado === 'unidade' && unidadeId !== null ? 'unidade' : 'empresa';
}

// ---------------------------------------------------------------------------
// O clube
// ---------------------------------------------------------------------------

/**
 * O plano cobre um atendimento nesta loja?
 *
 * A unidade da adesão existe desde o bloco 58 e é congelada. O que este bloco
 * acrescenta é o interruptor que decide se ela **restringe** ou só informa.
 *
 * Assinatura anterior ao bloco 58 tem unidade nula e é coberta em toda parte:
 * ela foi vendida quando loja não fazia parte da promessa, e recortá-la agora
 * seria tirar do assinante algo que ele já pagou.
 */
export function planoCobreNaUnidade(params: {
  readonly escopoDoPlano: EscopoMultiunidade;
  readonly unidadeDaAdesao: string | null;
  readonly unidadeDoAtendimento: string | null;
}): boolean {
  if (params.escopoDoPlano === 'empresa') return true;
  if (params.unidadeDaAdesao === null) return true;
  return params.unidadeDaAdesao === params.unidadeDoAtendimento;
}

// ---------------------------------------------------------------------------
// O fiado
// ---------------------------------------------------------------------------

export interface LinhaDoFiado {
  /** Negativo aumenta a dívida; positivo abate. Mesmo sinal do saldo. */
  readonly valorCents: number;
  readonly unidadeId: string | null;
}

/**
 * Quanto a pessoa deve **nesta loja**, quando o fiado é por unidade.
 *
 * Lançamento sem unidade — anterior a este bloco — conta em **todas** as
 * leituras: a dívida é com a barbearia, e sumir de todas seria pior que aparecer
 * em cada uma. É a mesma decisão da mensalidade do clube no bloco 58, e ela vale
 * a favor da casa: o limite fica mais apertado, não mais frouxo.
 */
export function saldoDoFiadoNaUnidade(params: {
  readonly escopo: EscopoMultiunidade;
  readonly linhas: readonly LinhaDoFiado[];
  readonly unidadeId: string | null;
}): number {
  const conta = (l: LinhaDoFiado) =>
    params.escopo === 'empresa' || l.unidadeId === null || l.unidadeId === params.unidadeId;
  return params.linhas.filter(conta).reduce((total, l) => total + l.valorCents, 0);
}
