import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  ehHorarioDePico,
  horasDaGrade,
  horasDePico,
  montarGrade,
  type CelulaDeOcupacao,
  type CelulaNaTela,
  type HoraMedida,
} from '@barbearia/core';

/**
 * O heatmap de ocupação, do banco para a grade (bloco 57, SPEC §5.9).
 *
 * Uma consulta de agregação, não um laço: "quantos minutos foram vendidos na
 * terça às 14h" é `GROUP BY` sobre a agenda, e perguntar dia a dia seria o N+1
 * que a regra proíbe — aqui sobre 7 × 12 células.
 *
 * ## O fuso é o da unidade, e ele muda o resultado
 *
 * Um agendamento das 20h de sexta em Salvador é 23h UTC. Agrupar por hora UTC
 * poria a sexta cheia na madrugada de sábado, e o heatmap mostraria pico numa
 * hora em que a barbearia está fechada. `AT TIME ZONE` resolve no banco, com o
 * fuso lido da unidade — nunca do processo.
 */

/** Quantos dias para trás a grade olha. */
export const JANELA_DO_HEATMAP_DIAS = 56;

/**
 * Oito semanas, e o número tem motivo.
 *
 * Menos que isso e uma semana atípica — feriado, chuva, o barbeiro de férias —
 * move a grade inteira. Muito mais e a grade passa a descrever a barbearia do
 * semestre passado, que é justamente o que quem mudou de horário quer parar de
 * ver.
 */
export async function gradeDeOcupacao(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly agora: Date;
  readonly tx?: TransactionClient;
}): Promise<readonly CelulaNaTela[]> {
  const dentro = async (tx: TransactionClient) => {
    const celulas = await carregarCelulas(tx, params.locationId, params.agora);
    return montarGrade(celulas, horasDaGrade(celulas));
  };
  return params.tx ? dentro(params.tx) : withTenant(params.tenantId, dentro);
}

async function carregarCelulas(
  tx: TransactionClient,
  locationId: string,
  agora: Date,
): Promise<readonly CelulaDeOcupacao[]> {
  const linhas = await tx.$queryRaw<
    { dia: number; hora: number; vendidos: number; jornada: number }[]
  >`
    WITH fuso AS (
      SELECT timezone FROM locations WHERE id = ${locationId}::uuid
    ),
    atendidos AS (
      SELECT
        EXTRACT(DOW FROM a.starts_at AT TIME ZONE (SELECT timezone FROM fuso))::int AS dia,
        EXTRACT(HOUR FROM a.starts_at AT TIME ZONE (SELECT timezone FROM fuso))::int AS hora,
        sum(EXTRACT(EPOCH FROM (a.ends_at - a.starts_at)) / 60)::int AS vendidos
        FROM appointments a
       WHERE a.location_id = ${locationId}::uuid
         AND a.status IN ('completed', 'in_progress', 'checked_in', 'confirmed', 'pending')
         AND a.starts_at >= ${agora}::timestamptz - ${JANELA_DO_HEATMAP_DIAS} * interval '1 day'
         AND a.starts_at < ${agora}::timestamptz
       GROUP BY 1, 2
    ),
    /**
     * A capacidade é o número de cadeiras vezes os minutos da hora, vezes
     * quantas vezes aquele dia da semana passou na janela.
     *
     * Derivada e não cadastrada: uma coluna de capacidade seria um número que
     * alguém sobrescreve, e a pergunta que chega é "por que sexta parece cheia
     * se contratei mais um barbeiro?".
     */
    cadeiras AS (
      SELECT count(*)::int AS total FROM professionals
       WHERE location_id = ${locationId}::uuid AND active
    )
    SELECT g.dia, g.hora,
           COALESCE(at.vendidos, 0) AS vendidos,
           (SELECT total FROM cadeiras) * 60 * ${Math.floor(JANELA_DO_HEATMAP_DIAS / 7)} AS jornada
      FROM (
        SELECT DISTINCT dia, hora FROM atendidos
      ) g
      LEFT JOIN atendidos at ON at.dia = g.dia AND at.hora = g.hora
  `;

  return linhas.map((l) => ({
    diaDaSemana: l.dia,
    hora: l.hora,
    minutosVendidos: Number(l.vendidos),
    minutosDeJornada: Number(l.jornada),
  }));
}

/**
 * Esta hora é de pico?
 *
 * Chamada pelo caminho de reserva, e só quando pode mudar a resposta — o quarto
 * termo do sinal vale para cliente **novo**, e para os outros a grade seria uma
 * consulta jogada fora no caminho mais chamado do produto.
 */
export async function horaCheia(
  tx: TransactionClient,
  locationId: string,
  comecaEm: Date,
  /**
   * O relógio entra por parâmetro, e o padrão existe só para os chamadores
   * antigos.
   *
   * A primeira versão chamava `new Date()` aqui dentro. Isso torna a janela de
   * oito semanas dependente do relógio do processo: um teste que semeia
   * histórico ancorado no próprio instante que consulta perde as semanas mais
   * antigas assim que o dia real avança, e a hora deixa de ser de pico sem nada
   * ter mudado. É a regra do CLAUDE.md §1 — relógio por parâmetro —, e ela vale
   * aqui porque este número decide se o cliente paga sinal.
   */
  agora: Date = new Date(),
): Promise<boolean> {
  const celulas = await carregarCelulas(tx, locationId, agora);
  const grade = montarGrade(celulas, horasDaGrade(celulas));

  const local = await tx.$queryRaw<{ dia: number; hora: number }[]>`
    SELECT EXTRACT(DOW FROM ${comecaEm}::timestamptz AT TIME ZONE l.timezone)::int AS dia,
           EXTRACT(HOUR FROM ${comecaEm}::timestamptz AT TIME ZONE l.timezone)::int AS hora
      FROM locations l WHERE l.id = ${locationId}::uuid
  `;
  const quando = local[0];
  if (!quando) return false;

  return ehHorarioDePico({
    picos: horasDePico(grade),
    diaDaSemanaLocal: Number(quando.dia),
    horaLocal: Number(quando.hora),
  });
}

/**
 * A ocupação de cada cadeira, com quantos pedidos ela não conseguiu atender
 * (bloco 67, SPEC §4.19).
 *
 * > *"João está com 97% de ocupação há 6 semanas e recusou 14 pedidos de
 * > horário."*
 *
 * ## O denominador é a jornada cadastrada, nunca "horas × dias"
 *
 * É a mesma regra do bloco 59: um número fixo erra em toda barbearia que fecha
 * na segunda, e todas fecham. A capacidade sai de `work_schedules`, com as
 * pausas descontadas — quem trabalha meio período não aparece com metade da
 * ocupação de quem trabalha o dia inteiro.
 *
 * ## "Recusou um pedido" é a lista de espera, não uma nova instrumentação
 *
 * `waitlist_entries` já é exatamente isto: *quem foi embora sem conseguir
 * marcar*. Criar um contador de "tentativas recusadas" seria uma segunda fonte
 * de verdade para o mesmo fato — e uma que ninguém preencheria nos caminhos que
 * já existem. Só as entradas com **preferência por esta cadeira** contam: quem
 * pediu "qualquer barbeiro" não estava sendo recusado por ninguém em especial.
 */
export interface AgendaDoProfissional {
  readonly profissionalId: string;
  readonly nome: string;
  readonly ocupacaoBps: number;
  readonly pedidosSemVaga: number;
}

export async function agendasApertadas(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly agora: Date;
  /** A partir de quanta ocupação a agenda conta como apertada. */
  readonly corteBps: number;
  readonly tx?: TransactionClient;
}): Promise<readonly AgendaDoProfissional[]> {
  const dentro = async (tx: TransactionClient) => {
    const semanas = Math.floor(JANELA_DO_HEATMAP_DIAS / 7);
    const linhas = await tx.$queryRaw<
      { id: string; name: string; vendidos: number; jornada: number; pedidos: number }[]
    >`
      WITH janela AS (
        SELECT ${params.agora}::timestamptz - ${JANELA_DO_HEATMAP_DIAS} * interval '1 day' AS desde,
               ${params.agora}::timestamptz AS ate
      ),
      -- A jornada de cada cadeira na janela: os minutos de cada dia da semana,
      -- menos as pausas, vezes quantas vezes aquele dia passou.
      jornada AS (
        SELECT w.professional_id,
               sum(
                 (w.end_minute - w.start_minute)
                 - COALESCE((
                     SELECT sum((p->>'end')::int - (p->>'start')::int)
                       FROM jsonb_array_elements(w.breaks) AS p
                   ), 0)
               )::int * ${semanas} AS minutos
          FROM work_schedules w
         GROUP BY w.professional_id
      ),
      vendidos AS (
        SELECT a.professional_id,
               sum(EXTRACT(EPOCH FROM (a.ends_at - a.starts_at)) / 60)::int AS minutos
          FROM appointments a, janela j
         WHERE a.location_id = ${params.locationId}::uuid
           AND a.status IN ('completed', 'in_progress', 'checked_in', 'confirmed', 'pending')
           AND a.starts_at >= j.desde AND a.starts_at < j.ate
         GROUP BY a.professional_id
      ),
      pedidos AS (
        SELECT e.professional_id, count(*)::int AS total
          FROM waitlist_entries e, janela j
         WHERE e.location_id = ${params.locationId}::uuid
           AND e.professional_id IS NOT NULL
           AND e.joined_at >= j.desde AND e.joined_at < j.ate
         GROUP BY e.professional_id
      )
      SELECT p.id, p.name,
             COALESCE(v.minutos, 0) AS vendidos,
             COALESCE(jo.minutos, 0) AS jornada,
             COALESCE(pe.total, 0) AS pedidos
        FROM professionals p
        LEFT JOIN jornada  jo ON jo.professional_id = p.id
        LEFT JOIN vendidos v  ON v.professional_id  = p.id
        LEFT JOIN pedidos  pe ON pe.professional_id = p.id
       WHERE p.location_id = ${params.locationId}::uuid AND p.active
    `;

    return linhas
      .map((l) => ({
        profissionalId: l.id,
        nome: l.name,
        /**
         * Jornada zero devolve zero, nunca `Infinity`.
         *
         * A cadeira recém-cadastrada e ainda sem grade tem denominador zero, e
         * "ocupação de ∞%" apareceria justamente no dia em que o dono contrata
         * alguém — que é quando ele abre o painel.
         */
        ocupacaoBps:
          Number(l.jornada) > 0
            ? Math.round((Number(l.vendidos) / Number(l.jornada)) * 10_000)
            : 0,
        pedidosSemVaga: Number(l.pedidos),
      }))
      .filter((p) => p.ocupacaoBps >= params.corteBps);
  };

  return params.tx ? dentro(params.tx) : withTenant(params.tenantId, dentro);
}

/**
 * O serviço que a barbearia mais vende, para ancorar a contagem de vagas.
 *
 * O insight de hora ociosa precisa dizer *"há 23 horários vagos amanhã"*, e
 * "horário vago" só existe em relação a uma duração: a mesma tarde cabe seis
 * cortes ou dois pacotes de coloração. Perguntar pelo serviço mais vendido faz o
 * número ser o que o cliente veria ao abrir a página escolhendo o de sempre —
 * e ele sai do **motor**, não de uma segunda contagem de agenda.
 *
 * O desempate por duração e nome existe para a barbearia que ainda não vendeu
 * nada: sem ele a resposta seria nula no primeiro mês, que é justamente quando
 * há mais hora vazia para preencher.
 */
export async function servicoMaisVendido(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly agora: Date;
  readonly tx?: TransactionClient;
}): Promise<string | null> {
  const dentro = async (tx: TransactionClient) => {
    const linhas = await tx.$queryRaw<{ id: string }[]>`
      SELECT s.id
        FROM services s
        LEFT JOIN appointment_services aps ON aps.service_id = s.id
        LEFT JOIN appointments a
               ON a.id = aps.appointment_id
              AND a.location_id = ${params.locationId}::uuid
              AND a.starts_at >= ${params.agora}::timestamptz
                                 - ${JANELA_DO_HEATMAP_DIAS} * interval '1 day'
              AND a.starts_at < ${params.agora}::timestamptz
       WHERE s.active
       GROUP BY s.id, s.duration_minutes, s.name
       ORDER BY count(a.id) DESC, s.duration_minutes ASC, s.name ASC
       LIMIT 1
    `;
    return linhas[0]?.id ?? null;
  };
  return params.tx ? dentro(params.tx) : withTenant(params.tenantId, dentro);
}

/**
 * As faixas cadastradas e o estado do interruptor (bloco 68, SPEC §4.20).
 *
 * Devolve o teto da marca junto porque a tela precisa dele para mostrar o efeito
 * **aplicado** ao lado do cadastrado: uma faixa de −40% com teto de 15% desconta
 * 15%, e sem o número na tela a barbearia acha que o produto ignorou a regra.
 */
export interface FaixasDaUnidade {
  readonly ligado: boolean;
  readonly tetoBps: number;
  readonly faixas: readonly {
    readonly id: string;
    readonly diaDaSemana: number;
    readonly inicioMinuto: number;
    readonly fimMinuto: number;
    readonly deltaBps: number;
  }[];
}

export async function faixasDaUnidade(
  tenantId: string,
  locationId: string,
): Promise<FaixasDaUnidade> {
  return withTenant(tenantId, async (tx) => {
    const config = await tx.$queryRaw<
      { ligado: boolean; teto: number }[]
    >`
      SELECT l.dynamic_pricing_enabled AS ligado, t.max_price_variation_bps AS teto
        FROM locations l
        JOIN tenants t ON t.id = l.tenant_id
       WHERE l.id = ${locationId}::uuid
    `;
    const linhas = await tx.$queryRaw<
      { id: string; weekday: number; start_minute: number; end_minute: number; delta_bps: number }[]
    >`
      SELECT id, weekday, start_minute, end_minute, delta_bps
        FROM pricing_rules
       WHERE location_id = ${locationId}::uuid
       ORDER BY weekday, start_minute
    `;
    return {
      ligado: config[0]?.ligado === true,
      tetoBps: Number(config[0]?.teto ?? 0),
      faixas: linhas.map((f) => ({
        id: f.id,
        diaDaSemana: Number(f.weekday),
        inicioMinuto: Number(f.start_minute),
        fimMinuto: Number(f.end_minute),
        deltaBps: Number(f.delta_bps),
      })),
    };
  });
}

export async function ligarPrecoPorFaixa(
  tenantId: string,
  locationId: string,
  ligado: boolean,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE locations SET dynamic_pricing_enabled = ${ligado}
       WHERE id = ${locationId}::uuid
    `;
  });
}

/**
 * Cadastra a faixa, ou devolve nulo quando ela encosta noutra.
 *
 * A violação de exclusão **não** é tratada com `catch` dentro da transação: no
 * Postgres a transação aborta e toda instrução seguinte é recusada. A condição
 * vai na própria instrução (`NOT EXISTS`), e o índice de exclusão fica como
 * última linha de defesa entre processos — é a regra escrita desde o bloco 56.
 */
export async function criarFaixaDePreco(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly staffUserId: string;
  readonly diaDaSemana: number;
  readonly inicioMinuto: number;
  readonly fimMinuto: number;
  readonly deltaBps: number;
}): Promise<boolean> {
  return withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      INSERT INTO pricing_rules
        (tenant_id, location_id, weekday, start_minute, end_minute, delta_bps, created_by)
      SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid,
             ${params.locationId}::uuid, ${params.diaDaSemana}, ${params.inicioMinuto},
             ${params.fimMinuto}, ${params.deltaBps}, ${params.staffUserId}::uuid
       WHERE NOT EXISTS (
         SELECT 1 FROM pricing_rules r
          WHERE r.location_id = ${params.locationId}::uuid
            AND r.weekday = ${params.diaDaSemana}
            -- Cast explícito para int: o Prisma manda número de JS como bigint,
            -- e não existe int4range de bigint. O erro sai como função
            -- inexistente sobre uma linha que parece certa.
            AND int4range(r.start_minute, r.end_minute)
                && int4range(${params.inicioMinuto}::int, ${params.fimMinuto}::int)
       )
    `;
    return afetadas === 1;
  });
}

/**
 * Apaga a faixa **desta** unidade, e devolve se alguma linha caiu.
 *
 * O filtro por `location_id` é obrigatório e mora aqui, no domínio: a RLS separa
 * barbearias e não separa lojas dentro de uma. A primeira versão apagava por id
 * puro, e um gerente escopado à filial removia a faixa da matriz por um `DELETE`
 * com o id alheio — a mesma falha que a revisão do bloco 58 achou no estoque.
 *
 * Achado da `/security-review` deste bloco. E o id ser UUID não conserta: com
 * `staff_locations` vazio significando "todas", todo gerente enxerga os ids de
 * todas as lojas até alguém escopá-lo, e escopar depois não tira dele o que ele
 * já anotou.
 */
export async function apagarFaixaDePreco(
  tenantId: string,
  locationId: string,
  faixaId: string,
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      DELETE FROM pricing_rules
       WHERE id = ${faixaId}::uuid AND location_id = ${locationId}::uuid
    `;
    return afetadas === 1;
  });
}

/**
 * A ocupação medida hora a hora, no formato que a recomendação lê.
 *
 * Sai da **mesma** grade do heatmap: dois lugares do produto dizendo "sexta às
 * 17h está cheia" sobre janelas diferentes é a mesma pergunta com duas
 * respostas.
 */
export async function horasMedidas(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly agora: Date;
}): Promise<readonly HoraMedida[]> {
  return withTenant(params.tenantId, async (tx) => {
    const celulas = await carregarCelulas(tx, params.locationId, params.agora);
    const grade = montarGrade(celulas, horasDaGrade(celulas));
    const semanas = Math.floor(JANELA_DO_HEATMAP_DIAS / 7);

    const atendimentos = await tx.$queryRaw<{ dia: number; hora: number; total: number }[]>`
      SELECT EXTRACT(DOW FROM a.starts_at AT TIME ZONE l.timezone)::int AS dia,
             EXTRACT(HOUR FROM a.starts_at AT TIME ZONE l.timezone)::int AS hora,
             count(*)::int AS total
        FROM appointments a
        JOIN locations l ON l.id = a.location_id
       WHERE a.location_id = ${params.locationId}::uuid
         AND a.status IN ('completed', 'in_progress', 'checked_in', 'confirmed', 'pending')
         AND a.starts_at >= ${params.agora}::timestamptz
                            - ${JANELA_DO_HEATMAP_DIAS} * interval '1 day'
         AND a.starts_at < ${params.agora}::timestamptz
       GROUP BY 1, 2
    `;
    const porHora = new Map(atendimentos.map((a) => [`${a.dia}-${a.hora}`, Number(a.total)]));

    return grade.map((celula) => ({
      diaDaSemana: celula.diaDaSemana,
      hora: celula.hora,
      ocupacaoBps: celula.ocupacaoBps,
      atendimentosPorSemana:
        (porHora.get(`${celula.diaDaSemana}-${celula.hora}`) ?? 0) / semanas,
    }));
  });
}
