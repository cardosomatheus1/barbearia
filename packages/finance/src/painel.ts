import { withTenant, type TransactionClient } from '@barbearia/db';
import { ticketMedio, variacao } from '@barbearia/core';

/**
 * O painel do proprietário — SPEC §5.9.
 *
 * > "Toda métrica traz comparação com o período anterior. **Número sem
 * > comparação não gera decisão.**"
 *
 * É a mesma ideia do ritmo da meta no bloco 17, aplicada à casa: "R$ 5.820" não
 * diz nada; "R$ 5.820, 12% acima do sábado passado" diz.
 *
 * ## A comparação é com o mesmo dia da semana, não com ontem
 *
 * Barbearia tem semana com forma: sábado é o dobro de terça, e segunda muitas
 * vezes é fechada. Comparar sábado com sexta produziria alta toda semana e
 * queda toda segunda — ruído que ninguém consegue usar. Comparar com o **mesmo
 * dia da semana anterior** é a única leitura que responde "está melhor ou pior?"
 * para quem opera.
 *
 * ## Duas leituras separadas, e é de propósito
 *
 * `operacao` e `dinheiro` saem em funções diferentes porque as permissões são
 * diferentes: `reports.operational` é da recepção e da gerência,
 * `finance.view` está no grupo de dinheiro e exige segundo fator. Uma função só,
 * decidindo por dentro o que devolve, faria a permissão declarada deixar de
 * descrever a rota — que foi o defeito que a `/security-review` encontrou no
 * bloco 19.
 */

export interface Comparado {
  readonly valor: number;
  readonly anterior: number;
  /** Variação em pontos percentuais inteiros. Nulo quando não há base. */
  readonly variacao: number | null;
}

export interface PainelOperacional {
  readonly dia: string;
  /** O dia com que se compara: o mesmo dia da semana anterior. */
  readonly comparadoCom: string;
  readonly agendamentos: Comparado;
  readonly atendidos: Comparado;
  /** Minutos vendidos sobre minutos de jornada, em pontos inteiros. */
  readonly ocupacao: Comparado;
  /** Faltas sobre esperados, em pontos inteiros. */
  readonly noShow: Comparado;
  readonly novosClientes: Comparado;
}

export interface PainelDeDinheiro {
  readonly dia: string;
  readonly comparadoCom: string;
  readonly faturamentoCents: Comparado;
  readonly ticketMedioCents: Comparado;
}

const comparar = (valor: number, anterior: number): Comparado => ({
  valor,
  anterior,
  variacao: variacao(valor, anterior),
});

/** O mesmo dia da semana, uma semana atrás. */
function semanaPassada(dia: string): string {
  const [ano, mes, d] = dia.split('-').map(Number);
  const data = new Date(Date.UTC(ano ?? 1970, (mes ?? 1) - 1, d ?? 1));
  data.setUTCDate(data.getUTCDate() - 7);
  return data.toISOString().slice(0, 10);
}

interface LinhaOperacional {
  agendamentos: bigint;
  atendidos: bigint;
  faltaram: bigint;
  minutos_vendidos: bigint;
  novos_clientes: bigint;
}

async function operacionalDoDia(
  tx: TransactionClient,
  locationId: string,
  dia: string,
): Promise<LinhaOperacional> {
  const linhas = await tx.$queryRaw<LinhaOperacional[]>`
    SELECT
      (SELECT count(*) FROM appointments a
        WHERE a.location_id = ${locationId}::uuid
          AND a.service_starts_at >= ${dia}::date
          AND a.service_starts_at < (${dia}::date + 1)
          AND a.status NOT IN ('rescheduled'))::bigint AS agendamentos,

      (SELECT count(*) FROM appointments a
        WHERE a.location_id = ${locationId}::uuid
          AND a.service_starts_at >= ${dia}::date
          AND a.service_starts_at < (${dia}::date + 1)
          AND a.status = 'completed')::bigint AS atendidos,

      (SELECT count(*) FROM appointments a
        WHERE a.location_id = ${locationId}::uuid
          AND a.service_starts_at >= ${dia}::date
          AND a.service_starts_at < (${dia}::date + 1)
          AND a.status = 'no_show')::bigint AS faltaram,

      -- Ocupação é tempo, não contagem: um corte de 30 e uma coloração de 120
      -- não ocupam a casa do mesmo jeito, e contar cabeças esconderia isso.
      (SELECT coalesce(sum(
                EXTRACT(EPOCH FROM (a.service_ends_at - a.service_starts_at)) / 60
              ), 0)::bigint
         FROM appointments a
        WHERE a.location_id = ${locationId}::uuid
          AND a.service_starts_at >= ${dia}::date
          AND a.service_starts_at < (${dia}::date + 1)
          AND a.status IN ('completed', 'in_progress', 'checked_in', 'waiting', 'confirmed', 'pending')
      )::bigint AS minutos_vendidos,

      -- Cliente novo é o que apareceu hoje pela primeira vez. Contar cadastro
      -- criado hoje contaria também quem a recepção digitou de novo por engano.
      (SELECT count(*) FROM customers c
        WHERE (SELECT min(a.service_starts_at) FROM appointments a
                WHERE a.customer_id = c.id AND a.status = 'completed') >= ${dia}::date
          AND (SELECT min(a.service_starts_at) FROM appointments a
                WHERE a.customer_id = c.id AND a.status = 'completed') < (${dia}::date + 1)
      )::bigint AS novos_clientes
  `;

  return (
    linhas[0] ?? {
      agendamentos: 0n,
      atendidos: 0n,
      faltaram: 0n,
      minutos_vendidos: 0n,
      novos_clientes: 0n,
    }
  );
}

/**
 * Minutos de jornada da casa naquele dia da semana.
 *
 * É o denominador da ocupação. Sem ele a métrica não existe — e num dia sem
 * jornada nenhuma (a folga da casa) a ocupação é zero, não infinito.
 */
async function capacidadeDoDia(
  tx: TransactionClient,
  locationId: string,
  dia: string,
): Promise<number> {
  const linhas = await tx.$queryRaw<{ minutos: bigint }[]>`
    SELECT coalesce(sum(ws.end_minute - ws.start_minute), 0)::bigint AS minutos
      FROM work_schedules ws
      JOIN professionals p ON p.id = ws.professional_id
     WHERE p.active AND p.kind = 'professional'
       AND p.location_id = ${locationId}::uuid
       AND ws.weekday = EXTRACT(DOW FROM ${dia}::date)
  `;
  return Number(linhas[0]?.minutos ?? 0);
}

const emPontos = (parte: number, total: number): number =>
  total <= 0 ? 0 : Math.round((parte / total) * 100);

export async function painelOperacional(params: {
  readonly tenantId: string;
  readonly locationId: string;
  /** Data local da unidade, YYYY-MM-DD. */
  readonly dia: string;
}): Promise<PainelOperacional> {
  const antes = semanaPassada(params.dia);

  return withTenant(params.tenantId, async (tx) => {
    const [hoje, passado, capHoje, capPassado] = await Promise.all([
      operacionalDoDia(tx, params.locationId, params.dia),
      operacionalDoDia(tx, params.locationId, antes),
      capacidadeDoDia(tx, params.locationId, params.dia),
      capacidadeDoDia(tx, params.locationId, antes),
    ]);

    const esperados = Number(hoje.atendidos) + Number(hoje.faltaram);
    const esperadosAntes = Number(passado.atendidos) + Number(passado.faltaram);

    return {
      dia: params.dia,
      comparadoCom: antes,
      agendamentos: comparar(Number(hoje.agendamentos), Number(passado.agendamentos)),
      atendidos: comparar(Number(hoje.atendidos), Number(passado.atendidos)),
      ocupacao: comparar(
        emPontos(Number(hoje.minutos_vendidos), capHoje),
        emPontos(Number(passado.minutos_vendidos), capPassado),
      ),
      noShow: comparar(
        emPontos(Number(hoje.faltaram), esperados),
        emPontos(Number(passado.faltaram), esperadosAntes),
      ),
      novosClientes: comparar(Number(hoje.novos_clientes), Number(passado.novos_clientes)),
    };
  });
}

interface LinhaDeDinheiro {
  faturamento_cents: bigint;
  comandas: bigint;
}

async function dinheiroDoDia(
  tx: TransactionClient,
  locationId: string,
  dia: string,
): Promise<LinhaDeDinheiro> {
  const linhas = await tx.$queryRaw<LinhaDeDinheiro[]>`
    SELECT coalesce(sum(o.total_cents), 0)::bigint AS faturamento_cents,
           count(*)::bigint AS comandas
      FROM orders o
     WHERE o.location_id = ${locationId}::uuid
       AND o.status = 'paid'
       AND o.business_day = ${dia}::date
  `;
  return linhas[0] ?? { faturamento_cents: 0n, comandas: 0n };
}

export async function painelDeDinheiro(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly dia: string;
}): Promise<PainelDeDinheiro> {
  const antes = semanaPassada(params.dia);

  return withTenant(params.tenantId, async (tx) => {
    const [hoje, passado] = await Promise.all([
      dinheiroDoDia(tx, params.locationId, params.dia),
      dinheiroDoDia(tx, params.locationId, antes),
    ]);

    const ticketHoje = ticketMedio({
      faturamentoCents: Number(hoje.faturamento_cents),
      atendimentos: Number(hoje.comandas),
      saiuComHorario: 0,
    });
    const ticketAntes = ticketMedio({
      faturamentoCents: Number(passado.faturamento_cents),
      atendimentos: Number(passado.comandas),
      saiuComHorario: 0,
    });

    return {
      dia: params.dia,
      comparadoCom: antes,
      faturamentoCents: comparar(
        Number(hoje.faturamento_cents),
        Number(passado.faturamento_cents),
      ),
      ticketMedioCents: comparar(ticketHoje, ticketAntes),
    };
  });
}
