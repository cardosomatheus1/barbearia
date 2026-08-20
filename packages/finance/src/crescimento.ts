import { withTenant } from '@barbearia/db';
import {
  crescimentoDaJanela,
  serieParaTela,
  type Crescimento,
  type SerieNaTela,
} from '@barbearia/core';

/**
 * As métricas de série longa e a linha de faturamento (bloco 62).
 *
 * Fecha duas lacunas declaradas desde o bloco 35: *"as métricas que só existem
 * sobre série longa"* e *"a linha de faturamento por dia"*. Elas ficaram
 * declaradas em vez de improvisadas no painel do dia porque nenhuma delas cabe
 * num dia — retenção sobre um dia é uma pergunta sem sentido.
 *
 * ## O recorte é `business_day`, como em todo o financeiro
 *
 * `closed_at` responde "que instante"; `business_day` responde "de que dia é
 * este dinheiro" — é a decisão do bloco 19, e ela é a razão de a linha do
 * gráfico bater com o fechamento de caixa que o balcão conferiu.
 *
 * ## Nenhum laço, e uma consulta por pergunta
 *
 * Cinco perguntas diferentes sobre a mesma janela, e nenhuma delas é por
 * cliente: um `SELECT` por pessoa aqui seria o N+1 sobre a base inteira, todo
 * dia, na tela que o dono abre de manhã.
 */

export interface CrescimentoNaTela extends Crescimento {
  readonly de: string;
  readonly ate: string;
  readonly serie: SerieNaTela;
}

/**
 * Quanto tempo atrás começa a comparação de "já vinha antes".
 *
 * Uma janela de trinta dias com "já vinha antes" definido como *qualquer visita
 * anterior* incluiria quem veio uma vez, há três anos, e nunca mais — e a
 * retenção despencaria por causa de gente que a barbearia já tinha perdido antes
 * de a janela começar. O dobro da janela é o recorte: quem esteve aqui no
 * período imediatamente anterior é de quem faz sentido perguntar se voltou.
 */
const JANELAS_DE_REFERENCIA = 2;

export async function crescimentoDaCasa(params: {
  readonly tenantId: string;
  readonly de: string;
  readonly ate: string;
  readonly locationId?: string | null;
  /**
   * O abandono vem de fora, e é obrigatório no tipo.
   *
   * "Perdido" é quem passou do dobro do próprio ritmo — a definição do bloco 61,
   * que depende da mediana dos intervalos de cada pessoa e não cabe numa cláusula
   * `WHERE` sobre uma linha. Reescrevê-la em SQL aqui faria o painel do dono
   * discordar da ficha do cliente sobre a mesma pessoa (§6, pergunta 6).
   *
   * `finance` não pode depender de `crm` — a seta não existe —, então quem
   * compõe é a camada de cima, como o worker faz com `varrerRetencao`. E entra
   * **obrigatório**, não opcional: opcional, viraria zero por omissão na
   * primeira rota nova, e o indicador ficaria em `—` para sempre sem nada ficar
   * vermelho. É o defeito de `blocks` no bloco 8 e o do quarto termo do sinal no
   * bloco 39.
   */
  readonly perdidos: number;
  readonly comRitmo: number;
}): Promise<CrescimentoNaTela> {
  const { tenantId, de, ate } = params;
  const unidade = params.locationId ?? null;

  return withTenant(tenantId, async (tx) => {
    /**
     * A série diária, e o total, numa consulta.
     *
     * `business_day` já é o dia da unidade, então nada de conversão de fuso
     * aqui: quem resolveu isso foi quem gravou a venda.
     */
    const serie = await tx.$queryRaw<{ dia: Date; total: bigint }[]>`
      -- Sem a gorjeta: esta serie e comparada com a do painel e com o DRE, e
      -- tres numeros diferentes para "quanto entrou" e o defeito que a §6
      -- pergunta 6 descreve.
      SELECT o.business_day AS dia, sum(o.total_cents - o.tip_cents)::bigint AS total
        FROM orders o
       WHERE o.status = 'paid'
         AND o.business_day BETWEEN ${de}::date AND ${ate}::date
         AND (${unidade}::uuid IS NULL OR o.location_id = ${unidade}::uuid)
       GROUP BY o.business_day
       ORDER BY o.business_day
    `;

    /**
     * Retenção: de quem já vinha na janela anterior, quantos voltaram nesta.
     *
     * Os dois conjuntos saem da mesma consulta, com `FILTER`, porque separá-los
     * em duas idas ao banco deixaria a janela em que uma venda entra entre elas
     * — e a retenção passaria de 100%, que é um número impossível com cara de
     * dado.
     */
    const retencao = await tx.$queryRaw<{ ja_vinham: bigint; voltaram: bigint }[]>`
      WITH antes AS (
        SELECT DISTINCT a.customer_id
          FROM appointments a
         WHERE a.status = 'completed' AND a.customer_id IS NOT NULL
           AND a.service_starts_at >= (${de}::date
               - (${JANELAS_DE_REFERENCIA} * (${ate}::date - ${de}::date + 1)) * interval '1 day')
           AND a.service_starts_at < ${de}::date
           AND (${unidade}::uuid IS NULL OR a.location_id = ${unidade}::uuid)
      ), agora AS (
        SELECT DISTINCT a.customer_id
          FROM appointments a
         WHERE a.status = 'completed' AND a.customer_id IS NOT NULL
           AND a.service_starts_at >= ${de}::date
           AND a.service_starts_at < (${ate}::date + interval '1 day')
           AND (${unidade}::uuid IS NULL OR a.location_id = ${unidade}::uuid)
      )
      SELECT count(*)::bigint AS ja_vinham,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM agora g WHERE g.customer_id = antes.customer_id
             ))::bigint AS voltaram
        FROM antes
    `;

    /** Quantos clientes distintos pagaram alguma coisa, e quantas cadeiras giraram. */
    const contagens = await tx.$queryRaw<{ pagantes: bigint; cadeiras: bigint }[]>`
      SELECT
        (SELECT count(DISTINCT o.customer_id) FROM orders o
          WHERE o.status = 'paid' AND o.customer_id IS NOT NULL
            AND o.business_day BETWEEN ${de}::date AND ${ate}::date
            AND (${unidade}::uuid IS NULL OR o.location_id = ${unidade}::uuid))::bigint AS pagantes,
        -- Cadeira é do tipo profissional, não qualquer linha da tabela.
        --
        -- O balcão da recepção e a sala de lavatório também moram nesta tabela,
        -- e contá-los como cadeira é o defeito D12 da SPEC §1.4 — "dois dos
        -- quatro profissionais eram contas de balcão com jornada 08:00–23:00, e
        -- isso destruía qualquer relatório de ocupação". O resto do produto já
        -- filtrava; estas duas consultas não.
        (SELECT count(*) FROM professionals p
          WHERE p.active AND p.kind = 'professional'
            AND (${unidade}::uuid IS NULL OR p.location_id = ${unidade}::uuid))::bigint AS cadeiras
    `;

    /**
     * As horas de agenda aberta na janela.
     *
     * A jornada é semanal (`work_schedules`), então a conta é: para cada dia da
     * janela, some os minutos de quem trabalha naquele dia da semana. Contar
     * "horas × cadeiras × dias" com um número fixo produziria receita por hora
     * errada em toda barbearia que fecha na segunda — e todas fecham.
     *
     * Pausa é descontada: hora de almoço não é agenda aberta, e incluí-la faria
     * o indicador dizer que a casa rende menos por hora do que rende.
     */
    const horas = await tx.$queryRaw<{ minutos: bigint | null }[]>`
      SELECT sum(w.end_minute - w.start_minute - COALESCE((
               SELECT sum((b->>'end')::int - (b->>'start')::int)
                 FROM jsonb_array_elements(w.breaks) AS b
             ), 0))::bigint AS minutos
        FROM generate_series(${de}::date, ${ate}::date, interval '1 day') AS d
        JOIN work_schedules w ON w.weekday = EXTRACT(DOW FROM d)::int
        JOIN professionals p ON p.id = w.professional_id AND p.active
                            AND p.kind = 'professional'
       WHERE (${unidade}::uuid IS NULL OR p.location_id = ${unidade}::uuid)
    `;

    /**
     * Abandono: quantos, de quem tem ritmo, passaram do dobro dele.
     *
     * É a mesma definição de "perdido" do bloco 61, e ela **não** é recalculada
     * aqui em SQL — a mediana de intervalos não cabe numa cláusula sobre uma
     * linha, e escrevê-la de novo faria o painel do dono discordar da ficha do
     * cliente sobre a mesma pessoa. Quem responde é `packages/crm`, e os dois
     * números chegam por parâmetro — ver a assinatura.
     */
    const pontos = serie.map((l) => ({
      dia: l.dia.toISOString().slice(0, 10),
      valorCents: Number(l.total),
    }));
    const naTela = serieParaTela(pontos, de, ate);
    const primeira = retencao[0];
    const conta = contagens[0];

    const numeros = crescimentoDaJanela({
      voltaramNaJanela: Number(primeira?.voltaram ?? 0),
      jaVinhamAntes: Number(primeira?.ja_vinham ?? 0),
      perdidos: params.perdidos,
      comRitmo: params.comRitmo,
      receitaCents: naTela.totalCents,
      clientesQuePagaram: Number(conta?.pagantes ?? 0),
      cadeiras: Number(conta?.cadeiras ?? 0),
      horasAbertas: Number(horas[0]?.minutos ?? 0) / 60,
      dias: naTela.pontos.length,
    });

    return { ...numeros, de, ate, serie: naTela };
  });
}
