import type { TransactionClient } from '@barbearia/db';
import {
  localToInstant,
  weekdayIn,
  type ComboRule,
  type ScheduleException,
  type TimeRange,
  type WeeklyPlan,
} from '@barbearia/core';

/**
 * Carrega tudo que o motor de disponibilidade precisa para uma data.
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
  readonly timezone: string;
  readonly slotStrategy: 'anchored' | 'grid';
  readonly bufferPolicy: 'outer' | 'per_service';
  readonly granularityMinutes: number;
  readonly minLeadMinutes: number;
  readonly maxLeadDays: number;
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
  /** Sobrescritas do profissional, por serviço. */
  readonly overrides: ReadonlyMap<string, { priceCents: number | null; durationMinutes: number | null }>;
}

export interface DayContext {
  readonly location: LocationSettings;
  readonly weekday: number;
  readonly services: readonly ServiceRow[];
  readonly professionals: readonly QualifiedProfessional[];
  readonly weeklyPlans: ReadonlyMap<string, WeeklyPlan[]>;
  readonly exceptions: ReadonlyMap<string, ScheduleException[]>;
  readonly busy: ReadonlyMap<string, TimeRange[]>;
  readonly appointmentCount: ReadonlyMap<string, number>;
  readonly resourcePools: readonly { resourceType: string; capacity: number; busy: TimeRange[] }[];
  readonly comboRules: readonly ComboRule[];
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

export async function loadDayContext(
  tx: TransactionClient,
  params: {
    readonly locationId: string;
    readonly serviceIds: readonly string[];
    readonly date: string;
    readonly professionalId?: string;
  },
): Promise<DayContext | null> {
  const { locationId, serviceIds, date } = params;
  if (serviceIds.length === 0) throw new RangeError('Nenhum serviço selecionado');

  const locationRows = await tx.$queryRaw<
    {
      id: string;
      timezone: string;
      slot_strategy: 'anchored' | 'grid';
      buffer_policy: 'outer' | 'per_service';
      granularity_minutes: number;
      min_lead_minutes: number;
      max_lead_days: number;
    }[]
  >`
    SELECT id, timezone, slot_strategy, buffer_policy,
           granularity_minutes, min_lead_minutes, max_lead_days
    FROM locations WHERE id = ${locationId}::uuid
  `;
  const locationRow = locationRows[0];
  if (!locationRow) return null;

  const location: LocationSettings = {
    id: locationRow.id,
    timezone: locationRow.timezone,
    slotStrategy: locationRow.slot_strategy,
    bufferPolicy: locationRow.buffer_policy,
    granularityMinutes: locationRow.granularity_minutes,
    minLeadMinutes: locationRow.min_lead_minutes,
    maxLeadDays: locationRow.max_lead_days,
  };

  const weekday = weekdayIn(location.timezone, date);
  const ids = [...serviceIds];

  // ---- Serviços e exigências de recurso ------------------------------------
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
    const bucket = requirementsByService.get(row.service_id) ?? [];
    bucket.push({ resourceType: row.resource_type, quantity: row.quantity });
    requirementsByService.set(row.service_id, bucket);
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

  // ---- Profissionais habilitados em TODOS os serviços ----------------------
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

  if (professionalRows.length === 0) {
    return {
      location, weekday, services, professionals: [],
      weeklyPlans: new Map(), exceptions: new Map(), busy: new Map(),
      appointmentCount: new Map(), resourcePools: [], comboRules: [],
    };
  }

  const professionalIds = professionalRows.map((row) => row.id);

  const overrideRows = await tx.$queryRaw<
    { professional_id: string; service_id: string; price_cents: number | null; duration_minutes: number | null }[]
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

  // ---- Jornadas -----------------------------------------------------------
  const scheduleRows = await tx.$queryRaw<
    { professional_id: string; weekday: number; start_minute: number; end_minute: number; breaks: unknown }[]
  >`
    SELECT professional_id, weekday, start_minute, end_minute, breaks
    FROM work_schedules
    WHERE professional_id = ANY(${professionalIds}::uuid[]) AND weekday = ${weekday}
  `;

  const weeklyPlans = new Map<string, WeeklyPlan[]>();
  for (const row of scheduleRows) {
    const breaks = Array.isArray(row.breaks)
      ? (row.breaks as TimeRange[]).filter(
          (item) => typeof item?.start === 'number' && typeof item?.end === 'number',
        )
      : [];
    const bucket = weeklyPlans.get(row.professional_id) ?? [];
    bucket.push({ weekday: row.weekday, start: row.start_minute, end: row.end_minute, breaks });
    weeklyPlans.set(row.professional_id, bucket);
  }

  // ---- Exceções da data ---------------------------------------------------
  const exceptionRows = await tx.$queryRaw<
    {
      professional_id: string | null;
      location_id: string | null;
      kind: 'custom_hours' | 'day_off' | 'holiday' | 'vacation';
      start_minute: number | null;
      end_minute: number | null;
      reason: string | null;
    }[]
  >`
    SELECT professional_id, location_id, kind, start_minute, end_minute, reason
    FROM schedule_exceptions
    WHERE on_date = ${date}::date
      AND (professional_id = ANY(${professionalIds}::uuid[])
           OR location_id = ${locationId}::uuid)
  `;

  const exceptions = new Map<string, ScheduleException[]>();
  const locationExceptions: ScheduleException[] = [];

  for (const row of exceptionRows) {
    const item: ScheduleException = {
      kind: row.kind,
      scope: row.professional_id ? 'professional' : 'location',
      ...(row.start_minute !== null ? { start: row.start_minute } : {}),
      ...(row.end_minute !== null ? { end: row.end_minute } : {}),
      ...(row.reason !== null ? { reason: row.reason } : {}),
    };
    if (row.professional_id) {
      const bucket = exceptions.get(row.professional_id) ?? [];
      bucket.push(item);
      exceptions.set(row.professional_id, bucket);
    } else {
      locationExceptions.push(item);
    }
  }
  // Exceções da unidade valem para todo mundo.
  for (const professionalId of professionalIds) {
    exceptions.set(professionalId, [...(exceptions.get(professionalId) ?? []), ...locationExceptions]);
  }

  // ---- Ocupação: agendamentos ativos + reservas temporárias ----------------
  const dayStart = localToInstant(location.timezone, date, 0);
  const dayEnd = localToInstant(location.timezone, date, 24 * 60);

  const appointmentRows = await tx.$queryRaw<
    { professional_id: string; starts_at: Date; ends_at: Date }[]
  >`
    SELECT professional_id, starts_at, ends_at
    FROM appointments
    WHERE professional_id = ANY(${professionalIds}::uuid[])
      AND starts_at < ${dayEnd}
      AND ends_at > ${dayStart}
      AND status <> ALL(${[...TERMINAL_STATUSES]}::appointment_status[])
  `;

  const holdRows = await tx.$queryRaw<
    { professional_id: string; starts_at: Date; ends_at: Date }[]
  >`
    SELECT professional_id, starts_at, ends_at
    FROM slot_holds
    WHERE professional_id = ANY(${professionalIds}::uuid[])
      AND starts_at < ${dayEnd}
      AND ends_at > ${dayStart}
      AND expires_at > now()
  `;

  const busy = new Map<string, TimeRange[]>();
  for (const row of [...appointmentRows, ...holdRows]) {
    const range = toLocalMinutes(location.timezone, date, row.starts_at, row.ends_at);
    if (!range) continue;
    const bucket = busy.get(row.professional_id) ?? [];
    bucket.push(range);
    busy.set(row.professional_id, bucket);
  }

  // Contagem do dia inteiro para o limite diário — inclui o que já passou.
  const countRows = await tx.$queryRaw<{ professional_id: string; total: bigint }[]>`
    SELECT professional_id, count(*) AS total
    FROM appointments
    WHERE professional_id = ANY(${professionalIds}::uuid[])
      AND starts_at >= ${dayStart}
      AND starts_at < ${dayEnd}
      AND status <> ALL(${[...TERMINAL_STATUSES]}::appointment_status[])
    GROUP BY professional_id
  `;
  const appointmentCount = new Map(countRows.map((row) => [row.professional_id, Number(row.total)]));

  // ---- Recursos -----------------------------------------------------------
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
      AND a.starts_at < ${dayEnd}
      AND a.ends_at > ${dayStart}
      AND a.status <> ALL(${[...TERMINAL_STATUSES]}::appointment_status[])
  `;

  const usageByType = new Map<string, TimeRange[]>();
  for (const row of resourceUsageRows) {
    const range = toLocalMinutes(location.timezone, date, row.starts_at, row.ends_at);
    if (!range) continue;
    const bucket = usageByType.get(row.resource_type) ?? [];
    bucket.push(range);
    usageByType.set(row.resource_type, bucket);
  }

  const resourcePools = poolRows.map((row) => ({
    resourceType: row.resource_type,
    capacity: row.capacity,
    busy: usageByType.get(row.resource_type) ?? [],
  }));

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

  return {
    location, weekday, services, professionals,
    weeklyPlans, exceptions, busy, appointmentCount, resourcePools, comboRules,
  };
}
