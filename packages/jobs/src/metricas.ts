import { semTenant, withTenant } from '@barbearia/db';

/**
 * A apuração diária de cada barbearia.
 *
 * ## Por que ela roda **dentro** do tenant
 *
 * A pergunta do Super Admin é global ("como vai a plataforma?"), mas os dados
 * são de cada barbearia e estão atrás da RLS. A tentação é uma varredura sem
 * tenant no contexto — e o bloco 20 já provou que ela não funciona: a primeira
 * versão da falta automática era exatamente isso e devolvia zero linhas.
 *
 * Então é uma tarefa por barbearia, com `withTenant`, gravando um agregado na
 * tabela de plataforma. A plataforma lê o agregado; nunca `appointments`.
 *
 * ## Por que o dia é parâmetro
 *
 * Reapurar o mesmo dia tem que dar o mesmo resultado, e um dia velho precisa
 * poder ser refeito quando o worker fica parado. `now()` dentro da consulta
 * tornaria a apuração irrepetível — e um número de negócio que muda ao ser
 * recalculado não serve para decidir nada.
 */

/**
 * Canais em que **o cliente** marcou, contra os que a recepção digitou.
 *
 * A lista é explícita e não uma negação de 'reception'/'professional': canal
 * novo (bloco 55 traz o WhatsApp de verdade) tem que ser classificado por quem
 * o adiciona, não cair em "online" por omissão e inflar a adoção sozinho.
 */
const CANAIS_DO_CLIENTE = [
  'website',
  'app',
  'whatsapp',
  'instagram',
  'google',
  'marketplace',
] as const;

export interface DiaApurado {
  readonly agendamentos: number;
  readonly online: number;
  readonly faltas: number;
  readonly cancelamentos: number;
  readonly concluidos: number;
  readonly minutosVendidos: number;
  readonly minutosDisponiveis: number;
  readonly receitaCents: number;
  readonly comandasPagas: number;
  /** A quebra por meio (bloco 29). Não fecha com a receita quando há fiado. */
  readonly receitaPixCents: number;
  readonly receitaCartaoCents: number;
  readonly receitaDinheiroCents: number;
  readonly receitaOutrosCents: number;
}

interface LinhaApurada {
  agendamentos: bigint;
  online: bigint;
  faltas: bigint;
  cancelamentos: bigint;
  concluidos: bigint;
  minutos_vendidos: bigint;
  minutos_disponiveis: bigint;
  receita_cents: bigint;
  comandas_pagas: bigint;
  receita_pix_cents: bigint;
  receita_cartao_cents: bigint;
  receita_dinheiro_cents: bigint;
  receita_outros_cents: bigint;
}

/**
 * Apura um dia e grava o agregado.
 *
 * Uma consulta só, com CTEs. Três consultas separadas seriam três idas ao banco
 * por barbearia por dia — o mesmo N+1 que a regra proíbe, só que disfarçado de
 * "são só três".
 *
 * O dia de cada agendamento sai do fuso da **unidade** dele, não do processo:
 * uma barbearia em Rio Branco e outra em Salvador fecham o mesmo dia com duas
 * horas de diferença, e o servidor não fica em nenhuma das duas.
 */
export async function apurarDiaDaBarbearia(
  tenantId: string,
  dia: string,
): Promise<DiaApurado> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<LinhaApurada[]>`
      WITH alvo AS (SELECT ${dia}::date AS d),
      ags AS (
        SELECT
          count(*)::bigint AS agendamentos,
          count(*) FILTER (WHERE a.source::text = ANY(${[...CANAIS_DO_CLIENTE]}))::bigint AS online,
          count(*) FILTER (WHERE a.status = 'no_show')::bigint AS faltas,
          count(*) FILTER (
            WHERE a.status IN ('cancelled_customer', 'cancelled_business')
          )::bigint AS cancelamentos,
          count(*) FILTER (WHERE a.status = 'completed')::bigint AS concluidos,
          coalesce(sum(
            EXTRACT(EPOCH FROM (a.ends_at - a.starts_at)) / 60
          ) FILTER (
            WHERE a.status NOT IN ('cancelled_customer', 'cancelled_business', 'no_show')
          ), 0)::bigint AS minutos_vendidos
        FROM appointments a
        JOIN locations l ON l.id = a.location_id
        CROSS JOIN alvo
        WHERE (a.starts_at AT TIME ZONE l.timezone)::date = alvo.d
      ),
      cap AS (
        -- Mesma conta que o painel do dono (packages/finance/src/painel.ts):
        -- pausa não é descontada. Divergir aqui faria a ocupação que a
        -- plataforma vê discordar da que o dono vê, e a discussão seria sobre
        -- qual número está certo em vez de sobre a barbearia.
        SELECT coalesce(sum(ws.end_minute - ws.start_minute), 0)::bigint AS minutos
        FROM work_schedules ws
        JOIN professionals p ON p.id = ws.professional_id
        CROSS JOIN alvo
        WHERE p.active AND p.kind = 'professional'
          AND ws.weekday = EXTRACT(DOW FROM alvo.d)
      ),
      vendas AS (
        -- Sem a gorjeta, como o painel e o DRE: o total e subtotal menos
        -- desconto mais gorjeta, e a gorjeta atravessa a casa a caminho do
        -- barbeiro. Este numero e o que a plataforma usa para dizer como a
        -- barbearia vai, e nele a gorjeta e receita de outra pessoa.
        SELECT count(*)::bigint AS comandas,
               coalesce(sum(o.total_cents - o.tip_cents), 0)::bigint AS cents
        FROM orders o
        CROSS JOIN alvo
        WHERE o.status = 'paid' AND o.business_day = alvo.d
      ),
      -- A quebra por meio de pagamento (bloco 29).
      --
      -- Sai de order_payments e não de orders: a comanda pode ser paga em dois
      -- meios, e somar o total no meio "principal" inventaria um número. Ela
      -- nao fecha com a receita por duas razoes, e as duas sao assim de
      -- proposito: o fiado e venda registrada e nao dinheiro recebido, e a
      -- gorjeta e dinheiro recebido que nao e receita da casa.
      meios AS (
        SELECT
          coalesce(sum(op.amount_cents) FILTER (WHERE op.method = 'pix'), 0)::bigint AS pix,
          coalesce(sum(op.amount_cents) FILTER (
            WHERE op.method IN ('debit', 'credit')
          ), 0)::bigint AS cartao,
          coalesce(sum(op.amount_cents) FILTER (WHERE op.method = 'cash'), 0)::bigint AS dinheiro,
          coalesce(sum(op.amount_cents) FILTER (
            WHERE op.method IN ('link', 'transfer', 'fiado')
          ), 0)::bigint AS outros
        FROM order_payments op
        JOIN orders o ON o.id = op.order_id
        CROSS JOIN alvo
        WHERE o.status = 'paid' AND o.business_day = alvo.d
      )
      SELECT ags.agendamentos, ags.online, ags.faltas, ags.cancelamentos, ags.concluidos,
             ags.minutos_vendidos, cap.minutos AS minutos_disponiveis,
             vendas.cents AS receita_cents, vendas.comandas AS comandas_pagas,
             meios.pix AS receita_pix_cents, meios.cartao AS receita_cartao_cents,
             meios.dinheiro AS receita_dinheiro_cents, meios.outros AS receita_outros_cents
      FROM ags, cap, vendas, meios
    `;

    const l = linhas[0];
    const apurado: DiaApurado = {
      agendamentos: Number(l?.agendamentos ?? 0),
      online: Number(l?.online ?? 0),
      faltas: Number(l?.faltas ?? 0),
      cancelamentos: Number(l?.cancelamentos ?? 0),
      concluidos: Number(l?.concluidos ?? 0),
      minutosVendidos: Number(l?.minutos_vendidos ?? 0),
      minutosDisponiveis: Number(l?.minutos_disponiveis ?? 0),
      receitaCents: Number(l?.receita_cents ?? 0),
      comandasPagas: Number(l?.comandas_pagas ?? 0),
      receitaPixCents: Number(l?.receita_pix_cents ?? 0),
      receitaCartaoCents: Number(l?.receita_cartao_cents ?? 0),
      receitaDinheiroCents: Number(l?.receita_dinheiro_cents ?? 0),
      receitaOutrosCents: Number(l?.receita_outros_cents ?? 0),
    };

    await tx.$executeRaw`
      INSERT INTO tenant_metrics_daily (
        tenant_id, business_day, appointments_total, appointments_online,
        no_shows, cancellations, completed, minutes_sold, minutes_available,
        revenue_cents, orders_paid,
        revenue_pix_cents, revenue_card_cents, revenue_cash_cents, revenue_other_cents,
        computed_at
      ) VALUES (
        ${tenantId}::uuid, ${dia}::date, ${apurado.agendamentos}, ${apurado.online},
        ${apurado.faltas}, ${apurado.cancelamentos}, ${apurado.concluidos},
        ${apurado.minutosVendidos}, ${apurado.minutosDisponiveis},
        ${apurado.receitaCents}, ${apurado.comandasPagas},
        ${apurado.receitaPixCents}, ${apurado.receitaCartaoCents},
        ${apurado.receitaDinheiroCents}, ${apurado.receitaOutrosCents}, now()
      )
      ON CONFLICT (tenant_id, business_day) DO UPDATE SET
        appointments_total = EXCLUDED.appointments_total,
        appointments_online = EXCLUDED.appointments_online,
        no_shows = EXCLUDED.no_shows,
        cancellations = EXCLUDED.cancellations,
        completed = EXCLUDED.completed,
        minutes_sold = EXCLUDED.minutes_sold,
        minutes_available = EXCLUDED.minutes_available,
        revenue_cents = EXCLUDED.revenue_cents,
        orders_paid = EXCLUDED.orders_paid,
        revenue_pix_cents = EXCLUDED.revenue_pix_cents,
        revenue_card_cents = EXCLUDED.revenue_card_cents,
        revenue_cash_cents = EXCLUDED.revenue_cash_cents,
        revenue_other_cents = EXCLUDED.revenue_other_cents,
        computed_at = EXCLUDED.computed_at
    `;

    return apurado;
  });
}

/**
 * Enfileira a apuração do dia para **todas** as barbearias, de uma vez.
 *
 * Este é o único ponto do produto que fala de todas as barbearias de dentro da
 * fila, e ele consegue por um motivo específico: as duas tabelas envolvidas —
 * `tenant_platform` e `jobs` — não escondem nada atrás de tenant. A primeira é
 * de plataforma por desenho (migração 0026); a segunda nunca teve RLS, e é por
 * isso que o `payload` guarda id e nunca conteúdo.
 *
 * Um `INSERT ... SELECT`, não um laço com uma transação por barbearia. Com mil
 * contas, o laço seriam mil transações para agendar trabalho que ainda nem
 * começou — o N+1 da regra, na hora mais barata de evitá-lo.
 *
 * Barbearia bloqueada fica de fora: ela não atende, então não há dia a apurar, e
 * apurar zeros todo dia poluiria a série de quem um dia voltar.
 *
 * A chave de idempotência traz o `tenant_id` porque o índice de `jobs` é
 * **global**, não por barbearia — as chaves que já existem só não colidem por
 * carregarem um UUID de agendamento. Uma chave de dia sem o tenant deixaria
 * exatamente uma barbearia ser apurada por dia, e o `ON CONFLICT DO NOTHING`
 * engoliria as outras mil em silêncio.
 */
export async function agendarApuracaoDeTodas(params: {
  readonly dia: string;
  readonly quando?: Date;
}): Promise<number> {
  return semTenant(async (tx) =>
    tx.$executeRaw`
      INSERT INTO jobs (tenant_id, kind, payload, run_after, idempotency_key, max_attempts)
      SELECT tp.tenant_id, 'metricas.dia',
             ${JSON.stringify({ dia: params.dia })}::jsonb,
             ${params.quando ?? new Date()},
             'metricas:' || tp.tenant_id::text || ':' || ${params.dia},
             5
      FROM tenant_platform tp
      WHERE tp.blocked_at IS NULL
      ON CONFLICT DO NOTHING
    `,
  );
}

/** A hora, em UTC, a partir da qual o dia anterior já acabou no Brasil inteiro. */
export const HORA_DA_APURACAO_UTC = 9;

/**
 * Que dia apurar, e a partir de quando.
 *
 * Pura de propósito — recebe o instante em vez de perguntar as horas. É o que
 * permite testar o caso que importa sem esperar a virada do dia.
 *
 * O dia é o anterior em UTC, e a espera existe pelo fuso: às 00:05 UTC ainda
 * são 21:05 do **mesmo** dia em Salvador, e apurar ali cortaria o movimento da
 * noite. Às 9h UTC são 4h da manhã até em Rio Branco (UTC-5), o ponto mais a
 * oeste do Brasil — o dia anterior acabou em todas as unidades.
 */
export function apuracaoPendente(agora: Date): { readonly dia: string; readonly quando: Date } {
  const ontem = new Date(Date.UTC(
    agora.getUTCFullYear(),
    agora.getUTCMonth(),
    agora.getUTCDate() - 1,
  ));
  const quando = new Date(Date.UTC(
    agora.getUTCFullYear(),
    agora.getUTCMonth(),
    agora.getUTCDate(),
    HORA_DA_APURACAO_UTC,
  ));

  return { dia: ontem.toISOString().slice(0, 10), quando };
}
