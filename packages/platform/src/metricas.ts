import { semTenant } from '@barbearia/db';
import { inteiroSeguroDoBanco } from './inteiro-seguro.js';

/**
 * As métricas globais da plataforma (bloco 25, SPEC §8 e Parte 1 §1.2).
 *
 * ## De onde cada número sai, e por que nenhum deles é estimado
 *
 * - **MRR**: soma do preço do plano das barbearias **ativas**. Não é projeção
 *   nem média: é o que a base contratada vale hoje. Conta bloqueada sai da
 *   soma no instante do bloqueio — MRR que inclui quem não paga é o número
 *   preferido de quem quer se enganar.
 * - **Churn**: `tenant_lifecycle`, que é append-only. A conta é a clássica:
 *   quem saiu no período sobre quem havia no começo dele.
 * - **Saúde e adoção**: `tenant_metrics_daily`, que cada barbearia escreve por
 *   dentro do próprio tenant (bloco 20 provou que varredura de plataforma não
 *   lê tabela com RLS). A plataforma **nunca** toca `appointments`.
 *
 * ## O que este arquivo não faz
 *
 * Nenhuma métrica por profissional. Comparar barbearias já é limítrofe;
 * comparar pessoas que trabalham em barbearias diferentes, do ponto de vista de
 * quem não é empregador de nenhuma delas, não tem finalidade legítima.
 */

/** Pontos percentuais inteiros, como as alíquotas: fração de tela é formatação. */
const emPontos = (parte: number, total: number): number =>
  total <= 0 ? 0 : Math.round((parte / total) * 100);

export interface ResumoDaPlataforma {
  /** Receita recorrente mensal contratada, em centavos. */
  readonly mrrCents: number;
  readonly barbeariasAtivas: number;
  readonly barbeariasBloqueadas: number;
  readonly semPlano: number;

  /** Quantas saíram no período e quantas entraram. */
  readonly saidasNoPeriodo: number;
  readonly entradasNoPeriodo: number;
  /** Pontos percentuais: saídas sobre o que havia no início do período. */
  readonly churnEmPontos: number;

  /** Dias considerados nas métricas de operação. */
  readonly dias: number;
  readonly agendamentos: number;
  readonly adocaoOnlineEmPontos: number;
  readonly ocupacaoEmPontos: number;
  readonly faltasEmPontos: number;
  readonly receitaCents: number;
  /**
   * A quebra do que foi **recebido**, por meio (bloco 29).
   *
   * Não fecha com `receitaCents` e não deveria: aquela é a soma das comandas
   * pagas, esta é a soma dos pagamentos lançados. A diferença é o fiado — venda
   * registrada que ainda não virou dinheiro. Somar os dois no mesmo número
   * seria contar como caixa o que ainda está para receber.
   */
  readonly recebidoPixCents: number;
  readonly recebidoCartaoCents: number;
  readonly recebidoDinheiroCents: number;
  readonly recebidoOutrosCents: number;
  /** Barbearias que apuraram pelo menos um dia no período. */
  readonly barbeariasComMovimento: number;
}

export interface SaudeDaBarbearia {
  readonly tenantId: string;
  readonly nome: string;
  readonly bloqueada: boolean;
  readonly planoCode: string | null;
  readonly agendamentos: number;
  readonly adocaoOnlineEmPontos: number;
  readonly ocupacaoEmPontos: number;
  readonly faltasEmPontos: number;
  readonly receitaCents: number;
  /** Último dia apurado. Nulo é barbearia que nunca teve movimento nenhum. */
  readonly ultimoDia: string | null;
}

interface LinhaDeResumo {
  mrr_cents: bigint;
  ativas: bigint;
  bloqueadas: bigint;
  sem_plano: bigint;
}

interface LinhaDeCiclo {
  saidas: bigint;
  entradas: bigint;
  base_inicial: bigint;
}

interface LinhaDeOperacao {
  agendamentos: bigint;
  online: bigint;
  faltas: bigint;
  minutos_vendidos: bigint;
  minutos_disponiveis: bigint;
  receita_cents: bigint;
  pix_cents: bigint;
  cartao_cents: bigint;
  dinheiro_cents: bigint;
  outros_cents: bigint;
  com_movimento: bigint;
}

/**
 * O primeiro dia da janela, contando para trás a partir de `ate`.
 *
 * Exportada porque é a mesma conta que a tela precisa para escrever "últimos 30
 * dias" sem recalcular por conta própria — e porque é pura, então tem teste sem
 * banco.
 */
export function inicioDaJanela(ate: string, dias: number): string {
  const fim = new Date(`${ate}T00:00:00Z`);
  const inicio = new Date(fim.getTime() - (dias - 1) * 86_400_000);
  return inicio.toISOString().slice(0, 10);
}

/**
 * Último dia que realmente existe no agregado diário da plataforma.
 *
 * O corte das 09:00 UTC diz qual dia **já deveria** ter sido apurado, mas o
 * worker pode atrasar ou ficar indisponível. Usar apenas o relógio faria o
 * painel apontar para um dia ainda inexistente e mostrar zeros falsos.
 * Quando a plataforma ainda não possui métrica alguma, preservamos o fallback
 * calculado pelo core para que o estado inicial continue determinístico.
 */
export async function ultimoDiaComMetricas(fallback: string): Promise<string> {
  return semTenant(async (tx) => {
    const [linha] = await tx.$queryRaw<{ ultimo_dia: Date | null }[]>`
      SELECT max(business_day) AS ultimo_dia
      FROM tenant_metrics_daily
    `;
    return linha?.ultimo_dia?.toISOString().slice(0, 10) ?? fallback;
  });
}

export async function resumoDaPlataforma(params: {
  /** Último dia da janela, YYYY-MM-DD. Parâmetro, não `now()`: o mesmo pedido tem que dar o mesmo número. */
  readonly ate: string;
  readonly dias?: number;
}): Promise<ResumoDaPlataforma> {
  const dias = Math.min(Math.max(params.dias ?? 30, 1), 365);
  const de = inicioDaJanela(params.ate, dias);

  return semTenant(async (tx) => {
    const [assinatura] = await tx.$queryRaw<LinhaDeResumo[]>`
      SELECT
        coalesce(sum(p.price_cents) FILTER (WHERE tp.blocked_at IS NULL), 0)::bigint AS mrr_cents,
        count(*) FILTER (WHERE tp.blocked_at IS NULL)::bigint AS ativas,
        count(*) FILTER (WHERE tp.blocked_at IS NOT NULL)::bigint AS bloqueadas,
        count(*) FILTER (WHERE tp.plan_id IS NULL AND tp.blocked_at IS NULL)::bigint AS sem_plano
      FROM tenant_platform tp
      LEFT JOIN plans p ON p.id = tp.plan_id
    `;

    const [ciclo] = await tx.$queryRaw<LinhaDeCiclo[]>`
      WITH janela AS (
        SELECT ${de}::date AS de, ${params.ate}::date AS ate
      ),
      dentro AS (
        SELECT
          count(*) FILTER (WHERE tl.event = 'blocked')::bigint AS saidas,
          count(*) FILTER (WHERE tl.event = 'activated')::bigint AS entradas
        FROM tenant_lifecycle tl, janela
        WHERE tl.happened_at >= janela.de
          AND tl.happened_at < janela.ate + 1
      ),
      -- O denominador do churn: quem já estava dentro quando a janela começou.
      -- Contar sobre o total de hoje daria um churn menor que o real, porque
      -- quem entrou no meio do período nunca teve chance de sair nele.
      base AS (
        SELECT count(*)::bigint AS base_inicial
        FROM tenant_platform tp, janela
        WHERE tp.created_at < janela.de
      )
      SELECT dentro.saidas, dentro.entradas, base.base_inicial FROM dentro, base
    `;

    const [operacao] = await tx.$queryRaw<LinhaDeOperacao[]>`
      SELECT
        coalesce(sum(m.appointments_total), 0)::bigint AS agendamentos,
        coalesce(sum(m.appointments_online), 0)::bigint AS online,
        coalesce(sum(m.no_shows), 0)::bigint AS faltas,
        coalesce(sum(m.minutes_sold), 0)::bigint AS minutos_vendidos,
        coalesce(sum(m.minutes_available), 0)::bigint AS minutos_disponiveis,
        coalesce(sum(m.revenue_cents), 0)::bigint AS receita_cents,
        coalesce(sum(m.revenue_pix_cents), 0)::bigint AS pix_cents,
        coalesce(sum(m.revenue_card_cents), 0)::bigint AS cartao_cents,
        coalesce(sum(m.revenue_cash_cents), 0)::bigint AS dinheiro_cents,
        coalesce(sum(m.revenue_other_cents), 0)::bigint AS outros_cents,
        count(DISTINCT m.tenant_id) FILTER (WHERE m.appointments_total > 0)::bigint AS com_movimento
      FROM tenant_metrics_daily m
      WHERE m.business_day BETWEEN ${de}::date AND ${params.ate}::date
    `;

    const agendamentos = inteiroSeguroDoBanco(operacao?.agendamentos, 'agendamentos da plataforma');
    const baseInicial = inteiroSeguroDoBanco(ciclo?.base_inicial, 'base inicial da plataforma');

    return {
      mrrCents: inteiroSeguroDoBanco(assinatura?.mrr_cents, 'MRR da plataforma'),
      barbeariasAtivas: Number(assinatura?.ativas ?? 0),
      barbeariasBloqueadas: Number(assinatura?.bloqueadas ?? 0),
      semPlano: Number(assinatura?.sem_plano ?? 0),

      saidasNoPeriodo: Number(ciclo?.saidas ?? 0),
      entradasNoPeriodo: Number(ciclo?.entradas ?? 0),
      churnEmPontos: emPontos(Number(ciclo?.saidas ?? 0), baseInicial),

      dias,
      agendamentos,
      adocaoOnlineEmPontos: emPontos(Number(operacao?.online ?? 0), agendamentos),
      ocupacaoEmPontos: emPontos(
        Number(operacao?.minutos_vendidos ?? 0),
        Number(operacao?.minutos_disponiveis ?? 0),
      ),
      faltasEmPontos: emPontos(Number(operacao?.faltas ?? 0), agendamentos),
      receitaCents: inteiroSeguroDoBanco(operacao?.receita_cents, 'receita da plataforma'),
      recebidoPixCents: inteiroSeguroDoBanco(operacao?.pix_cents, 'receita Pix da plataforma'),
      recebidoCartaoCents: inteiroSeguroDoBanco(operacao?.cartao_cents, 'receita cartão da plataforma'),
      recebidoDinheiroCents: inteiroSeguroDoBanco(operacao?.dinheiro_cents, 'receita em dinheiro da plataforma'),
      recebidoOutrosCents: inteiroSeguroDoBanco(operacao?.outros_cents, 'outras receitas da plataforma'),
      barbeariasComMovimento: Number(operacao?.com_movimento ?? 0),
    };
  });
}

interface LinhaDeSaude {
  tenant_id: string;
  name: string;
  blocked_at: Date | null;
  plan_code: string | null;
  agendamentos: bigint;
  online: bigint;
  faltas: bigint;
  minutos_vendidos: bigint;
  minutos_disponiveis: bigint;
  receita_cents: bigint;
  ultimo_dia: Date | null;
}

/**
 * Uma linha por barbearia, ordenada por quem tem menos movimento primeiro.
 *
 * A ordem não é estética. Quem está prestes a cancelar não manda e-mail: ele
 * simplesmente para de usar, e a lista ordenada por faturamento — que é a
 * ordenação natural de quem construiu o painel — colocaria essa barbearia no
 * fim, onde ninguém rola.
 *
 * Uma consulta só, com `LEFT JOIN` sobre o agregado. Buscar as barbearias e
 * depois as métricas de cada uma seria o N+1 exato que a regra proíbe, e ele
 * cresce com o tamanho da base — ou seja, piora justamente quando o negócio vai
 * bem.
 */
export async function saudeDasBarbearias(params: {
  readonly ate: string;
  readonly dias?: number;
}): Promise<readonly SaudeDaBarbearia[]> {
  const dias = Math.min(Math.max(params.dias ?? 30, 1), 365);
  const de = inicioDaJanela(params.ate, dias);

  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<LinhaDeSaude[]>`
      SELECT tp.tenant_id, tp.name, tp.blocked_at, p.code AS plan_code,
             coalesce(m.agendamentos, 0)::bigint AS agendamentos,
             coalesce(m.online, 0)::bigint AS online,
             coalesce(m.faltas, 0)::bigint AS faltas,
             coalesce(m.minutos_vendidos, 0)::bigint AS minutos_vendidos,
             coalesce(m.minutos_disponiveis, 0)::bigint AS minutos_disponiveis,
             coalesce(m.receita_cents, 0)::bigint AS receita_cents,
             m.ultimo_dia
      FROM tenant_platform tp
      LEFT JOIN plans p ON p.id = tp.plan_id
      LEFT JOIN (
        SELECT tenant_id,
               sum(appointments_total) AS agendamentos,
               sum(appointments_online) AS online,
               sum(no_shows) AS faltas,
               sum(minutes_sold) AS minutos_vendidos,
               sum(minutes_available) AS minutos_disponiveis,
               sum(revenue_cents) AS receita_cents,
               max(business_day) FILTER (WHERE appointments_total > 0) AS ultimo_dia
        FROM tenant_metrics_daily
        WHERE business_day BETWEEN ${de}::date AND ${params.ate}::date
        GROUP BY tenant_id
      ) m ON m.tenant_id = tp.tenant_id
      ORDER BY coalesce(m.agendamentos, 0), tp.name
    `;

    return linhas.map((l) => {
      const agendamentos = Number(l.agendamentos);
      return {
        tenantId: l.tenant_id,
        nome: l.name,
        bloqueada: l.blocked_at !== null,
        planoCode: l.plan_code,
        agendamentos,
        adocaoOnlineEmPontos: emPontos(Number(l.online), agendamentos),
        ocupacaoEmPontos: emPontos(Number(l.minutos_vendidos), Number(l.minutos_disponiveis)),
        faltasEmPontos: emPontos(Number(l.faltas), agendamentos),
        receitaCents: inteiroSeguroDoBanco(l.receita_cents, `receita de ${l.name}`),
        ultimoDia: l.ultimo_dia ? l.ultimo_dia.toISOString().slice(0, 10) : null,
      };
    });
  });
}
