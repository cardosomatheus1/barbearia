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

/**
 * Os pesos, e por que não são os números literais da SPEC.
 *
 * A SPEC §2.13 escreve `100 − 25 × taxa_no_show − 10 × taxa_cancelamento_tardio
 * − 2 × taxa_cancelamento_antecipado − 5 × taxa_atraso`. Taxa é fração de 0 a 1,
 * então o pior cliente possível — o que faltou em **todos** os agendamentos —
 * sai com 75. O score chamado "de 0 a 100" nunca sai da última quarta parte da
 * escala.
 *
 * Isso não é um detalhe de arredondamento: ele apaga a própria seção de uso da
 * SPEC, três linhas abaixo, na mesma página.
 *
 *     score < 60  → sinal obrigatório          ← inalcançável
 *     score < 40  → sem agendamento online     ← inalcançável
 *     score ≥ 85  → dispensa de sinal          ← alcançável com 60% de falta
 *
 * Lidos ao pé da letra, os dois primeiros são código morto e o terceiro dispensa
 * do sinal alguém que falta seis vezes em dez. O sinal seletivo — o produto
 * inteiro deste bloco — nunca seria cobrado de ninguém por histórico.
 *
 * ## O que foi mudado, e o que foi preservado
 *
 * Os pesos são multiplicados por quatro, e a âncora é o que dá nome ao número:
 * **faltar em todos os agendamentos vale zero**. Daí saem 100, 40, 8 e 20 — as
 * proporções da SPEC ficam intactas, e elas são a decisão de produto de
 * verdade: a falta pesa 12,5 vezes o cancelamento avisado, e o cancelamento em
 * cima da hora fica no meio.
 *
 * Com isto os três cortes passam a significar o que dizem: 40% de falta pede
 * sinal, 60% tira o agendamento online, e 15% já perde a dispensa.
 *
 * O bônus **não** é multiplicado. Ele não é taxa: são dez pontos somados ao
 * fim, e quadruplicá-lo deixaria dez comparecimentos seguidos apagando três
 * faltas — a fidelidade compraria o direito de faltar.
 *
 * Está escrito aqui porque é desvio deliberado do texto da SPEC, e porque a
 * próxima pessoa que comparar código e contrato vai encontrar a diferença.
 */
export const PESO_DA_FALTA = 100;
export const PESO_DO_CANCELAMENTO_TARDIO = 40;
export const PESO_DO_CANCELAMENTO_ANTECIPADO = 8;
export const PESO_DO_ATRASO = 20;
export const BONUS_DE_FIDELIDADE = 10;

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
    PESO_DA_FALTA * taxa(quantos('faltou')) -
    PESO_DO_CANCELAMENTO_TARDIO * taxa(quantos('cancelou_em_cima')) -
    PESO_DO_CANCELAMENTO_ANTECIPADO * taxa(quantos('cancelou_cedo')) -
    PESO_DO_ATRASO * taxa(atrasados) +
    (comparecimentosSeguidos(contam) >= COMPARECIMENTOS_PARA_BONUS
      ? BONUS_DE_FIDELIDADE
      : 0);

  return {
    // Arredonda no fim, uma vez: arredondar cada termo faria a soma depender da
    // ordem deles.
    score: Math.max(0, Math.min(100, Math.round(bruto))),
    considerados: total,
    temEfeito: true,
  };
}

// ---------------------------------------------------------------------------
// O que o score decide (bloco 60, SPEC §2.13 "Uso")
// ---------------------------------------------------------------------------

/**
 * O número da SPEC para recusar marcação online em hora cheia.
 *
 * Sugestão da tela, nunca padrão gravado: a coluna nasce nula, e é isso que faz
 * ligar a regra ser uma decisão de alguém em vez de um deploy.
 */
export const SCORE_SUGERIDO_PARA_BLOQUEIO = 40;

export type RecusaDeMarcacaoOnline = 'score_no_pico';

/**
 * Esta pessoa pode marcar sozinha este horário?
 *
 * > *"score < 40 → sem agendamento online em horário de pico (só recepção)"*
 *
 * ## As quatro condições, e por que todas são necessárias
 *
 * **A regra precisa estar ligada.** Nula é desligada, e é o padrão: recusar um
 * cliente é a coisa mais cara que este produto faz.
 *
 * O cliente novo está protegido **sem uma condição aqui**, e é de propósito:
 * `pontuacaoDeConfianca` devolve 100 sempre que `temEfeito` é falso, e o limiar
 * é no máximo 100 por `CHECK`. Uma checagem de `temEfeito` neste ponto seria um
 * termo que nunca varia — o defeito que o quarto termo do sinal já teve por sete
 * blocos. O que prende a regra é o teste da invariante, não uma segunda guarda.
 *
 * **A hora precisa ser de pico.** Fora dela a mesma falta custa uma cadeira que
 * estaria parada de qualquer forma — e a SPEC separa as duas de propósito.
 *
 * **O caminho precisa ser online.** A recepção marca para quem quiser: a regra
 * diz *"só recepção"*, e a leitura contrária transformaria uma restrição de
 * canal numa proibição de atendimento.
 */
export function podeMarcarOnline(pedido: {
  readonly confianca: Confiabilidade;
  /** Nulo é desligado. */
  readonly limiar: number | null;
  readonly ehHorarioDePico: boolean;
  readonly peloBalcao: boolean;
}): { readonly pode: true } | { readonly pode: false; readonly recusa: RecusaDeMarcacaoOnline } {
  if (pedido.peloBalcao) return { pode: true };
  if (pedido.limiar === null) return { pode: true };
  if (!pedido.ehHorarioDePico) return { pode: true };
  if (pedido.confianca.score >= pedido.limiar) return { pode: true };
  return { pode: false, recusa: 'score_no_pico' };
}

/**
 * Esta pessoa passa na frente **entre iguais** na lista de espera?
 *
 * Não cria fila preferencial: quem tem score alto e não cabe na vaga continua
 * não cabendo. Ordenar por confiabilidade antes de compatibilidade ofereceria a
 * vaga a quem não pode usá-la, e a oferta viraria ligação inútil — o defeito que
 * o `contains` do bloco 38 existe para fechar.
 *
 * `temEfeito` protege o cliente novo dos dois lados: ele não é punido pela falta
 * de histórico, e também não recebe prioridade por um 100 que ainda não provou.
 *
 * O limiar entra por parâmetro e **não** tem padrão aqui. `sinal.ts` já define
 * `SCORE_QUE_DISPENSA_SINAL` para a mesma fronteira da SPEC, e um segundo 85
 * escrito neste arquivo seria a lista que envelhece em silêncio: alguém mexeria
 * num e o outro continuaria dizendo outra coisa.
 */
export function temPrioridadeNaEspera(confianca: Confiabilidade, limiar: number): boolean {
  return confianca.temEfeito && confianca.score >= limiar;
}
