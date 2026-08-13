/**
 * Insights proativos (bloco 67, SPEC §4.19).
 *
 * > *"O sistema identifica situações sem ser perguntado."*
 * > *"**Limite:** no máximo 3 insights ativos por vez, ordenados por impacto
 * > financeiro estimado. Painel com 20 alertas é painel ignorado."*
 *
 * ## O limite de três é a regra, não um detalhe de layout
 *
 * Um painel que mostra tudo o que sabe não é generoso, é inútil: quem opera
 * aprende que aquela área não pede nada e para de olhar. Três cabem numa
 * decisão de manhã. A escolha de **quais** três é a ordenação por impacto — e é
 * por isso que o impacto não pode ser um número inventado para preencher campo.
 *
 * ## O que "impacto" quer dizer aqui, e por que é sempre a mesma coisa
 *
 * É o **teto da receita que está sendo deixada na mesa** — nunca uma previsão de
 * quanto a barbearia vai ganhar. Vinte e três horários vagos com noventa e seis
 * clientes no ponto de voltar valem, no máximo, vinte e três tickets; catorze
 * pedidos de horário recusados valem, no máximo, catorze tickets.
 *
 * A alternativa seria multiplicar por uma taxa de conversão, e aí o produto
 * estaria inventando um número de marketing que ninguém pode conferir — com cara
 * de estatística, que é o pior desfecho. O teto é comparável entre tipos de
 * insight, que é tudo que a ordenação precisa, e a tela escreve "até R$ X"
 * porque teto anunciado como previsão vira promessa.
 *
 * ## Este arquivo não vai ao banco
 *
 * Ele recebe números já apurados e decide o que vira insight, com que texto e em
 * que ordem. Quem lê a agenda, a base e o caixa é a camada de cima — as três
 * moram em pacotes diferentes, e o ponto onde elas se encontram é o controller,
 * como já acontece no heatmap do bloco 57.
 */

import type { FiltroDeCampanha } from './segmento.js';

/**
 * Os tipos que existem hoje.
 *
 * A SPEC §4.19 lista três exemplos, e o terceiro — *"a pomada X deve acabar em
 * ~9 dias"* — depende da previsão de consumo, que é o bloco 69. Ele entra aqui
 * como tipo novo quando existir a previsão; declarar o tipo agora seria um
 * assunto que a tela oferece e nada preenche.
 */
export const TIPOS_DE_INSIGHT = ['hora_ociosa', 'agenda_apertada'] as const;
export type TipoDeInsight = (typeof TIPOS_DE_INSIGHT)[number];

/** Onde o botão do insight leva. A tela traduz para caminho. */
export const DESTINOS_DO_INSIGHT = ['campanha', 'jornada_do_profissional'] as const;
export type DestinoDoInsight = (typeof DESTINOS_DO_INSIGHT)[number];

export interface AcaoDoInsight {
  readonly rotulo: string;
  readonly destino: DestinoDoInsight;
  readonly parametros: Readonly<Record<string, string>>;
}

export interface Insight {
  readonly tipo: TipoDeInsight;
  readonly titulo: string;
  readonly texto: string;
  /** Teto da receita deixada na mesa, em centavos. É a chave de ordenação. */
  readonly impactoCents: number;
  readonly acao: AcaoDoInsight;
}

/** Três, da SPEC §4.19. Painel com vinte alertas é painel ignorado. */
export const MAXIMO_DE_INSIGHTS = 3;

/**
 * Quantas semanas de histórico sustentam a leitura de ocupação.
 *
 * O mesmo número do heatmap (`JANELA_DO_HEATMAP_DIAS`), e de propósito: dois
 * lugares do produto dizendo "a agenda de João está cheia" sobre janelas
 * diferentes é a mesma pessoa recebendo duas respostas para a mesma pergunta.
 */
export const SEMANAS_DA_LEITURA = 8;

export interface HoraOciosa {
  /** Vagas que o **motor** devolveu para amanhã — nunca uma segunda contagem. */
  readonly vagas: number;
  readonly primeiraHora: number;
  readonly ultimaHora: number;
  /** Quem está no ponto de voltar e não tem horário marcado. */
  readonly clientesNoPonto: number;
}

export interface AgendaApertada {
  readonly profissionalId: string;
  readonly nome: string;
  readonly ocupacaoBps: number;
  /** Pedidos de horário que viraram lista de espera por não haver vaga. */
  readonly pedidosSemVaga: number;
}

export interface DadosDoInsight {
  readonly ticketMedioCents: number;
  readonly horaOciosa: HoraOciosa | null;
  readonly apertadas: readonly AgendaApertada[];
}

/**
 * Os insights de uma barbearia, do mais caro para o mais barato.
 *
 * Insight de impacto zero **não entra**. Um cartão que diz "considere agir" sobre
 * nada é o mesmo defeito do indicador que nunca sai de `—`: ele ocupa espaço
 * prometendo uma resposta que não vem, e quem opera aprende a não olhar.
 */
export function montarInsights(
  dados: DadosDoInsight,
  limite: number = MAXIMO_DE_INSIGHTS,
): readonly Insight[] {
  const candidatos: Insight[] = [];

  const ociosa = dados.horaOciosa;
  if (ociosa && ociosa.vagas > 0 && ociosa.clientesNoPonto > 0) {
    /**
     * O teto é o **menor** dos dois lados.
     *
     * Cem clientes no ponto de voltar não valem nada se houver três vagas, e
     * trinta vagas não valem nada se não houver a quem oferecer. Multiplicar os
     * dois — ou usar só o maior — produziria um número grande que ordenaria a
     * lista errado, que é o único jeito de o limite de três atrapalhar.
     */
    const alcance = Math.min(ociosa.vagas, ociosa.clientesNoPonto);
    candidatos.push({
      tipo: 'hora_ociosa',
      titulo: `${ociosa.vagas} ${ociosa.vagas === 1 ? 'horário vago' : 'horários vagos'} amanhã`,
      texto:
        `Amanhã há ${contar(ociosa.vagas, 'horário vago', 'horários vagos')} entre ` +
        `${hora(ociosa.primeiraHora)} e ${hora(ociosa.ultimaHora)}. ` +
        `${contar(ociosa.clientesNoPonto, 'cliente está', 'clientes estão')} no ponto de voltar ` +
        `e sem horário marcado. Uma campanha para esse público pode ajudar a preencher.`,
      impactoCents: alcance * dados.ticketMedioCents,
      acao: {
        rotulo: 'Criar campanha',
        destino: 'campanha',
        /**
         * O filtro é `em_risco` — *"passou do ritmo dele"* —, e é **o mesmo**
         * público que o cartão contou.
         *
         * O tipo é `FiltroDeCampanha` de propósito: um filtro inventado aqui
         * abriria a tela de campanha num público que não existe, e o compilador
         * é quem impede. Contar de um jeito e mandar a campanha para outro
         * conjunto faria o cartão prometer noventa e seis e a campanha alcançar
         * quarenta.
         */
        parametros: { filtro: 'em_risco' satisfies FiltroDeCampanha },
      },
    });
  }

  for (const apertada of dados.apertadas) {
    if (apertada.pedidosSemVaga <= 0) continue;
    candidatos.push({
      tipo: 'agenda_apertada',
      titulo: `A agenda de ${apertada.nome} não está dando conta`,
      texto:
        `${apertada.nome} está com ${porcento(apertada.ocupacaoBps)} de ocupação nas últimas ` +
        `${SEMANAS_DA_LEITURA} semanas e ${contar(apertada.pedidosSemVaga, 'pessoa entrou', 'pessoas entraram')} ` +
        `na lista de espera por não achar horário. Considere ampliar a jornada.`,
      impactoCents: apertada.pedidosSemVaga * dados.ticketMedioCents,
      acao: {
        rotulo: 'Ver a jornada',
        destino: 'jornada_do_profissional',
        parametros: { profissionalId: apertada.profissionalId },
      },
    });
  }

  return candidatos
    .filter((i) => i.impactoCents > 0)
    /**
     * Desempate por tipo, e não pela ordem em que foram montados.
     *
     * Duas cadeiras com o mesmo número de pedidos recusados dariam o mesmo teto,
     * e a ordem da consulta decidiria qual aparece — o painel trocaria de
     * conteúdo entre dois carregamentos sem nada ter mudado.
     */
    .sort((a, b) => b.impactoCents - a.impactoCents || a.titulo.localeCompare(b.titulo, 'pt-BR'))
    .slice(0, limite);
}

const contar = (n: number, singular: string, plural: string): string =>
  `${n} ${n === 1 ? singular : plural}`;

const hora = (h: number): string => `${String(h).padStart(2, '0')}h`;

const porcento = (bps: number): string => `${Math.round(bps / 100)}%`;
