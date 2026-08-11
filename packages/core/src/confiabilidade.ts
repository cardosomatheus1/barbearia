/**
 * O score de confiabilidade do cliente (SPEC §2.13).
 *
 * Um número de 0 a 100 por cliente **e por barbearia**, que responde a uma
 * pergunta só: vale pedir sinal desta pessoa? Ele existe para que a barbearia
 * não precise escolher entre cobrar de todo mundo — o que espanta cliente novo —
 * e não cobrar de ninguém, o que deixa a agenda exposta.
 *
 * ## Ele pune falta, não cancelamento
 *
 * A diferença é o produto inteiro. Um cancelamento com antecedência é receita
 * recuperável: a vaga volta para a grade e a fila preenche. Uma falta é perda
 * total — a cadeira ficou parada e ninguém foi avisado.
 *
 * Por isso o peso da falta é doze vezes o do cancelamento avisado. Punir quem
 * avisa ensina a **não avisar**, e quem não avisa vira falta. O score seria
 * então a causa do problema que ele mede.
 *
 * ## Nunca é mostrado ao cliente
 *
 * Regra 5 da SPEC, e ela é de produto, não de tela: score visível vira
 * constrangimento e reclamação no balcão. Ele decide se o sinal é pedido; o
 * cliente vê o sinal, nunca o número.
 *
 * ## Sem relógio dentro
 *
 * `agora` entra por parâmetro, como todo o resto de `packages/core`. A janela de
 * doze meses é recortada por quem chama, e o mesmo histórico produz sempre o
 * mesmo score — inclusive num teste que roda em outro fuso.
 */

/** O que aconteceu com um agendamento passado, do ponto de vista do score. */
export type DesfechoDoAgendamento =
  | 'compareceu'
  | 'faltou'
  | 'cancelou_cedo'
  | 'cancelou_em_cima'
  | 'cancelado_pela_casa';

export interface AgendamentoNoHistorico {
  /** Quando o serviço começaria. Define a ordem e a janela. */
  readonly comecariaEm: Date;
  readonly desfecho: DesfechoDoAgendamento;
  /** Minutos de atraso na chegada. Nulo quando não houve chegada registrada. */
  readonly atrasoMinutos: number | null;
}

/**
 * A antecedência que separa "avisou em cima da hora" de "avisou".
 *
 * Quatro horas é o número da SPEC. Ele não é arbitrário: abaixo disso a vaga
 * dificilmente é revendida no mesmo dia, então o cancelamento passa a custar
 * como falta.
 */
export const HORAS_DE_CANCELAMENTO_TARDIO = 4;

/** Acima disto a chegada conta como atraso relevante (SPEC §2.13). */
export const MINUTOS_DE_ATRASO_RELEVANTE = 10;

/** Abaixo disto o score não tem efeito nenhum — regra de justiça 4. */
export const MINIMO_DE_HISTORICO = 3;

/** Comparecimentos seguidos que valem o bônus. */
export const COMPARECIMENTOS_PARA_BONUS = 10;

/** A janela móvel. Quem faltou há mais de um ano e voltou recupera tudo. */
export const MESES_DA_JANELA = 12;

export interface Confiabilidade {
  /** 0 a 100. Sempre 100 para quem não tem histórico suficiente. */
  readonly score: number;
  /** Quantos agendamentos entraram na conta. */
  readonly considerados: number;
  /**
   * Se o score já pode decidir alguma coisa.
   *
   * Falso com menos de três agendamentos — e aí o score é 100 por presunção de
   * boa-fé, não por mérito. Quem consome precisa saber a diferença: cobrar sinal
   * de quem "tem 100" e de quem "ainda não tem histórico" são decisões
   * diferentes, e a segunda é justamente a que espanta cliente novo.
   */
  readonly temEfeito: boolean;
}

/**
 * Recorta a janela de doze meses.
 *
 * Fora daqui a lista inteira entraria na conta, e a regra de justiça 6 —
 * "recuperável" — deixaria de valer: quem faltou uma vez em 2019 carregaria
 * aquilo para sempre.
 */
export function dentroDaJanela(
  historico: readonly AgendamentoNoHistorico[],
  agora: Date,
): readonly AgendamentoNoHistorico[] {
  const limite = new Date(agora);
  limite.setUTCMonth(limite.getUTCMonth() - MESES_DA_JANELA);
  return historico.filter((a) => a.comecariaEm >= limite && a.comecariaEm <= agora);
}

/**
 * Comparecimentos seguidos, contados do mais recente para trás.
 *
 * Qualquer coisa que não seja comparecimento interrompe — **menos** o
 * cancelamento da casa, que a regra 3 manda ignorar por inteiro. Se a barbearia
 * fechou por um imprevisto, isso não pode custar o bônus do cliente.
 */
function comparecimentosSeguidos(historico: readonly AgendamentoNoHistorico[]): number {
  const doMaisNovo = [...historico].sort(
    (a, b) => b.comecariaEm.getTime() - a.comecariaEm.getTime(),
  );

  let seguidos = 0;
  for (const agendamento of doMaisNovo) {
    if (agendamento.desfecho === 'cancelado_pela_casa') continue;
    if (agendamento.desfecho !== 'compareceu') break;
    seguidos += 1;
  }
  return seguidos;
}

/**
 * O score, na janela.
 *
 * ## A faixa entre 4h e 24h, e por que a fórmula literal da SPEC não entra
 *
 * A SPEC escreve dois termos de cancelamento: −10 para o tardio (menos de 4h) e
 * −2 para o antecipado (24h ou mais). O que ela não diz é o que acontece entre
 * os dois — e ler ao pé da letra produziria um degrau perverso: cancelar com 23h
 * de antecedência sairia **de graça** e cancelar com 25h custaria 2 pontos.
 * Quem entendesse a regra aprenderia a esperar o relógio passar de 24h para
 * cancelar, que é o oposto de avisar cedo.
 *
 * Aqui o corte é um só: menos de 4h pesa −10, o resto pesa −2. A intenção da
 * SPEC — "cancelamento antecipado quase não pune" — fica intacta, e some o
 * degrau. Está escrito porque é desvio deliberado do texto, não descuido.
 */
export function pontuacaoDeConfianca(
  historico: readonly AgendamentoNoHistorico[],
  agora: Date,
): Confiabilidade {
  const janela = dentroDaJanela(historico, agora);

  // Regra 3: o cancelamento da casa não conta nem no numerador nem no
  // denominador. Deixá-lo no denominador diluiria a taxa de falta do cliente —
  // a barbearia melhoraria o score de quem falta só por ter fechado um dia.
  const contam = janela.filter((a) => a.desfecho !== 'cancelado_pela_casa');
  const total = contam.length;

  // Regra 1 e 4: cliente novo começa em 100, e o score só decide alguma coisa a
  // partir de três agendamentos. Presunção de boa-fé para quem ainda não tem
  // história — o produto não pode punir por ausência de dado.
  if (total < MINIMO_DE_HISTORICO) {
    return { score: 100, considerados: total, temEfeito: false };
  }

  const quantos = (desfecho: DesfechoDoAgendamento) =>
    contam.filter((a) => a.desfecho === desfecho).length;

  const atrasados = contam.filter(
    (a) => a.atrasoMinutos !== null && a.atrasoMinutos > MINUTOS_DE_ATRASO_RELEVANTE,
  ).length;

  const taxa = (n: number) => n / total;

  const bruto =
    100 -
    25 * taxa(quantos('faltou')) -
    10 * taxa(quantos('cancelou_em_cima')) -
    2 * taxa(quantos('cancelou_cedo')) -
    5 * taxa(atrasados) +
    (comparecimentosSeguidos(contam) >= COMPARECIMENTOS_PARA_BONUS ? 10 : 0);

  return {
    // Arredonda no fim, uma vez: arredondar cada termo faria a soma depender da
    // ordem deles.
    score: Math.max(0, Math.min(100, Math.round(bruto))),
    considerados: total,
    temEfeito: true,
  };
}
