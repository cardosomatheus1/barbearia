import { semTenant } from '@barbearia/db';

/**
 * A linha do tempo da plataforma (bloco 62, lacuna do bloco 27).
 *
 * > *"já existe: MRR, churn, adoção, ocupação e falta apurados dia a dia por
 * > barbearia, com janela de 7, 30 ou 90 dias. falta: a linha do tempo — MRR mês
 * > a mês, safra de entrada, curva de retenção."*
 *
 * A diferença entre o que já existia e isto é a pergunta que cada um responde.
 * A janela de 90 dias responde *"como estamos agora"*; a linha do tempo responde
 * *"estamos melhorando?"* — e as duas podem discordar sem nenhuma estar errada.
 *
 * ## Safra, e por que ela não é um recorte de data qualquer
 *
 * Uma safra é o conjunto de barbearias que **entraram no mesmo mês**, seguido ao
 * longo do tempo. É a única leitura que separa "o produto está retendo melhor"
 * de "entrou muita gente nova": uma retenção global sobe sozinha num mês de
 * muitas assinaturas novas, porque ninguém cancela no primeiro mês.
 *
 * ## Sem RLS, de propósito
 *
 * `semTenant`, como todo `packages/platform`: quem lê é o Super Admin, e a
 * pergunta é sobre a base inteira. Nenhuma rota de barbearia chega aqui — a
 * separação é o `PlataformaGuard`, não a política do Postgres.
 */

export interface MesDoMrr {
  /** `YYYY-MM`, o mês de competência. */
  readonly mes: string;
  readonly mrrCents: number;
  readonly barbeariasPagantes: number;
}

export interface SafraDeEntrada {
  /** O mês em que estas barbearias assinaram. */
  readonly safra: string;
  readonly entraram: number;
  /**
   * Quantas continuavam pagando em cada mês seguinte, do mês 0 em diante.
   *
   * O índice é a distância em meses desde a entrada, e o mês 0 é sempre igual a
   * `entraram` — ele fica na série de propósito: uma curva que começa no mês 1
   * esconde a base de comparação, e o leitor tem que confiar que o 100% existiu.
   */
  readonly retidas: readonly number[];
}

export interface LinhaDoTempoDaPlataforma {
  readonly mrr: readonly MesDoMrr[];
  readonly safras: readonly SafraDeEntrada[];
  readonly maiorMrrCents: number;
}

/** Quantos meses a linha do tempo cobre. */
export const MESES_DA_LINHA = 12;

/**
 * O MRR mês a mês e as safras de entrada.
 *
 * `agora` entra por parâmetro pela razão de sempre: a linha do tempo é uma
 * função do relógio, e ler `now()` no banco tornaria o resultado impossível de
 * testar sem esperar o tempo passar.
 */
/**
 * Quantos meses da safra já aconteceram, contando o próprio mês de entrada.
 *
 * É o que separa "todas saíram" de "ainda não chegou" no triângulo: sem ele, a
 * cauda de uma safra morta some da tela e vira boa notícia.
 */
function mesesAte(safra: string, agora: Date): number {
  const [ano, mes] = safra.split('-').map(Number);
  if (!ano || !mes) return 0;
  const meses =
    (agora.getUTCFullYear() - ano) * 12 + (agora.getUTCMonth() + 1 - mes);
  return Math.max(0, meses + 1);
}

export async function linhaDoTempoDaPlataforma(
  agora: Date = new Date(),
  meses: number = MESES_DA_LINHA,
): Promise<LinhaDoTempoDaPlataforma> {
  return semTenant(async (tx) => {
    /**
     * Um mês conta como pago quando houve **fatura paga** com competência nele.
     *
     * Não é o preço do plano vigente multiplicado por quem está ativo hoje: esse
     * número reescreveria o passado toda vez que alguém mudasse de plano ou
     * cancelasse. O MRR de março é o que de fato foi cobrado e pago em março, e
     * ele não muda mais — é a mesma decisão da comissão fechada e da taxa do
     * adquirente congelada na venda.
     */
    const mrr = await tx.$queryRaw<{ mes: string; total: bigint; quantas: bigint }[]>`
      SELECT to_char(date_trunc('month', i.period_start), 'YYYY-MM') AS mes,
             sum(i.amount_cents)::bigint AS total,
             count(DISTINCT i.tenant_id)::bigint AS quantas
        FROM invoices i
       WHERE i.status = 'paid' AND i.kind = 'subscription'
         AND i.period_start >= date_trunc('month', ${agora}::timestamptz)
             - ((${meses} - 1) * interval '1 month')
         AND i.period_start < date_trunc('month', ${agora}::timestamptz) + interval '1 month'
       GROUP BY 1
       ORDER BY 1
    `;

    /**
     * As safras, numa consulta.
     *
     * `generate_series` produz os meses de acompanhamento, e o `LEFT JOIN` com a
     * fatura paga daquele mês responde se a barbearia ainda estava lá. Um laço
     * em JavaScript por safra × mês seria uma ida ao banco por célula do
     * triângulo — cento e quarenta e quatro consultas para desenhar uma tela.
     */
    const safras = await tx.$queryRaw<
      { safra: string; distancia: number; quantas: bigint }[]
    >`
      WITH entrada AS (
        SELECT i.tenant_id,
               date_trunc('month', min(i.period_start)) AS mes_de_entrada
          FROM invoices i
         WHERE i.status = 'paid' AND i.kind = 'subscription'
         GROUP BY i.tenant_id
        HAVING date_trunc('month', min(i.period_start))
               >= date_trunc('month', ${agora}::timestamptz)
                  - ((${meses} - 1) * interval '1 month')
      )
      SELECT to_char(e.mes_de_entrada, 'YYYY-MM') AS safra,
             (EXTRACT(YEAR FROM age(m.mes, e.mes_de_entrada)) * 12
              + EXTRACT(MONTH FROM age(m.mes, e.mes_de_entrada)))::int AS distancia,
             count(DISTINCT e.tenant_id)::bigint AS quantas
        FROM entrada e
        CROSS JOIN LATERAL generate_series(
          e.mes_de_entrada,
          date_trunc('month', ${agora}::timestamptz),
          interval '1 month'
        ) AS m(mes)
       WHERE EXISTS (
         SELECT 1 FROM invoices i
          WHERE i.tenant_id = e.tenant_id
            AND i.status = 'paid' AND i.kind = 'subscription'
            AND date_trunc('month', i.period_start) = m.mes
       )
       GROUP BY 1, 2
       ORDER BY 1, 2
    `;

    const porSafra = new Map<string, number[]>();
    for (const linha of safras) {
      const atual = porSafra.get(linha.safra) ?? [];
      atual[linha.distancia] = Number(linha.quantas);
      porSafra.set(linha.safra, atual);
    }

    return {
      mrr: mrr.map((l) => ({
        mes: l.mes,
        mrrCents: Number(l.total),
        barbeariasPagantes: Number(l.quantas),
      })),
      safras: [...porSafra.entries()]
        .map(([safra, retidas]) => ({
          safra,
          entraram: retidas[0] ?? 0,
          /**
           * O buraco vira zero, e a **cauda** também.
           *
           * Um mês em que nenhuma barbearia da safra pagou é um zero de verdade
           * — todas saíram —, e um vetor esparso desenharia a célula vazia como
           * se o dado não existisse. São coisas diferentes, e a segunda é a que
           * o dono da plataforma precisa ver.
           *
           * O comprimento vinha do **último mês com retenção**, e por isso o
           * zero só valia para buraco no meio: a safra que perdeu a última
           * barbearia em novembro terminava o vetor ali, e a tela desenhava os
           * meses seguintes como "ainda não aconteceu". O dono lia a pior safra
           * da história como a que ainda não maturou.
           *
           * A distância até o mês corrente é o comprimento certo: o que ainda
           * não chegou continua fora do vetor, e o que chegou e deu zero
           * aparece como zero. O teste que existia provava só o buraco interior.
           */
          retidas: Array.from(
            { length: Math.max(retidas.length, mesesAte(safra, agora)) },
            (_, i) => retidas[i] ?? 0,
          ),
        }))
        .sort((a, b) => a.safra.localeCompare(b.safra)),
      maiorMrrCents: mrr.reduce((m, l) => Math.max(m, Number(l.total)), 0),
    };
  });
}
