/**
 * As métricas que só existem sobre série longa (bloco 62, lacuna do bloco 35).
 *
 * O painel do dia responde o que se responde com o movimento de hoje: quantos
 * atenderam, quanto entrou, quantos faltaram. Estas são outras — nenhuma delas
 * cabe num dia, e é por isso que ficaram declaradas como lacuna desde o bloco 35
 * em vez de serem improvisadas ali.
 *
 * ## Todas derivadas, nenhuma gravada
 *
 * Mesma decisão do DRE, do saldo de estoque e do segmento. Uma tabela
 * `metricas_de_crescimento` seria um número que alguém sobrescreve, e a pergunta
 * que chega nunca é "quanto deu", é *"por que caiu?"*.
 *
 * ## Nenhuma divisão devolve infinito
 *
 * É a regra do bloco 55: `null`, nunca `Infinity`. "Retenção de ∞%" é o que
 * apareceria em toda barbearia no primeiro mês — justamente quando o dono abre o
 * relatório pela primeira vez.
 */

/** Uma divisão que sabe não ter resposta. */
export function razao(numerador: number, denominador: number): number | null {
  if (denominador <= 0) return null;
  return numerador / denominador;
}

/** Em pontos-base inteiros, como toda alíquota deste código. */
export function razaoBps(numerador: number, denominador: number): number | null {
  const r = razao(numerador, denominador);
  return r === null ? null : Math.round(r * 10_000);
}

export interface EntradaDeCrescimento {
  /** Clientes que já vinham antes da janela e voltaram dentro dela. */
  readonly voltaramNaJanela: number;
  /** Clientes que já vinham antes da janela — o denominador da retenção. */
  readonly jaVinhamAntes: number;
  /** Quantos passaram do dobro do próprio ritmo. Vem do bloco 61. */
  readonly perdidos: number;
  /** Toda a base com histórico suficiente para ter ritmo. */
  readonly comRitmo: number;
  /** Receita paga na janela, em centavos. */
  readonly receitaCents: number;
  /** Clientes distintos que pagaram alguma coisa na janela. */
  readonly clientesQuePagaram: number;
  /** Cadeiras ativas — profissionais, não unidades. */
  readonly cadeiras: number;
  /** Horas de agenda aberta na janela. */
  readonly horasAbertas: number;
  readonly dias: number;
}

export interface Crescimento {
  /** Quantos dos que já vinham voltaram, em pontos-base. Nulo sem base. */
  readonly retencaoBps: number | null;
  /** Quantos dos que tinham ritmo passaram do dobro dele, em pontos-base. */
  readonly churnBps: number | null;
  /**
   * O quanto um cliente vale, em centavos.
   *
   * É **valor por cliente na janela**, e o nome diz isso: não é o LTV clássico,
   * que projeta a vida inteira a partir de uma taxa de churn estimada. Chamar de
   * LTV um gasto médio de noventa dias seria o defeito que o bloco 55 nomeia —
   * nome de indicador é o que o número **é**, não o que soa melhor.
   */
  readonly valorPorClienteCents: number | null;
  readonly receitaPorCadeiraCents: number | null;
  readonly receitaPorHoraCents: number | null;
}

export function crescimentoDaJanela(entrada: EntradaDeCrescimento): Crescimento {
  return {
    retencaoBps: razaoBps(entrada.voltaramNaJanela, entrada.jaVinhamAntes),
    churnBps: razaoBps(entrada.perdidos, entrada.comRitmo),
    valorPorClienteCents:
      entrada.clientesQuePagaram > 0
        ? Math.round(entrada.receitaCents / entrada.clientesQuePagaram)
        : null,
    receitaPorCadeiraCents:
      entrada.cadeiras > 0 ? Math.round(entrada.receitaCents / entrada.cadeiras) : null,
    receitaPorHoraCents:
      entrada.horasAbertas > 0 ? Math.round(entrada.receitaCents / entrada.horasAbertas) : null,
  };
}

/**
 * O sentido de cada indicador, para a seta da tela apontar a coisa certa.
 *
 * O bloco 55 já aprendeu isto no comparativo do DRE: despesa que sobe é piora,
 * receita que sobe é melhora, e uma seta verde para cima em "Comissões" é a tela
 * dizendo o contrário do número. Churn é o caso aqui — subir é ruim.
 */
export const SUBIR_E_BOM: Readonly<Record<keyof Crescimento, boolean>> = {
  retencaoBps: true,
  churnBps: false,
  valorPorClienteCents: true,
  receitaPorCadeiraCents: true,
  receitaPorHoraCents: true,
};

export const ROTULO_DO_CRESCIMENTO: Readonly<Record<keyof Crescimento, string>> = {
  retencaoBps: 'Retenção',
  churnBps: 'Abandono',
  valorPorClienteCents: 'Valor por cliente',
  receitaPorCadeiraCents: 'Receita por cadeira',
  receitaPorHoraCents: 'Receita por hora aberta',
};

/**
 * O que cada um quer dizer, em português do balcão.
 *
 * Pelo mesmo motivo do segmento: um indicador sem critério ao lado é um número
 * que o dono aprende a não olhar, e "Retenção 62%" não diz de quem nem de quando.
 */
export const EXPLICACAO_DO_CRESCIMENTO: Readonly<Record<keyof Crescimento, string>> = {
  retencaoBps: 'De quem já era cliente antes desta janela, quantos voltaram dentro dela.',
  churnBps: 'De quem tem ritmo conhecido, quantos passaram do dobro dele sem voltar.',
  valorPorClienteCents: 'Quanto cada cliente que pagou alguma coisa deixou na janela.',
  receitaPorCadeiraCents: 'A receita da janela dividida pelas cadeiras que trabalharam.',
  receitaPorHoraCents: 'A receita da janela dividida pelas horas de agenda aberta.',
};

/**
 * Um ponto de uma série diária.
 *
 * `dia` é o dia **da unidade**, como `orders.business_day` desde o bloco 19:
 * "que instante" e "de que dia é este dinheiro" são perguntas diferentes.
 */
export interface PontoDaSerie {
  readonly dia: string;
  readonly valorCents: number;
}

export interface SerieNaTela {
  readonly pontos: readonly PontoDaSerie[];
  readonly maximoCents: number;
  readonly totalCents: number;
  /** A média diária, para a linha de referência. Nula quando não há dia nenhum. */
  readonly mediaCents: number | null;
}

/**
 * Prepara a série para desenhar, **sem** inventar os dias que faltam.
 *
 * Dia sem venda entra com zero em vez de sumir. Uma linha que pula o domingo
 * desenha a semana com seis pontos igualmente espaçados, e o gráfico passa a
 * mentir sobre o ritmo do movimento — o vale de segunda-feira aparece como se
 * fosse a continuação natural do sábado.
 */
export function serieParaTela(
  pontos: readonly PontoDaSerie[],
  primeiroDia: string,
  ultimoDia: string,
): SerieNaTela {
  const porDia = new Map(pontos.map((p) => [p.dia, p.valorCents]));
  const cheios: PontoDaSerie[] = [];

  for (const dia of diasEntre(primeiroDia, ultimoDia)) {
    cheios.push({ dia, valorCents: porDia.get(dia) ?? 0 });
  }

  const total = cheios.reduce((s, p) => s + p.valorCents, 0);
  return {
    pontos: cheios,
    maximoCents: cheios.reduce((m, p) => Math.max(m, p.valorCents), 0),
    totalCents: total,
    mediaCents: cheios.length > 0 ? Math.round(total / cheios.length) : null,
  };
}

/**
 * Os dias de um intervalo, inclusive nas duas pontas.
 *
 * Aritmética de `Date` em UTC e não em fuso local: as datas aqui já são o dia da
 * unidade, resolvido no banco. Somar vinte e quatro horas num `Date` local
 * pularia ou repetiria um dia no horário de verão, que este produto não tem hoje
 * e teve até 2019.
 */
export function diasEntre(primeiro: string, ultimo: string): readonly string[] {
  const dias: string[] = [];
  const fim = Date.parse(`${ultimo}T00:00:00Z`);
  let atual = Date.parse(`${primeiro}T00:00:00Z`);

  /**
   * Data ilegível sai vazia sem precisar de guarda, e a guarda foi removida.
   *
   * `NaN <= fim` é falso, então o laço não roda — e um `if (Number.isNaN(...))`
   * antes dele era código que nenhuma mutação conseguia deixar vermelho. Termo
   * que não varia ou é entregue ou é removido; o teste continua, porque o que
   * ele documenta é o **comportamento**, não a linha.
   *
   * O teto abaixo é outra coisa e não é redundante: ele existe para uma janela
   * absurda mas legível — "de hoje até 2099" — não virar um laço de trinta mil
   * voltas montando um vetor que ninguém vai desenhar.
   */
  let guarda = 0;
  while (atual <= fim && guarda < 1000) {
    dias.push(new Date(atual).toISOString().slice(0, 10));
    atual += 86_400_000;
    guarda += 1;
  }
  return dias;
}
