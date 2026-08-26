import { withTenant, type TransactionClient } from '@barbearia/db';
import { ESTADOS_QUE_OCUPAM_A_AGENDA, ticketMedio, variacao } from '@barbearia/core';

import { inteiroSeguroDoBanco } from './inteiro-seguro.js';

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

/**
 * O período do painel: os três nomeados do seletor, ou uma janela em dias.
 *
 * A janela em dias existe porque o **assistente** responde sobre sete janelas —
 * 1, 2, 7, 15, 30, 90 e 365 dias corridos — e cada resposta traz um link para a
 * tela onde o número se confere. O painel só tinha Hoje / 7 dias / mês-calendário,
 * então "faturei R$ 33.297 nos últimos 30 dias" levava a uma tela que dizia
 * R$ 22.947: o dono clicava para confiar e saía desconfiando dos dois.
 *
 * Os três nomeados continuam existindo e não viraram `{ dias }`: "mês" é o
 * mês-calendário, que é uma janela de tamanho variável e a pergunta que o dono
 * faz no fechamento. Traduzi-lo para trinta dias mudaria o número do painel para
 * resolver o do assistente.
 */
export type PeriodoPainel = 'dia' | '7d' | 'mes' | JanelaEmDias;

/** Uma janela de N dias corridos terminando hoje — a do assistente. */
export interface JanelaEmDias {
  readonly dias: number;
}

/** O teto da janela em dias, e ele é o do assistente: um ano. */
export const DIAS_MAXIMOS_DO_PAINEL = 365;

export function ehJanelaEmDias(periodo: PeriodoPainel): periodo is JanelaEmDias {
  return typeof periodo === 'object';
}

export interface OcupacaoProfissional {
  readonly professionalId: string;
  readonly professionalName: string;
  readonly ocupacao: number;
}

export interface PainelOperacional {
  readonly dia: string;
  readonly periodo?: PeriodoPainel;
  readonly inicio?: string;
  readonly fim?: string;
  /** O dia com que se compara: o mesmo dia da semana anterior. */
  readonly comparadoCom: string;
  readonly agendamentos: Comparado;
  readonly atendidos: Comparado;
  /** Minutos vendidos sobre minutos de jornada, em pontos inteiros. */
  readonly ocupacao: Comparado;
  /** Faltas sobre esperados, em pontos inteiros. */
  readonly noShow: Comparado;
  readonly novosClientes: Comparado;
  readonly equipe?: readonly OcupacaoProfissional[];
}

export interface PontoFaturamento {
  readonly dia: string;
  readonly faturamentoCents: number;
}

export interface PainelDeDinheiro {
  readonly dia: string;
  readonly periodo?: PeriodoPainel;
  readonly inicio?: string;
  readonly fim?: string;
  readonly comparadoCom: string;
  readonly faturamentoCents: Comparado;
  readonly ticketMedioCents: Comparado;
  readonly metaCents?: number;
  readonly percentualMeta?: number;
  readonly projecaoCents?: number;
  readonly serie?: readonly PontoFaturamento[];
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
          AND a.status = ANY(${[...ESTADOS_QUE_OCUPAM_A_AGENDA]}::appointment_status[])
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
/**
 * A pausa sai do denominador, nas três (bloco 103).
 *
 * A convenção é escrita: *"Denominador de uma taxa de ocupação ou de rendimento
 * sai da jornada cadastrada, com pausa descontada"*. `metrica.ts` e
 * `crescimento.ts` já descontavam; estas três não, e o resultado era o produto
 * discordando de si mesmo sobre a mesma cadeira no mesmo dia: quem trabalha das
 * 9h às 17h com uma hora de almoço e vendeu 240 minutos aparecia com **50%** no
 * painel e **57%** na métrica.
 *
 * O número decide contratar e demitir, e sem descontar a pausa quem atende o dia
 * inteiro nunca cruza o corte de "cheio".
 */
async function capacidadeDoDia(
  tx: TransactionClient,
  locationId: string,
  dia: string,
): Promise<number> {
  const linhas = await tx.$queryRaw<{ minutos: bigint }[]>`
    SELECT coalesce(sum(ws.end_minute - ws.start_minute - COALESCE((
                 SELECT sum((b->>'end')::int - (b->>'start')::int)
                   FROM jsonb_array_elements(ws.breaks) AS b
               ), 0)), 0)::bigint AS minutos
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
  /**
   * Faturamento **sem a gorjeta**, e é o que a palavra quer dizer.
   *
   * `total_cents` é subtotal − desconto + gorjeta, e a gorjeta não é da casa:
   * `somarComanda` a soma por fora justamente para o barbeiro não perder quando
   * a casa dá desconto. Contá-la aqui fazia o painel dizer "faturamento" sobre
   * dinheiro que a barbearia só repassa — e fazia esta tela discordar do DRE
   * pelo valor exato das gorjetas do mês, sem que nenhuma das duas explicasse a
   * diferença (CLAUDE.md §6, pergunta 6).
   *
   * A meta do mês é comparada com este número, e é outra razão para ele ser o
   * da casa: bater a meta com gorjeta de cliente é bater a meta de outra pessoa.
   */
  const linhas = await tx.$queryRaw<LinhaDeDinheiro[]>`
    SELECT coalesce(sum(o.total_cents - o.tip_cents), 0)::bigint AS faturamento_cents,
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
      faturamentoCents: inteiroSeguroDoBanco(hoje.faturamento_cents, 'faturamento do dia'),
      atendimentos: Number(hoje.comandas),
      saiuComHorario: 0,
    });
    const ticketAntes = ticketMedio({
      faturamentoCents: inteiroSeguroDoBanco(passado.faturamento_cents, 'faturamento comparativo do dia'),
      atendimentos: Number(passado.comandas),
      saiuComHorario: 0,
    });

    return {
      dia: params.dia,
      comparadoCom: antes,
      faturamentoCents: comparar(
        inteiroSeguroDoBanco(hoje.faturamento_cents, 'faturamento do dia'),
        inteiroSeguroDoBanco(passado.faturamento_cents, 'faturamento comparativo do dia'),
      ),
      ticketMedioCents: comparar(ticketHoje, ticketAntes),
    };
  });
}


// -- Painel por período -------------------------------------------------------

interface JanelaPainel {
  readonly inicio: string;
  readonly fim: string;
  readonly inicioAnterior: string;
  readonly fimAnterior: string;
}

const iso = (data: Date): string => data.toISOString().slice(0, 10);

function utc(dia: string): Date {
  const [ano, mes, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(ano ?? 1970, (mes ?? 1) - 1, d ?? 1));
}

function somarDias(dia: string, delta: number): string {
  const data = utc(dia);
  data.setUTCDate(data.getUTCDate() + delta);
  return iso(data);
}

function primeiroDoMes(dia: string): string {
  return `${dia.slice(0, 7)}-01`;
}

function mesAnteriorAte(dia: string): { inicio: string; fim: string } {
  const atual = utc(dia);
  const numeroDoDia = atual.getUTCDate();
  const inicioAnterior = new Date(Date.UTC(atual.getUTCFullYear(), atual.getUTCMonth() - 1, 1));
  const ultimoAnterior = new Date(Date.UTC(atual.getUTCFullYear(), atual.getUTCMonth(), 0)).getUTCDate();
  const fimAnterior = new Date(Date.UTC(
    inicioAnterior.getUTCFullYear(),
    inicioAnterior.getUTCMonth(),
    Math.min(numeroDoDia, ultimoAnterior),
  ));
  return { inicio: iso(inicioAnterior), fim: iso(fimAnterior) };
}

function janelaPainel(dia: string, periodo: PeriodoPainel): JanelaPainel {
  /**
   * A janela em dias, e o anterior é a janela **do mesmo tamanho** antes dela.
   *
   * É a regra que já vale para os três nomeados: comparar contra uma janela de
   * outro tamanho faria a queda mostrada ser só a diferença de duração.
   */
  if (ehJanelaEmDias(periodo)) {
    const n = Math.max(1, Math.min(DIAS_MAXIMOS_DO_PAINEL, Math.trunc(periodo.dias)));
    return {
      inicio: somarDias(dia, -(n - 1)),
      fim: dia,
      inicioAnterior: somarDias(dia, -(2 * n - 1)),
      fimAnterior: somarDias(dia, -n),
    };
  }
  if (periodo === 'dia') {
    const anterior = semanaPassada(dia);
    return { inicio: dia, fim: dia, inicioAnterior: anterior, fimAnterior: anterior };
  }
  if (periodo === '7d') {
    return {
      inicio: somarDias(dia, -6),
      fim: dia,
      inicioAnterior: somarDias(dia, -13),
      fimAnterior: somarDias(dia, -7),
    };
  }
  const anterior = mesAnteriorAte(dia);
  return { inicio: primeiroDoMes(dia), fim: dia, inicioAnterior: anterior.inicio, fimAnterior: anterior.fim };
}

async function operacionalDoPeriodo(
  tx: TransactionClient,
  locationId: string,
  inicio: string,
  fim: string,
): Promise<LinhaOperacional> {
  const linhas = await tx.$queryRaw<LinhaOperacional[]>`
    SELECT
      (SELECT count(*) FROM appointments a
        WHERE a.location_id = ${locationId}::uuid
          AND a.service_starts_at >= ${inicio}::date
          AND a.service_starts_at < (${fim}::date + 1)
          AND a.status NOT IN ('rescheduled'))::bigint AS agendamentos,
      (SELECT count(*) FROM appointments a
        WHERE a.location_id = ${locationId}::uuid
          AND a.service_starts_at >= ${inicio}::date
          AND a.service_starts_at < (${fim}::date + 1)
          AND a.status = 'completed')::bigint AS atendidos,
      (SELECT count(*) FROM appointments a
        WHERE a.location_id = ${locationId}::uuid
          AND a.service_starts_at >= ${inicio}::date
          AND a.service_starts_at < (${fim}::date + 1)
          AND a.status = 'no_show')::bigint AS faltaram,
      (SELECT coalesce(sum(EXTRACT(EPOCH FROM (a.service_ends_at - a.service_starts_at)) / 60), 0)::bigint
         FROM appointments a
        WHERE a.location_id = ${locationId}::uuid
          AND a.service_starts_at >= ${inicio}::date
          AND a.service_starts_at < (${fim}::date + 1)
          AND a.status = ANY(${[...ESTADOS_QUE_OCUPAM_A_AGENDA]}::appointment_status[]))::bigint
          AS minutos_vendidos,
      (SELECT count(*) FROM customers c
        WHERE (SELECT min(a.service_starts_at) FROM appointments a
                WHERE a.customer_id = c.id AND a.location_id = ${locationId}::uuid AND a.status = 'completed') >= ${inicio}::date
          AND (SELECT min(a.service_starts_at) FROM appointments a
                WHERE a.customer_id = c.id AND a.location_id = ${locationId}::uuid AND a.status = 'completed') < (${fim}::date + 1))::bigint
          AS novos_clientes
  `;
  return linhas[0] ?? {
    agendamentos: 0n, atendidos: 0n, faltaram: 0n, minutos_vendidos: 0n, novos_clientes: 0n,
  };
}

async function capacidadeDoPeriodo(
  tx: TransactionClient,
  locationId: string,
  inicio: string,
  fim: string,
): Promise<number> {
  const linhas = await tx.$queryRaw<{ minutos: bigint }[]>`
    SELECT coalesce(sum(ws.end_minute - ws.start_minute - COALESCE((
                 SELECT sum((b->>'end')::int - (b->>'start')::int)
                   FROM jsonb_array_elements(ws.breaks) AS b
               ), 0)), 0)::bigint AS minutos
      FROM generate_series(${inicio}::date, ${fim}::date, interval '1 day') AS d(dia)
      JOIN work_schedules ws ON ws.weekday = EXTRACT(DOW FROM d.dia)
      JOIN professionals p ON p.id = ws.professional_id
     WHERE p.active AND p.kind = 'professional'
       AND p.location_id = ${locationId}::uuid
  `;
  return Number(linhas[0]?.minutos ?? 0);
}

async function ocupacaoDaEquipe(
  tx: TransactionClient,
  locationId: string,
  inicio: string,
  fim: string,
): Promise<readonly OcupacaoProfissional[]> {
  const linhas = await tx.$queryRaw<{
    id: string; name: string; vendidos: bigint; capacidade: bigint;
  }[]>`
    SELECT p.id, p.name,
      coalesce((SELECT sum(EXTRACT(EPOCH FROM (a.service_ends_at - a.service_starts_at)) / 60)
        FROM appointments a
       WHERE a.professional_id = p.id
         AND a.service_starts_at >= ${inicio}::date
         AND a.service_starts_at < (${fim}::date + 1)
         AND a.status = ANY(${[...ESTADOS_QUE_OCUPAM_A_AGENDA]}::appointment_status[])), 0)::bigint AS vendidos,
      coalesce((SELECT sum(ws.end_minute - ws.start_minute - COALESCE((
                 SELECT sum((b->>'end')::int - (b->>'start')::int)
                   FROM jsonb_array_elements(ws.breaks) AS b
               ), 0))
        FROM generate_series(${inicio}::date, ${fim}::date, interval '1 day') AS d(dia)
        JOIN work_schedules ws ON ws.professional_id = p.id
                              AND ws.weekday = EXTRACT(DOW FROM d.dia)), 0)::bigint AS capacidade
      FROM professionals p
     WHERE p.active AND p.kind = 'professional' AND p.location_id = ${locationId}::uuid
     ORDER BY p.name
  `;
  return linhas.map((linha) => ({
    professionalId: linha.id,
    professionalName: linha.name,
    ocupacao: emPontos(Number(linha.vendidos), Number(linha.capacidade)),
  }));
}

export async function painelOperacionalDoPeriodo(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly dia: string;
  readonly periodo: PeriodoPainel;
}): Promise<PainelOperacional> {
  const janela = janelaPainel(params.dia, params.periodo);
  return withTenant(params.tenantId, async (tx) => {
    const [atual, anterior, capacidade, capacidadeAnterior, equipe] = await Promise.all([
      operacionalDoPeriodo(tx, params.locationId, janela.inicio, janela.fim),
      operacionalDoPeriodo(tx, params.locationId, janela.inicioAnterior, janela.fimAnterior),
      capacidadeDoPeriodo(tx, params.locationId, janela.inicio, janela.fim),
      capacidadeDoPeriodo(tx, params.locationId, janela.inicioAnterior, janela.fimAnterior),
      ocupacaoDaEquipe(tx, params.locationId, janela.inicio, janela.fim),
    ]);
    const esperados = Number(atual.atendidos) + Number(atual.faltaram);
    const esperadosAntes = Number(anterior.atendidos) + Number(anterior.faltaram);
    return {
      dia: params.dia,
      periodo: params.periodo,
      inicio: janela.inicio,
      fim: janela.fim,
      comparadoCom: janela.inicioAnterior,
      agendamentos: comparar(Number(atual.agendamentos), Number(anterior.agendamentos)),
      atendidos: comparar(Number(atual.atendidos), Number(anterior.atendidos)),
      ocupacao: comparar(
        emPontos(Number(atual.minutos_vendidos), capacidade),
        emPontos(Number(anterior.minutos_vendidos), capacidadeAnterior),
      ),
      noShow: comparar(emPontos(Number(atual.faltaram), esperados), emPontos(Number(anterior.faltaram), esperadosAntes)),
      novosClientes: comparar(Number(atual.novos_clientes), Number(anterior.novos_clientes)),
      equipe,
    };
  });
}

async function dinheiroDoPeriodo(
  tx: TransactionClient,
  locationId: string,
  inicio: string,
  fim: string,
): Promise<LinhaDeDinheiro> {
  const linhas = await tx.$queryRaw<LinhaDeDinheiro[]>`
    -- Sem a gorjeta, pelo mesmo motivo do faturamento do dia: ela nao e da casa.
    SELECT coalesce(sum(o.total_cents - o.tip_cents), 0)::bigint AS faturamento_cents,
           count(*)::bigint AS comandas
      FROM orders o
     WHERE o.location_id = ${locationId}::uuid
       AND o.status = 'paid'
       AND o.business_day >= ${inicio}::date
       AND o.business_day <= ${fim}::date
  `;
  return linhas[0] ?? { faturamento_cents: 0n, comandas: 0n };
}

async function serieDeFaturamento(
  tx: TransactionClient,
  locationId: string,
  inicio: string,
  fim: string,
): Promise<readonly PontoFaturamento[]> {
  const linhas = await tx.$queryRaw<{ dia: string; faturamento_cents: bigint }[]>`
    -- Sem a gorjeta, como o resto do painel: a serie e o cartao precisam somar
    -- a mesma coisa, senao o grafico contradiz o numero em cima dele.
    SELECT to_char(d.dia::date, 'YYYY-MM-DD') AS dia,
           coalesce(sum(o.total_cents - o.tip_cents), 0)::bigint AS faturamento_cents
      FROM generate_series(${inicio}::date, ${fim}::date, interval '1 day') AS d(dia)
      LEFT JOIN orders o ON o.location_id = ${locationId}::uuid
                        AND o.status = 'paid'
                        AND o.business_day = d.dia::date
     GROUP BY d.dia
     ORDER BY d.dia
  `;
  return linhas.map((linha) => ({
    dia: linha.dia,
    faturamentoCents: inteiroSeguroDoBanco(linha.faturamento_cents, `faturamento de ${linha.dia}`),
  }));
}

/**
 * O que a **equipe** vendeu no período — o numerador que a barra de meta pede.
 *
 * `metaDaCasa` soma as metas individuais dos profissionais, então o numerador
 * também tem que ser de cadeira. Ele era `orders.total_cents - tip_cents`, que
 * inclui a pomada vendida no balcão e desconta o desconto que a casa deu: a
 * barra do painel dizia **67%** enquanto os três barbeiros, somados, viam 61%
 * nas telas deles — seis pontos de diferença que ninguém consegue reconciliar,
 * porque a diferença é venda de produto.
 *
 * A conta é a mesma de `desempenho.ts` e da comissão: item a item, pelo
 * profissional do item.
 *
 * O faturamento do cartão continua sendo o da casa, e é outra pergunta: quanto
 * entrou. Duas contas com **nomes diferentes** é o certo aqui; o errado era
 * dividir uma pela outra.
 */
async function vendidoPelaEquipe(
  tx: TransactionClient,
  locationId: string,
  inicio: string,
  fim: string,
): Promise<number> {
  const linhas = await tx.$queryRaw<{ total: bigint }[]>`
    SELECT coalesce(sum(oi.unit_price_cents::bigint * oi.quantity), 0)::bigint AS total
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE o.location_id = ${locationId}::uuid
       AND o.status = 'paid'
       AND oi.professional_id IS NOT NULL
       AND o.business_day >= ${inicio}::date
       AND o.business_day <= ${fim}::date
  `;
  return inteiroSeguroDoBanco(linhas[0]?.total, 'venda da equipe');
}

async function metaDaCasa(tx: TransactionClient, locationId: string, dia: string): Promise<number> {
  const mes = primeiroDoMes(dia);
  const linhas = await tx.$queryRaw<{ total: bigint }[]>`
    SELECT coalesce(sum(g.revenue_cents), 0)::bigint AS total
      FROM professional_goals g
      JOIN professionals p ON p.id = g.professional_id
     WHERE g.month = ${mes}::date
       AND p.location_id = ${locationId}::uuid
       AND p.active AND p.kind = 'professional'
  `;
  return inteiroSeguroDoBanco(linhas[0]?.total, 'meta da casa');
}

export async function painelDeDinheiroDoPeriodo(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly dia: string;
  readonly periodo: PeriodoPainel;
}): Promise<PainelDeDinheiro> {
  const janela = janelaPainel(params.dia, params.periodo);
  return withTenant(params.tenantId, async (tx) => {
    const [atual, anterior, serie, metaCents, daEquipe] = await Promise.all([
      dinheiroDoPeriodo(tx, params.locationId, janela.inicio, janela.fim),
      dinheiroDoPeriodo(tx, params.locationId, janela.inicioAnterior, janela.fimAnterior),
      serieDeFaturamento(tx, params.locationId, janela.inicio, janela.fim),
      metaDaCasa(tx, params.locationId, params.dia),
      vendidoPelaEquipe(tx, params.locationId, janela.inicio, janela.fim),
    ]);
    const faturamento = inteiroSeguroDoBanco(atual.faturamento_cents, 'faturamento do período');
    const faturamentoAnterior = inteiroSeguroDoBanco(anterior.faturamento_cents, 'faturamento do período anterior');
    const ticketAtual = ticketMedio({ faturamentoCents: faturamento, atendimentos: Number(atual.comandas), saiuComHorario: 0 });
    const ticketAnterior = ticketMedio({ faturamentoCents: faturamentoAnterior, atendimentos: Number(anterior.comandas), saiuComHorario: 0 });
    const diaDoMes = Number(params.dia.slice(8, 10));
    const data = utc(params.dia);
    const diasNoMes = new Date(Date.UTC(data.getUTCFullYear(), data.getUTCMonth() + 1, 0)).getUTCDate();
    const projecaoCents = params.periodo === 'mes' && diaDoMes > 0
      ? Math.round((faturamento / diaDoMes) * diasNoMes)
      : faturamento;
    return {
      dia: params.dia,
      periodo: params.periodo,
      inicio: janela.inicio,
      fim: janela.fim,
      comparadoCom: janela.inicioAnterior,
      faturamentoCents: comparar(faturamento, faturamentoAnterior),
      ticketMedioCents: comparar(ticketAtual, ticketAnterior),
      metaCents,
      // Numerador e denominador da mesma coisa: o que a equipe vendeu sobre o
      // que foi combinado com ela.
      percentualMeta: metaCents > 0 ? Math.round((daEquipe / metaCents) * 100) : 0,
      projecaoCents,
      serie,
    };
  });
}
