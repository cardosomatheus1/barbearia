import { duration, type TimeRange } from './time.js';

/**
 * A fila por prioridade da lista de espera (bloco 39, SPEC §2.9).
 *
 * ## Os dois modos, e por que só um foi construído
 *
 * A SPEC descreve **First Come** — avisa todo mundo, o primeiro a confirmar
 * leva — e **Priority Queue**, que ela marca como padrão. O primeiro converte
 * rápido e frustra: cinco pessoas recebem a mensagem, quatro descobrem que
 * perderam. Numa barbearia de bairro, essas quatro são clientes que voltam na
 * semana seguinte.
 *
 * Construir os dois seria construir um interruptor que ninguém pediu para um
 * modo que a própria SPEC não recomenda. Fica o padrão; o outro entra se alguma
 * barbearia pedir, e aí com a tela para escolher.
 *
 * ## A fórmula, e o termo que ainda não tem dado
 *
 *     score = 0.35 × aderência do horário pedido
 *           + 0.25 × recorrência histórica do cliente
 *           + 0.20 × assinatura ativa
 *           + 0.10 × reliability score
 *           + 0.10 × ordem de entrada na fila
 *
 * **Assinatura não existe no produto até o bloco 45.** O termo fica, valendo
 * zero para todo mundo — e isso é diferente de mentira: constante para todos,
 * ele não altera a ordem de ninguém, e no dia em que a assinatura existir ele
 * passa a valer exatamente o que a SPEC diz, sem retocar os outros pesos.
 *
 * Renormalizar os quatro restantes seria pior: mudaria o peso relativo da
 * aderência e da recorrência agora, e mudaria de novo no bloco 45 — duas
 * afinações silenciosas no lugar de nenhuma.
 *
 * ## Sem relógio e sem banco
 *
 * Como todo o resto de `packages/core`. O que entra são números já medidos por
 * quem leu o banco; o que sai é uma ordem.
 */

/** Os pesos da SPEC §2.9, somando 1. */
export const PESO_DA_ADERENCIA = 0.35;
export const PESO_DA_RECORRENCIA = 0.25;
export const PESO_DA_ASSINATURA = 0.2;
export const PESO_DA_CONFIABILIDADE = 0.1;
export const PESO_DA_ORDEM = 0.1;

/**
 * Visitas que valem recorrência cheia.
 *
 * Acima disso não diferencia mais: quem veio quarenta vezes e quem veio doze
 * são os dois "cliente da casa", e continuar somando faria a fila virar
 * ranking de antiguidade — o que a SPEC §4.21 recusa explicitamente noutro
 * contexto, pela mesma razão.
 */
export const VISITAS_PARA_RECORRENCIA_CHEIA = 12;

/** Quantos minutos o topo da fila tem de exclusividade (SPEC §2.9). */
export const MINUTOS_DE_JANELA_EXCLUSIVA = 10;

export interface CandidatoNaFila {
  readonly id: string;
  /** A janela que a pessoa pediu, em minutos locais. */
  readonly janelaPedida: TimeRange;
  /** Atendimentos concluídos desta pessoa nesta barbearia. */
  readonly visitas: number;
  /** Assinatura ativa. Sempre falso até o bloco 45 — ver o cabeçalho. */
  readonly assinante: boolean;
  /** 0 a 100, do bloco 37. */
  readonly confiabilidade: number;
  /** Quando entrou na lista. Só a ordem relativa importa. */
  readonly entrouEm: Date;
}

export interface PontuacaoNaFila {
  readonly id: string;
  /** 0 a 1. Não é porcentagem de nada — serve só para ordenar. */
  readonly score: number;
  /** Cada parcela, para a tela poder explicar a ordem a quem perguntar. */
  readonly parcelas: {
    readonly aderencia: number;
    readonly recorrencia: number;
    readonly assinatura: number;
    readonly confiabilidade: number;
    readonly ordem: number;
  };
}

/**
 * O quanto a vaga acerta o que a pessoa pediu.
 *
 * Uma janela pedida de 8h ao meio-dia e uma vaga às 9h acertam menos que uma
 * janela de 9h às 10h e a mesma vaga: a segunda pessoa pediu **aquilo**, a
 * primeira aceitaria qualquer coisa da manhã. Quem foi específico e teve sorte
 * é quem mais quer aquele horário.
 *
 * O valor é a razão entre o que o atendimento ocupa e a janela pedida: pedido
 * apertado tende a 1, pedido largo tende a 0. Fora da janela é zero — mas isso
 * não acontece, porque `vagaServe` já filtrou antes.
 */
export function aderencia(janelaPedida: TimeRange, duracaoMinutos: number): number {
  const largura = duration(janelaPedida);
  if (largura <= 0 || duracaoMinutos <= 0) return 0;
  return Math.min(1, duracaoMinutos / largura);
}

/**
 * Ordena os candidatos, do mais prioritário para o menos.
 *
 * `entrouEm` vira posição relativa **dentro deste conjunto**, e não idade
 * absoluta: o décimo da SPEC é "ordem de entrada na fila", e ordem é uma
 * comparação entre quem está na fila agora. Usar a idade em dias faria uma
 * entrada de ontem e uma de anteontem serem quase idênticas, e o termo deixaria
 * de desempatar — que é a única coisa que ele existe para fazer.
 *
 * O desempate final é o próprio `entrouEm`. Sem ele, dois candidatos idênticos
 * sairiam em ordem indefinida, e a mesma vaga ofereceria a pessoas diferentes
 * a cada recarga da tela.
 */
export function ordenarPorPrioridade(
  candidatos: readonly CandidatoNaFila[],
  duracaoDaVagaMinutos: number,
): readonly PontuacaoNaFila[] {
  if (candidatos.length === 0) return [];

  /**
   * Posição por **valor**, não por índice do array.
   *
   * Duas entradas com o mesmo `entrouEm` precisam receber a mesma posição. Com
   * o índice cru, quem viesse antes no array ganhava um décimo de vantagem — e
   * a ordem do array é a ordem que o banco devolveu, que não é decisão de
   * ninguém. O teste que pegou isto foi o da confiabilidade: dois candidatos
   * idênticos exceto pelo score empatavam em 0,10 contra 0,10 e a ordem saía
   * pela posição no array.
   */
  const porChegada = [...candidatos].sort(
    (a, b) => a.entrouEm.getTime() - b.entrouEm.getTime(),
  );
  const posicao = new Map<string, number>();
  let anterior: number | null = null;
  let atual = -1;
  for (const candidato of porChegada) {
    const instante = candidato.entrouEm.getTime();
    if (instante !== anterior) {
      atual += 1;
      anterior = instante;
    }
    posicao.set(candidato.id, atual);
  }
  const ultimo = Math.max(1, atual);

  const pontuados = candidatos.map((candidato) => {
    const parcelas = {
      aderencia: aderencia(candidato.janelaPedida, duracaoDaVagaMinutos),
      recorrencia: Math.min(1, candidato.visitas / VISITAS_PARA_RECORRENCIA_CHEIA),
      assinatura: candidato.assinante ? 1 : 0,
      // 0 a 100 vira 0 a 1. O score do bloco 37 já é comparável entre pessoas.
      confiabilidade: Math.min(1, Math.max(0, candidato.confiabilidade / 100)),
      // O primeiro da fila vale 1; o último, 0.
      ordem: 1 - (posicao.get(candidato.id) ?? 0) / ultimo,
    };

    const score =
      PESO_DA_ADERENCIA * parcelas.aderencia +
      PESO_DA_RECORRENCIA * parcelas.recorrencia +
      PESO_DA_ASSINATURA * parcelas.assinatura +
      PESO_DA_CONFIABILIDADE * parcelas.confiabilidade +
      PESO_DA_ORDEM * parcelas.ordem;

    return { id: candidato.id, score, parcelas };
  });

  const chegada = new Map(candidatos.map((c) => [c.id, c.entrouEm.getTime()]));
  return [...pontuados].sort(
    (a, b) => b.score - a.score || (chegada.get(a.id) ?? 0) - (chegada.get(b.id) ?? 0),
  );
}

/**
 * `aceitando` é o instante entre o resgate do convite e o agendamento existir.
 *
 * Ele não é aberto — quem chega depois já não pode resgatar — e não é terminal:
 * a marcação ainda pode falhar, e aí a oferta volta a `aberta` com o prazo
 * original. Ver a migração 0042.
 */
export type EstadoDaOferta =
  | 'aberta'
  | 'aceitando'
  | 'aceita'
  | 'vencida'
  | 'cancelada';

/**
 * A oferta ainda vale?
 *
 * Semiaberto no fim, como todo intervalo deste produto: exatamente no minuto
 * dez a janela já passou. Um segundo de tolerância aqui seria um segundo em que
 * duas pessoas poderiam marcar o mesmo horário.
 */
export function ofertaAberta(oferta: {
  readonly estado: EstadoDaOferta;
  readonly venceEm: Date;
}, agora: Date): boolean {
  return oferta.estado === 'aberta' && agora < oferta.venceEm;
}

/** Quando a janela exclusiva termina. */
export function fimDaJanelaExclusiva(oferecidaEm: Date): Date {
  return new Date(oferecidaEm.getTime() + MINUTOS_DE_JANELA_EXCLUSIVA * 60_000);
}
