/**
 * O heatmap de ocupação (bloco 57, SPEC §5.9).
 *
 * > *"Célula fria é clicável e vira campanha direcionada — o heatmap não é
 * > relatório, é ponto de partida de ação."*
 *
 * É a frase que decide a forma deste arquivo. Um relatório devolveria
 * percentuais e pronto; o que ele devolve é **a célula**, com o que ela é e o
 * que dá para fazer com ela. As duas pontas desta grade eram lacunas
 * declaradas: a célula fria vira público de campanha, e a célula cheia é o
 * `horario_de_pico` que faltava ao sinal seletivo desde o bloco 39.
 *
 * ## Por que é lógica pura
 *
 * A grade é uma divisão: minutos vendidos sobre minutos de jornada, por hora e
 * por dia da semana. Quem carrega os dois números é o repositório; quem decide
 * o que é frio, o que é cheio e o que é pico é este arquivo — sem banco, sem
 * relógio e com o fuso entrando por parâmetro, como o resto de `core`.
 */

export interface CelulaDeOcupacao {
  /** 0 = domingo, como `Date.getDay()` e como o resto do produto. */
  readonly diaDaSemana: number;
  /** A hora local da unidade, de 0 a 23. */
  readonly hora: number;
  readonly minutosVendidos: number;
  readonly minutosDeJornada: number;
}

export const FAIXAS_DE_OCUPACAO = ['fechado', 'fria', 'morna', 'cheia'] as const;
export type FaixaDeOcupacao = (typeof FAIXAS_DE_OCUPACAO)[number];

export const ROTULO_DA_FAIXA: Readonly<Record<FaixaDeOcupacao, string>> = {
  fechado: 'Fechado',
  fria: 'Vazio',
  morna: 'Média',
  cheia: 'Cheio',
};

/**
 * Os dois cortes que separam frio, morno e cheio.
 *
 * 35% e 75%, e os números têm motivo. Abaixo de 35% a cadeira passa a maior
 * parte da hora parada — é a faixa que justifica gastar mensagem para encher.
 * Acima de 75% a hora está praticamente vendida: é onde o cliente novo que
 * falta custa o horário de alguém que viria, que é o que o sinal existe para
 * conter.
 *
 * A faixa do meio é grande de propósito. Uma barbearia normal vive nela, e
 * empurrá-la para um dos lados faria a tela pedir ação sobre o que está certo.
 */
export const CORTE_FRIO_BPS = 3500;
export const CORTE_CHEIO_BPS = 7500;

/** A ocupação da célula em pontos-base, ou `null` quando a casa está fechada. */
export function ocupacaoDaCelula(celula: CelulaDeOcupacao): number | null {
  /**
   * Fechado não é zero por cento.
   *
   * Zero diria "esta hora está vazia, faça algo" sobre uma hora em que a
   * barbearia não abre — e é exatamente a célula que mais apareceria em
   * vermelho num heatmap ingênuo. Divisão por zero devolve `null`, como toda
   * divisão de relatório deste produto.
   */
  if (celula.minutosDeJornada <= 0) return null;
  /**
   * Teto em 100%, e o motivo é o que a pessoa faz com o número (bloco 101).
   *
   * Vender mais minutos do que a jornada tem é normal e não é erro: o
   * agendamento que começa às 8h50 e termina às 9h20 entra inteiro nas duas
   * horas, e três cadeiras numa hora de duas dão 150%. Mas "104% de ocupação"
   * não quer dizer nada para quem lê — e joga dúvida sobre a grade inteira, que
   * é o preço de mostrar um número que não se pode explicar.
   *
   * Cem por cento é a frase honesta: aquela hora está cheia. Quem precisa saber
   * *quanto* passou olha a agenda, não o mapa de calor.
   */
  const bruto = Math.round((celula.minutosVendidos / celula.minutosDeJornada) * 10_000);
  return Math.min(bruto, 10_000);
}

export function faixaDaCelula(celula: CelulaDeOcupacao): FaixaDeOcupacao {
  const bps = ocupacaoDaCelula(celula);
  if (bps === null) return 'fechado';
  if (bps < CORTE_FRIO_BPS) return 'fria';
  if (bps < CORTE_CHEIO_BPS) return 'morna';
  return 'cheia';
}

export interface CelulaNaTela extends CelulaDeOcupacao {
  readonly ocupacaoBps: number | null;
  readonly faixa: FaixaDeOcupacao;
}

/**
 * A grade inteira, hora × dia da semana.
 *
 * As horas vazias **entram** na grade: uma tabela que pula as horas sem
 * movimento faz a coluna de sábado ter sete linhas e a de terça ter três, e a
 * leitura vira comparação impossível. O que a hora fechada mostra é "fechado",
 * não um buraco.
 */
export function montarGrade(
  celulas: readonly CelulaDeOcupacao[],
  horas: readonly number[],
): readonly CelulaNaTela[] {
  const porChave = new Map(celulas.map((c) => [`${c.diaDaSemana}:${c.hora}`, c]));
  const grade: CelulaNaTela[] = [];

  for (let dia = 0; dia < 7; dia += 1) {
    for (const hora of horas) {
      const achada = porChave.get(`${dia}:${hora}`) ?? {
        diaDaSemana: dia,
        hora,
        minutosVendidos: 0,
        minutosDeJornada: 0,
      };
      grade.push({
        ...achada,
        ocupacaoBps: ocupacaoDaCelula(achada),
        faixa: faixaDaCelula(achada),
      });
    }
  }
  return grade;
}

/**
 * As horas em que a casa abre, para a grade não ter linha morta.
 *
 * Derivadas do que a barbearia de fato vende, e não de 0 a 23: uma grade com
 * vinte e quatro linhas em que dezoito dizem "fechado" é uma tela que ninguém
 * lê. Quando não há movimento nenhum, devolve a faixa comercial — a tela
 * precisa desenhar alguma coisa no primeiro dia de uso.
 */
export function horasDaGrade(celulas: readonly CelulaDeOcupacao[]): readonly number[] {
  const abertas = celulas.filter((c) => c.minutosDeJornada > 0).map((c) => c.hora);
  if (abertas.length === 0) return [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const menor = Math.min(...abertas);
  const maior = Math.max(...abertas);
  return Array.from({ length: maior - menor + 1 }, (_, i) => menor + i);
}

// ---------------------------------------------------------------------------
// O horário de pico
// ---------------------------------------------------------------------------

export interface HoraDePico {
  readonly diaDaSemana: number;
  readonly hora: number;
}

/**
 * Quais horas são de pico, para o sinal seletivo.
 *
 * Era lacuna declarada desde o bloco 39: *"não existe horário de pico no
 * produto — nem coluna, nem cálculo de demanda, nem tela onde a barbearia diga
 * quais são as suas horas cheias. Escrevê-lo agora criaria um parâmetro que
 * ninguém preenche"*. A saída não foi criar o parâmetro: foi **derivá-lo do
 * movimento medido**, que é o que o heatmap passou a produzir.
 *
 * O dono não adivinha nada, e a definição não pode ser burlada por engano —
 * duas coisas que uma caixa de seleção não daria.
 */
export function horasDePico(grade: readonly CelulaNaTela[]): readonly HoraDePico[] {
  return grade
    .filter((c) => c.faixa === 'cheia')
    .map((c) => ({ diaDaSemana: c.diaDaSemana, hora: c.hora }));
}

/**
 * Este instante cai num horário de pico?
 *
 * O dia e a hora vêm **locais da unidade**, nunca do processo: é a mesma regra
 * da grade e da janela de silêncio. Errar o fuso aqui cobraria sinal de quem
 * marcou às nove da manhã de terça porque no servidor era meio-dia.
 */
export function ehHorarioDePico(params: {
  readonly picos: readonly HoraDePico[];
  readonly diaDaSemanaLocal: number;
  readonly horaLocal: number;
}): boolean {
  return params.picos.some(
    (p) => p.diaDaSemana === params.diaDaSemanaLocal && p.hora === params.horaLocal,
  );
}

/**
 * As células frias, que viram público de campanha.
 *
 * Ordenadas da mais vazia para a menos: é a ordem em que o dono quer atacar, e
 * uma lista por dia da semana faria ele procurar. Hora fechada não entra — não
 * há o que encher.
 */
export function celulasFrias(grade: readonly CelulaNaTela[]): readonly CelulaNaTela[] {
  return grade
    .filter((c) => c.faixa === 'fria')
    .slice()
    .sort((a, b) => (a.ocupacaoBps ?? 0) - (b.ocupacaoBps ?? 0));
}

export const NOME_DO_DIA: readonly string[] = [
  'Domingo',
  'Segunda',
  'Terça',
  'Quarta',
  'Quinta',
  'Sexta',
  'Sábado',
];

/** `Terça, 14h` — como a tela e a campanha se referem à mesma célula. */
export function nomeDaCelula(celula: { readonly diaDaSemana: number; readonly hora: number }): string {
  return `${NOME_DO_DIA[celula.diaDaSemana] ?? '?'}, ${String(celula.hora).padStart(2, '0')}h`;
}
