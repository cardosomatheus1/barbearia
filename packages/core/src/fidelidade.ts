/**
 * Fidelidade: pontos, visitas ou cashback (bloco 41, SPEC §4.8).
 *
 * ## Um modelo, nunca três
 *
 * A SPEC é explícita e o motivo é o cliente: "você tem 340 pontos, 3 visitas e
 * R$ 12 de cashback" é uma frase que ninguém entende no balcão. O modelo é uma
 * escolha da barbearia, e o schema a impõe — uma linha de programa por
 * barbearia, com o modo dentro.
 *
 * ## Por que o extrato é um livro-razão, e não um saldo
 *
 * Saldo é um número que alguém sobrescreve. A pergunta que a barbearia recebe é
 * "por que caiu?", e um número não responde. Cada acúmulo, resgate, expiração e
 * ajuste é uma linha append-only; o saldo é derivado. É a mesma decisão do
 * extrato do cliente e da comissão.
 *
 * ## Por que o modo é congelado em cada lançamento
 *
 * A barbearia troca de pontos para cashback em maio. As linhas de abril
 * continuam sendo pontos — reinterpretá-las com a regra nova transformaria 300
 * pontos em R$ 300 de crédito. O modo mora na linha, e o programa só diz o que
 * vale de hoje em diante.
 *
 * ## A unidade depende do modo, e por isso ela é escrita
 *
 * `pontos` conta pontos, `visitas` conta visitas, `cashback` conta **centavos**.
 * Um `amount` sem unidade seria a origem exata do erro que este arquivo existe
 * para evitar.
 */

import type { EscopoMultiunidade } from './compartilhado.js';

export const MODOS_DE_FIDELIDADE = ['nenhum', 'pontos', 'visitas', 'cashback'] as const;
export type ModoDeFidelidade = (typeof MODOS_DE_FIDELIDADE)[number];

export const ROTULO_DO_MODO: Readonly<Record<ModoDeFidelidade, string>> = {
  nenhum: 'Sem programa',
  pontos: 'Pontos',
  visitas: 'Visitas',
  cashback: 'Cashback',
};

/** Como o saldo é dito para o cliente. Plural incluído: "1 visita", "3 visitas". */
export function saldoPorExtenso(modo: ModoDeFidelidade, saldo: number): string {
  if (modo === 'cashback') return `R$ ${(saldo / 100).toFixed(2).replace('.', ',')}`;
  if (modo === 'visitas') return saldo === 1 ? '1 visita' : `${saldo} visitas`;
  return saldo === 1 ? '1 ponto' : `${saldo} pontos`;
}

export interface ProgramaDeFidelidade {
  readonly modo: ModoDeFidelidade;
  /** Pontos por real gasto. A SPEC sugere 1, e a barbearia decide. */
  readonly pontosPorReal: number;
  /**
   * Quanto vale um ponto na hora do resgate, em centavos.
   *
   * Precisa existir e não pode ser 1 ponto = R$ 1: com "R$ 1 = 1 ponto" na
   * entrada, isso devolveria cem por cento do que a pessoa gastou. O padrão de
   * um centavo dá o 1% que a fidelidade por pontos costuma valer no mercado, e
   * a barbearia sobe se quiser.
   */
  readonly valorDoPontoCents: number;
  /** "A cada 10 cortes, 1 grátis" — o 10. */
  readonly visitasParaPremio: number;
  /** 5% = 500. Pontos-base inteiros, nunca fração. */
  readonly cashbackBps: number;
  /** Dias até vencer. Nulo é "não vence", e é uma escolha legítima. */
  readonly validadeDias: number | null;
  /**
   * Onde o saldo vale (bloco 59).
   *
   * `empresa` é o comportamento anterior e o padrão — a regra deste projeto para
   * configuração que mexe em dinheiro. Ele decide apenas sob qual escopo os
   * lançamentos **novos** nascem: o saldo já ganho lê o escopo da própria linha,
   * e por isso trocar o interruptor não faz ponto nenhum sumir.
   */
  readonly escopo: EscopoMultiunidade;
}

export const PROGRAMA_DESLIGADO: ProgramaDeFidelidade = {
  modo: 'nenhum',
  pontosPorReal: 1,
  valorDoPontoCents: 1,
  visitasParaPremio: 10,
  cashbackBps: 500,
  validadeDias: null,
  escopo: 'empresa',
};

export type TipoDeLancamento = 'acumulo' | 'resgate' | 'expiracao' | 'ajuste';

export interface LancamentoDeFidelidade {
  readonly id: string;
  readonly tipo: TipoDeLancamento;
  /** Com sinal. Positivo entra, negativo sai. A unidade é a do modo. */
  readonly quantidade: number;
  readonly venceEm: Date | null;
  readonly criadoEm: Date;
}

export interface AcumuloDaVenda {
  readonly quantidade: number;
  readonly baseCents: number;
}

/**
 * O que esta venda gera.
 *
 * ## O bloqueio anti-laço, que a SPEC pede em uma linha
 *
 * "Bloqueio de acúmulo sobre item já resgatado (evita loop)." Sem ele, o corte
 * grátis gera pontos que compram o próximo corte grátis, e o programa vira uma
 * máquina de fabricar crédito a partir de nada.
 *
 * A tradução é diferente por modo, e é de propósito:
 *
 * - **pontos e cashback** acumulam sobre o que a pessoa **pagou de verdade**.
 *   Resgatar R$ 2 numa conta de R$ 50 ainda é uma compra de R$ 48, e ela conta.
 * - **visitas** só não contam quando o resgate cobriu a conta **inteira**. Um
 *   corte pago com R$ 2 de crédito continua sendo uma visita — a pessoa veio,
 *   sentou e pagou. O que não pode contar é o corte grátis empurrando o
 *   contador para o corte grátis seguinte.
 *
 * Gorjeta fica de fora da base nos dois casos: ela é do barbeiro, não da casa,
 * e premiar o cliente por ela seria a barbearia pagando fidelidade com dinheiro
 * que não é dela.
 */
export function acumuloDaVenda(params: {
  readonly programa: ProgramaDeFidelidade;
  /** Total pago à casa, já sem gorjeta e sem troco. */
  readonly totalCents: number;
  /** Quanto desse total saiu do próprio saldo de fidelidade. */
  readonly resgatadoCents: number;
}): AcumuloDaVenda | null {
  const { programa } = params;
  if (programa.modo === 'nenhum') return null;

  const baseCents = Math.max(0, params.totalCents - params.resgatadoCents);

  if (programa.modo === 'visitas') {
    // Conta inteira paga com crédito é o corte grátis: ele não empurra o
    // contador para o próximo corte grátis.
    if (params.totalCents > 0 && baseCents === 0) return null;
    if (params.totalCents <= 0) return null;
    return { quantidade: 1, baseCents };
  }

  if (baseCents <= 0) return null;

  if (programa.modo === 'cashback') {
    // Arredonda para baixo: o centavo da dúvida fica com quem correu o risco de
    // abrir a barbearia, e o cliente nunca vê crédito que não existe.
    const centavos = Math.floor((baseCents * programa.cashbackBps) / 10_000);
    return centavos > 0 ? { quantidade: centavos, baseCents } : null;
  }

  const pontos = Math.floor((baseCents / 100) * programa.pontosPorReal);
  return pontos > 0 ? { quantidade: pontos, baseCents } : null;
}

/** Quando o que foi acumulado hoje vence. Nulo quando o programa não expira. */
export function vencimentoDoAcumulo(
  programa: ProgramaDeFidelidade,
  agora: Date,
): Date | null {
  if (programa.validadeDias === null) return null;
  return new Date(agora.getTime() + programa.validadeDias * 86_400_000);
}

interface Lote {
  readonly lancamento: LancamentoDeFidelidade;
  restante: number;
}

/**
 * Consome as saídas contra as entradas, da mais antiga para a mais nova.
 *
 * FIFO e não LIFO: o que está para vencer sai primeiro, que é o que o cliente
 * espera e o que impede o produto de deixar vencer saldo que ele podia ter
 * usado. É a mesma ordem de qualquer estoque perecível.
 */
function lotes(lancamentos: readonly LancamentoDeFidelidade[]): readonly Lote[] {
  const ordenados = [...lancamentos].sort(
    (a, b) => a.criadoEm.getTime() - b.criadoEm.getTime(),
  );

  const entradas: Lote[] = [];
  for (const lancamento of ordenados) {
    if (lancamento.quantidade > 0) {
      entradas.push({ lancamento, restante: lancamento.quantidade });
      continue;
    }

    let aConsumir = -lancamento.quantidade;
    for (const lote of entradas) {
      if (aConsumir === 0) break;
      const tirado = Math.min(lote.restante, aConsumir);
      lote.restante -= tirado;
      aConsumir -= tirado;
    }
  }

  return entradas;
}

/**
 * O saldo que a pessoa pode usar agora.
 *
 * Exclui o que já venceu **mesmo que a varredura ainda não tenha rodado**, pela
 * mesma razão do convite de vaga do bloco 39: mostrar o valor gravado faria a
 * tela oferecer um resgate que a gravação vai recusar.
 */
export function saldoDisponivel(
  lancamentos: readonly LancamentoDeFidelidade[],
  agora: Date,
): number {
  return lotes(lancamentos)
    .filter((lote) => lote.lancamento.venceEm === null || lote.lancamento.venceEm > agora)
    .reduce((total, lote) => total + lote.restante, 0);
}

/**
 * O que a varredura precisa gravar como expirado.
 *
 * Zero quando não há nada vencido — e a varredura não escreve linha de zero,
 * porque extrato com movimento nulo é extrato que ninguém consegue ler.
 */
export function quantidadeAExpirar(
  lancamentos: readonly LancamentoDeFidelidade[],
  agora: Date,
): number {
  const jaExpirado = lancamentos
    .filter((l) => l.tipo === 'expiracao')
    .reduce((total, l) => total - l.quantidade, 0);

  const vencido = lotes(lancamentos)
    .filter((lote) => lote.lancamento.venceEm !== null && lote.lancamento.venceEm <= agora)
    .reduce((total, lote) => total + lote.restante, 0);

  return Math.max(0, vencido - jaExpirado);
}

/**
 * Quanto de dinheiro este resgate vale.
 *
 * `visitas` é o único que não converte quantidade em valor: o prêmio é um corte
 * grátis, e quanto ele vale depende do que está na comanda. Quem sabe isso é o
 * balcão, não este arquivo — por isso o teto entra por parâmetro.
 */
export function valorDoResgate(params: {
  readonly programa: ProgramaDeFidelidade;
  readonly quantidade: number;
  /** O que ainda falta pagar. O resgate nunca passa disso. */
  readonly tetoCents: number;
}): number {
  const { programa, quantidade, tetoCents } = params;
  if (quantidade <= 0 || tetoCents <= 0) return 0;

  if (programa.modo === 'cashback') return Math.min(quantidade, tetoCents);
  if (programa.modo === 'pontos') {
    return Math.min(quantidade * programa.valorDoPontoCents, tetoCents);
  }
  if (programa.modo === 'visitas') {
    // Um prêmio por vez. Dois cortes grátis na mesma comanda não é o que "a cada
    // dez cortes, um grátis" quer dizer, e seria o jeito mais rápido de zerar um
    // saldo acumulado em um ano.
    return quantidade >= programa.visitasParaPremio ? tetoCents : 0;
  }
  return 0;
}

export type RecusaDeResgate =
  | 'sem_programa'
  | 'saldo_insuficiente'
  | 'nada_a_pagar'
  | 'quantidade_invalida'
  | 'premio_incompleto';

/**
 * O resgate pode acontecer?
 *
 * Resgate parcial é requisito da SPEC, e por isso não há piso em pontos nem em
 * cashback: quem tem 40 pontos usa os 40. `visitas` é a exceção, e ela é da
 * própria regra — meio corte grátis não existe.
 */
export function podeResgatar(params: {
  readonly programa: ProgramaDeFidelidade;
  readonly saldo: number;
  readonly quantidade: number;
  readonly tetoCents: number;
}): { readonly aceito: true } | { readonly aceito: false; readonly recusa: RecusaDeResgate } {
  const { programa, saldo, quantidade, tetoCents } = params;

  if (programa.modo === 'nenhum') return { aceito: false, recusa: 'sem_programa' };
  if (!Number.isInteger(quantidade) || quantidade <= 0) {
    return { aceito: false, recusa: 'quantidade_invalida' };
  }
  if (tetoCents <= 0) return { aceito: false, recusa: 'nada_a_pagar' };
  if (quantidade > saldo) return { aceito: false, recusa: 'saldo_insuficiente' };
  if (programa.modo === 'visitas' && quantidade !== programa.visitasParaPremio) {
    return { aceito: false, recusa: 'premio_incompleto' };
  }
  return { aceito: true };
}

/**
 * Quanto a pessoa pode resgatar de uma vez, para a tela sugerir.
 *
 * Sugerir o máximo é o certo: quem chega ao balcão com saldo quer usá-lo, e
 * fazer a recepção calcular de cabeça quantos pontos cabem em R$ 37 é como o
 * programa deixa de ser usado.
 */
export function resgateSugerido(params: {
  readonly programa: ProgramaDeFidelidade;
  readonly saldo: number;
  readonly tetoCents: number;
}): number {
  const { programa, saldo, tetoCents } = params;
  if (programa.modo === 'nenhum' || saldo <= 0 || tetoCents <= 0) return 0;

  if (programa.modo === 'visitas') {
    return saldo >= programa.visitasParaPremio ? programa.visitasParaPremio : 0;
  }
  if (programa.modo === 'cashback') return Math.min(saldo, tetoCents);

  const cabem = Math.floor(tetoCents / Math.max(1, programa.valorDoPontoCents));
  return Math.min(saldo, cabem);
}
