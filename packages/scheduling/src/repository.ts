import type { TransactionClient } from '@barbearia/db';
import {
  localToInstant,
  weekdayIn,
  type ComboRule,
  type FaixaDePreco,
  type ScheduleException,
  type TimeRange,
  type WeeklyPlan,
} from '@barbearia/core';

/**
 * Carrega tudo que o motor de disponibilidade precisa, para um intervalo de
 * datas de uma vez.
 *
 * A carga é por **intervalo**, não por dia: consultar dia a dia num laço seria
 * N+1 entre datas, e a meta de P95 é 7 dias × 5 profissionais em menos de 800 ms
 * (CLAUDE.md §3). O que não depende de data — catálogo, equipe, combos — é
 * carregado uma vez só.
 *
 * Todas as consultas rodam dentro da transação com `app.tenant_id` fixado
 * (ver `withTenant`), então a RLS filtra por tenant mesmo nas queries abaixo,
 * que deliberadamente não repetem `tenant_id` no WHERE.
 */

const TERMINAL_STATUSES = [
  'cancelled_customer',
  'cancelled_business',
  'no_show',
  'rescheduled',
] as const;

export interface LocationSettings {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly slotStrategy: 'anchored' | 'grid';
  readonly bufferPolicy: 'outer' | 'per_service';
  readonly granularityMinutes: number;
  readonly minLeadMinutes: number;
  readonly maxLeadDays: number;
  readonly requireOtpForBooking: boolean;
  /** Se as faixas de preço valem nesta unidade (bloco 68). Nasce desligado. */
  readonly dynamicPricingEnabled: boolean;
  /** Teto de variação da marca, em pontos-base. Vem de `tenants`. */
  readonly maxPriceVariationBps: number;
}

export interface ServiceRow {
  readonly id: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly priceCents: number;
  readonly requiredResources: readonly { resourceType: string; quantity: number }[];
}

export interface QualifiedProfessional {
  readonly id: string;
  readonly name: string;
  readonly dailyLimit: number | null;
  readonly overrides: ReadonlyMap<
    string,
    { priceCents: number | null; durationMinutes: number | null }
  >;
}

export interface ResourcePoolRow {
  readonly resourceType: string;
  readonly capacity: number;
  readonly busy: TimeRange[];
}

/** Recorte de um único dia — é o que o motor consome. */
export interface DayContext {
  readonly location: LocationSettings;
  readonly date: string;
  readonly weekday: number;
  readonly services: readonly ServiceRow[];
  readonly professionals: readonly QualifiedProfessional[];
  readonly weeklyPlans: ReadonlyMap<string, WeeklyPlan[]>;
  readonly exceptions: ReadonlyMap<string, ScheduleException[]>;
  /**
   * Bloqueios pontuais por profissional, já em minutos locais.
   *
   * Separado de `exceptions` porque o motor os trata como faixa a subtrair, não
   * como regra de jornada: têm a maior precedência e recortam qualquer horário
   * já resolvido (`resolveWorkingDay`).
   */
  readonly blocks: ReadonlyMap<string, TimeRange[]>;
  readonly busy: ReadonlyMap<string, TimeRange[]>;
  readonly appointmentCount: ReadonlyMap<string, number>;
  readonly resourcePools: readonly ResourcePoolRow[];
  readonly comboRules: readonly ComboRule[];
  /** As faixas de preço da unidade, vazias quando o interruptor está desligado. */
  readonly faixasDePreco: readonly FaixaDePreco[];
}

export interface RangeContext {
  readonly location: LocationSettings;
  readonly dates: readonly string[];
  readonly services: readonly ServiceRow[];
  readonly professionals: readonly QualifiedProfessional[];
  /** Recorte pronto por data. */
  readonly days: ReadonlyMap<string, DayContext>;
}

/** Recorta um intervalo UTC para os minutos locais do dia pedido. */
function toLocalMinutes(
  timezone: string,
  date: string,
  startsAt: Date,
  endsAt: Date,
): TimeRange | null {
  const dayStart = localToInstant(timezone, date, 0).getTime();
  const dayEnd = localToInstant(timezone, date, 24 * 60).getTime();

  const start = Math.max(startsAt.getTime(), dayStart);
  const end = Math.min(endsAt.getTime(), dayEnd);
  if (start >= end) return null;

  return {
    start: Math.round((start - dayStart) / 60_000),
    end: Math.round((end - dayStart) / 60_000),
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

interface OccupiedRow {
  professional_id: string;
  starts_at: Date;
  ends_at: Date;
}

export async function loadRangeContext(
  tx: TransactionClient,
  params: {
    readonly locationId: string;
    readonly serviceIds: readonly string[];
    readonly dates: readonly string[];
    readonly professionalId?: string;
    /**
     * Agendamento a ignorar na ocupação. Usado pelo reagendamento: o horário
     * que está sendo liberado não pode bloquear a si mesmo.
     */
    readonly ignoreAppointmentId?: string;
    /**
     * Reserva temporária a ignorar. Quem segura o hold é justamente quem vai
     * ocupar o slot — o próprio hold não pode barrá-lo.
     */
    readonly ignoreHoldId?: string;
  },
): Promise<RangeContext | null> {
  const { locationId, dates } = params;
  const ids = [...params.serviceIds];
  if (ids.length === 0) throw new RangeError('Nenhum serviço selecionado');
  if (dates.length === 0) throw new RangeError('Nenhuma data solicitada');

  // ---- Unidade -------------------------------------------------------------
  const locationRows = await tx.$queryRaw<
    {
      id: string;
      name: string;
      timezone: string;
      slot_strategy: 'anchored' | 'grid';
      buffer_policy: 'outer' | 'per_service';
      granularity_minutes: number;
      min_lead_minutes: number;
      max_lead_days: number;
      require_otp_for_booking: boolean;
      dynamic_pricing_enabled: boolean;
      max_price_variation_bps: number;
    }[]
  >`
    SELECT l.id, l.name, l.timezone, l.slot_strategy, l.buffer_policy,
           l.granularity_minutes, l.min_lead_minutes, l.max_lead_days,
           l.require_otp_for_booking, l.dynamic_pricing_enabled,
           -- O teto é da marca, não da unidade: uma rede não tem duas
           -- percepções de preço.
           t.max_price_variation_bps
      FROM locations l
      JOIN tenants t ON t.id = l.tenant_id
     WHERE l.id = ${locationId}::uuid
  `;
  const locationRow = locationRows[0];
  if (!locationRow) return null;

  const location: LocationSettings = {
    id: locationRow.id,
    name: locationRow.name,
    timezone: locationRow.timezone,
    slotStrategy: locationRow.slot_strategy,
    bufferPolicy: locationRow.buffer_policy,
    granularityMinutes: locationRow.granularity_minutes,
    minLeadMinutes: locationRow.min_lead_minutes,
    maxLeadDays: locationRow.max_lead_days,
    requireOtpForBooking: locationRow.require_otp_for_booking,
    dynamicPricingEnabled: locationRow.dynamic_pricing_enabled,
    maxPriceVariationBps: Number(locationRow.max_price_variation_bps),
  };

  /**
   * As faixas de preço da unidade (bloco 68).
   *
   * Carregadas **só** quando o interruptor está ligado: com ele desligado, a
   * lista vazia faz `precoDoHorario` devolver o preço de tabela sem nenhum
   * ramo especial, e uma consulta a menos no caminho mais chamado do produto.
   */
  const faixasDePreco: FaixaDePreco[] = location.dynamicPricingEnabled
    ? (
        await tx.$queryRaw<
          { weekday: number; start_minute: number; end_minute: number; delta_bps: number }[]
        >`
          SELECT weekday, start_minute, end_minute, delta_bps
            FROM pricing_rules
           WHERE location_id = ${locationId}::uuid
        `
      ).map((f) => ({
        diaDaSemana: Number(f.weekday),
        inicioMinuto: Number(f.start_minute),
        fimMinuto: Number(f.end_minute),
        deltaBps: Number(f.delta_bps),
      }))
    : [];

  const sorted = [...dates].sort();
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const rangeStart = localToInstant(location.timezone, first, 0);
  const rangeEnd = localToInstant(location.timezone, last, 24 * 60);
  const weekdays = [...new Set(sorted.map((date) => weekdayIn(location.timezone, date)))];

  // ---- Serviços e exigências de recurso -----------------------------------
  const serviceRows = await tx.$queryRaw<
    {
      id: string;
      name: string;
      duration_minutes: number;
      buffer_before_minutes: number;
      buffer_after_minutes: number;
      price_cents: number;
    }[]
  >`
    SELECT id, name, duration_minutes, buffer_before_minutes, buffer_after_minutes, price_cents
    FROM services
    WHERE id = ANY(${ids}::uuid[]) AND active AND bookable_online
  `;
  // Serviço inexistente, inativo ou não agendável online derruba a consulta
  // inteira: melhor recusar do que oferecer horário para algo que não existe.
  if (serviceRows.length !== ids.length) return null;

  const requirementRows = await tx.$queryRaw<
    { service_id: string; resource_type: string; quantity: number }[]
  >`
    SELECT service_id, resource_type, quantity
    FROM service_resource_requirements
    WHERE service_id = ANY(${ids}::uuid[])
  `;

  const requirementsByService = new Map<string, { resourceType: string; quantity: number }[]>();
  for (const row of requirementRows) {
    push(requirementsByService, row.service_id, {
      resourceType: row.resource_type,
      quantity: row.quantity,
    });
  }

  const services: ServiceRow[] = serviceRows.map((row) => ({
    id: row.id,
    name: row.name,
    durationMinutes: row.duration_minutes,
    bufferBeforeMinutes: row.buffer_before_minutes,
    bufferAfterMinutes: row.buffer_after_minutes,
    priceCents: row.price_cents,
    requiredResources: requirementsByService.get(row.id) ?? [],
  }));

  // ---- Profissionais habilitados em TODOS os serviços ---------------------
  // Herdado do concorrente (`get_profs_hab`): filtrar na origem evita oferecer
  // horário para quem não executa o serviço.
  // `counter` e `resource_only` ficam de fora — são agendas de balcão, não
  // profissionais (defeito D12).
  const professionalRows = await tx.$queryRaw<
    { id: string; name: string; daily_limit: number | null }[]
  >`
    SELECT p.id, p.name, p.daily_limit
    FROM professionals p
    JOIN professional_services ps ON ps.professional_id = p.id
    WHERE p.location_id = ${locationId}::uuid
      AND p.active
      AND p.bookable_online
      AND p.kind IN ('professional', 'external')
      AND ps.service_id = ANY(${ids}::uuid[])
      AND (${params.professionalId ?? null}::uuid IS NULL
           OR p.id = ${params.professionalId ?? null}::uuid)
    GROUP BY p.id, p.name, p.daily_limit
    HAVING count(DISTINCT ps.service_id) = ${ids.length}
    ORDER BY p.name
  `;

  const emptyDay = (date: string): DayContext => ({
    location,
    date,
    weekday: weekdayIn(location.timezone, date),
    services,
    professionals: [],
    weeklyPlans: new Map(),
    exceptions: new Map(),
    blocks: new Map(),
    busy: new Map(),
    appointmentCount: new Map(),
    resourcePools: [],
    comboRules: [],
    faixasDePreco,
  });

  if (professionalRows.length === 0) {
    return {
      location,
      dates: sorted,
      services,
      professionals: [],
      days: new Map(sorted.map((date) => [date, emptyDay(date)])),
    };
  }

  const professionalIds = professionalRows.map((row) => row.id);

  const overrideRows = await tx.$queryRaw<
    {
      professional_id: string;
      service_id: string;
      price_cents: number | null;
      duration_minutes: number | null;
    }[]
  >`
    SELECT professional_id, service_id, price_cents, duration_minutes
    FROM professional_services
    WHERE professional_id = ANY(${professionalIds}::uuid[])
      AND service_id = ANY(${ids}::uuid[])
  `;

  const overridesByProfessional = new Map<
    string,
    Map<string, { priceCents: number | null; durationMinutes: number | null }>
  >();
  for (const row of overrideRows) {
    const bucket = overridesByProfessional.get(row.professional_id) ?? new Map();
    bucket.set(row.service_id, {
      priceCents: row.price_cents,
      durationMinutes: row.duration_minutes,
    });
    overridesByProfessional.set(row.professional_id, bucket);
  }

  const professionals: QualifiedProfessional[] = professionalRows.map((row) => ({
    id: row.id,
    name: row.name,
    dailyLimit: row.daily_limit,
    overrides: overridesByProfessional.get(row.id) ?? new Map(),
  }));

  // ---- Jornadas: todos os dias da semana presentes no intervalo -----------
  const scheduleRows = await tx.$queryRaw<
    {
      professional_id: string;
      weekday: number;
      start_minute: number;
      end_minute: number;
      breaks: unknown;
    }[]
  >`
    SELECT professional_id, weekday, start_minute, end_minute, breaks
    FROM work_schedules
    WHERE professional_id = ANY(${professionalIds}::uuid[])
      AND weekday = ANY(${weekdays}::smallint[])
  `;

  const plansByProfessional = new Map<string, WeeklyPlan[]>();
  for (const row of scheduleRows) {
    const breaks = Array.isArray(row.breaks)
      ? (row.breaks as TimeRange[]).filter(
          (item) => typeof item?.start === 'number' && typeof item?.end === 'number',
        )
      : [];
    push(plansByProfessional, row.professional_id, {
      weekday: row.weekday,
      start: row.start_minute,
      end: row.end_minute,
      breaks,
    });
  }

  // ---- Exceções do intervalo ---------------------------------------------
  const exceptionRows = await tx.$queryRaw<
    {
      on_date: Date;
      professional_id: string | null;
      location_id: string | null;
      kind: 'custom_hours' | 'day_off' | 'holiday' | 'vacation' | 'block';
      start_minute: number | null;
      end_minute: number | null;
      reason: string | null;
    }[]
  >`
    SELECT on_date, professional_id, location_id, kind, start_minute, end_minute, reason
    FROM schedule_exceptions
    WHERE on_date = ANY(${[...sorted]}::date[])
      AND (professional_id = ANY(${professionalIds}::uuid[])
           OR location_id = ${locationId}::uuid)
  `;

  const professionalExceptions = new Map<string, ScheduleException[]>();
  const locationExceptions = new Map<string, ScheduleException[]>();
  const professionalBlocks = new Map<string, TimeRange[]>();
  const locationBlocks = new Map<string, TimeRange[]>();

  for (const row of exceptionRows) {
    const date = row.on_date.toISOString().slice(0, 10);

    // `block` não é regra de jornada, é faixa a subtrair. A CHECK do banco
    // garante início e fim; a guarda aqui protege de linha antiga, de antes da
    // migração 0010.
    if (row.kind === 'block') {
      if (row.start_minute === null || row.end_minute === null) continue;
      const range = { start: row.start_minute, end: row.end_minute };
      if (row.professional_id) push(professionalBlocks, `${date}|${row.professional_id}`, range);
      else push(locationBlocks, date, range);
      continue;
    }

    const item: ScheduleException = {
      kind: row.kind,
      scope: row.professional_id ? 'professional' : 'location',
      ...(row.start_minute !== null ? { start: row.start_minute } : {}),
      ...(row.end_minute !== null ? { end: row.end_minute } : {}),
      ...(row.reason !== null ? { reason: row.reason } : {}),
    };
    if (row.professional_id) push(professionalExceptions, `${date}|${row.professional_id}`, item);
    else push(locationExceptions, date, item);
  }

  // ---- Ocupação: agendamentos ativos + reservas temporárias ---------------
  /**
   * A janela **ocupada**, que não é sempre a janela reservada.
   *
   * `janela_ocupada` é a mesma função que a constraint de exclusão usa
   * (migração 0097): o atendimento concluído antes da hora para de segurar a
   * cadeira até o fim da reserva. Escrita em dois lugares, a expressão
   * divergiria no primeiro ajuste — e a divergência aqui é a grade oferecendo o
   * que a gravação recusa, ou a gravação recusando o que a grade ofereceu.
   *
   * `isempty` fora: o atendimento concluído no mesmo instante em que começou
   * ocupa zero, e um intervalo de zero minuto no mapa de ocupação não bloqueia
   * nada — mas também não deve entrar, para não virar linha inútil no cálculo.
   */
  const appointmentRows = await tx.$queryRaw<OccupiedRow[]>`
    SELECT professional_id,
           lower(janela_ocupada(starts_at, ends_at, completed_at)) AS starts_at,
           upper(janela_ocupada(starts_at, ends_at, completed_at)) AS ends_at
    FROM appointments
    WHERE professional_id = ANY(${professionalIds}::uuid[])
      AND starts_at < ${rangeEnd}
      AND upper(janela_ocupada(starts_at, ends_at, completed_at)) > ${rangeStart}
      AND NOT isempty(janela_ocupada(starts_at, ends_at, completed_at))
      AND status <> ALL(${[...TERMINAL_STATUSES]}::appointment_status[])
      AND (${params.ignoreAppointmentId ?? null}::uuid IS NULL
           OR id <> ${params.ignoreAppointmentId ?? null}::uuid)
  `;

  const holdRows = await tx.$queryRaw<OccupiedRow[]>`
    SELECT professional_id, starts_at, ends_at
    FROM slot_holds
    WHERE professional_id = ANY(${professionalIds}::uuid[])
      AND starts_at < ${rangeEnd}
      AND ends_at > ${rangeStart}
      AND expires_at > now()
      AND (${params.ignoreHoldId ?? null}::uuid IS NULL
           OR id <> ${params.ignoreHoldId ?? null}::uuid)
  `;

  // Contagem por dia local para o limite diário — inclui o que já passou.
  const countRows = await tx.$queryRaw<
    { professional_id: string; local_date: Date; total: bigint }[]
  >`
    SELECT professional_id,
           (starts_at AT TIME ZONE ${location.timezone})::date AS local_date,
           count(*) AS total
    FROM appointments
    WHERE professional_id = ANY(${professionalIds}::uuid[])
      AND starts_at >= ${rangeStart}
      AND starts_at < ${rangeEnd}
      AND status <> ALL(${[...TERMINAL_STATUSES]}::appointment_status[])
    GROUP BY professional_id, local_date
  `;

  const countsByDate = new Map<string, Map<string, number>>();
  for (const row of countRows) {
    const date = row.local_date.toISOString().slice(0, 10);
    const bucket = countsByDate.get(date) ?? new Map<string, number>();
    bucket.set(row.professional_id, Number(row.total));
    countsByDate.set(date, bucket);
  }

  // ---- Recursos ------------------------------------------------------------
  const poolRows = await tx.$queryRaw<{ resource_type: string; capacity: number }[]>`
    SELECT resource_type, capacity FROM resource_pools WHERE location_id = ${locationId}::uuid
  `;

  const resourceUsageRows = await tx.$queryRaw<
    { resource_type: string; starts_at: Date; ends_at: Date }[]
  >`
    SELECT ar.resource_type, a.starts_at, a.ends_at
    FROM appointment_resources ar
    JOIN appointments a ON a.id = ar.appointment_id
    WHERE a.location_id = ${locationId}::uuid
      AND a.starts_at < ${rangeEnd}
      AND a.ends_at > ${rangeStart}
      AND a.status <> ALL(${[...TERMINAL_STATUSES]}::appointment_status[])
  `;

  // ---- Combos que casam exatamente com a seleção --------------------------
  const comboRows = await tx.$queryRaw<
    { id: string; declared_duration_minutes: number; component_ids: string[] }[]
  >`
    SELECT c.id,
           c.declared_duration_minutes,
           array_agg(cc.service_id::text ORDER BY cc.service_id::text) AS component_ids
    FROM service_combos c
    JOIN service_combo_components cc ON cc.combo_id = c.id
    GROUP BY c.id, c.declared_duration_minutes
    -- Casa apenas quando o conjunto de componentes é exatamente a seleção.
    -- Ambos os lados em text[] ordenado: uuid[] não tem operador de igualdade
    -- com text[], e a ordenação torna a comparação independente da ordem.
    HAVING array_agg(cc.service_id::text ORDER BY cc.service_id::text)
         = (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(${ids}::uuid[]) AS t(x))
  `;

  const comboRules: ComboRule[] = comboRows.map((row) => ({
    id: row.id,
    componentServiceIds: row.component_ids,
    declaredDurationMinutes: row.declared_duration_minutes,
  }));

  // ---- Recorte por dia -----------------------------------------------------
  const days = new Map<string, DayContext>();

  for (const date of sorted) {
    const busy = new Map<string, TimeRange[]>();
    for (const row of [...appointmentRows, ...holdRows]) {
      const range = toLocalMinutes(location.timezone, date, row.starts_at, row.ends_at);
      if (range) push(busy, row.professional_id, range);
    }

    const usageByType = new Map<string, TimeRange[]>();
    for (const row of resourceUsageRows) {
      const range = toLocalMinutes(location.timezone, date, row.starts_at, row.ends_at);
      if (range) push(usageByType, row.resource_type, range);
    }

    const exceptions = new Map<string, ScheduleException[]>();
    const blocks = new Map<string, TimeRange[]>();
    const forLocation = locationExceptions.get(date) ?? [];
    const blocksForLocation = locationBlocks.get(date) ?? [];
    for (const professionalId of professionalIds) {
      const own = professionalExceptions.get(`${date}|${professionalId}`) ?? [];
      // Exceções da unidade valem para todo mundo.
      exceptions.set(professionalId, [...own, ...forLocation]);
      // Bloqueio da unidade também: "fechado das 12h às 13h para manutenção"
      // fecha para todos os barbeiros, não só para quem foi nomeado.
      blocks.set(professionalId, [
        ...(professionalBlocks.get(`${date}|${professionalId}`) ?? []),
        ...blocksForLocation,
      ]);
    }

    days.set(date, {
      location,
      date,
      weekday: weekdayIn(location.timezone, date),
      services,
      professionals,
      weeklyPlans: plansByProfessional,
      exceptions,
      blocks,
      busy,
      appointmentCount: countsByDate.get(date) ?? new Map(),
      resourcePools: poolRows.map((row) => ({
        resourceType: row.resource_type,
        capacity: row.capacity,
        busy: usageByType.get(row.resource_type) ?? [],
      })),
      comboRules,
      faixasDePreco,
    });
  }

  return { location, dates: sorted, services, professionals, days };
}

/** Conveniência para um único dia. Delega ao carregador de intervalo. */
export async function loadDayContext(
  tx: TransactionClient,
  params: {
    readonly locationId: string;
    readonly serviceIds: readonly string[];
    readonly date: string;
    readonly professionalId?: string;
    readonly ignoreAppointmentId?: string;
    readonly ignoreHoldId?: string;
  },
): Promise<DayContext | null> {
  const range = await loadRangeContext(tx, {
    locationId: params.locationId,
    serviceIds: params.serviceIds,
    dates: [params.date],
    ...(params.professionalId ? { professionalId: params.professionalId } : {}),
    ...(params.ignoreAppointmentId ? { ignoreAppointmentId: params.ignoreAppointmentId } : {}),
    ...(params.ignoreHoldId ? { ignoreHoldId: params.ignoreHoldId } : {}),
  });
  return range?.days.get(params.date) ?? null;
}
