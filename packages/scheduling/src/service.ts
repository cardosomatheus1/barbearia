import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  collapseByStart,
  computeAvailability,
  cutoffMinuteFor,
  localToInstant,
  resolveWorkingDay,
  type AssignmentStrategy,
  type Service,
  type Slot,
  type UnavailableReason,
} from '@barbearia/core';
import { loadDayContext, type DayContext } from './repository.js';

export type AvailabilityReason =
  | UnavailableReason
  | 'unknown_location'
  | 'unknown_service'
  | 'beyond_booking_window';

export interface AvailabilityRequest {
  readonly tenantId: string;
  readonly locationId: string;
  readonly serviceIds: readonly string[];
  readonly date: string;
  readonly professionalId?: string;
  /** Colapsa em um slot por horário — fluxo "qualquer profissional". */
  readonly collapse?: boolean;
  readonly assignmentStrategy?: AssignmentStrategy;
  readonly preferredProfessionalId?: string;
  /** Injetável para teste; default é o relógio real. */
  readonly now?: Date;
}

export interface AvailabilityResponse {
  readonly date: string;
  readonly timezone: string;
  readonly granularityMinutes: number;
  readonly strategy: 'anchored' | 'grid';
  readonly totalDurationMinutes: number;
  readonly serviceDurationMinutes: number;
  readonly slots: readonly (Slot & { readonly startsAt: string; readonly endsAt: string })[];
  readonly unavailableReason: AvailabilityReason | null;
  readonly waitlistAvailable: boolean;
  readonly professionals: readonly { readonly id: string; readonly name: string }[];
}

/**
 * Precedência ao mesclar motivos de indisponibilidade entre profissionais.
 *
 * Favorece deliberadamente os motivos que habilitam lista de espera: se um
 * barbeiro está de folga e outro está lotado, a mensagem útil é "lotado, quer
 * entrar na fila?" — não "fechado".
 */
const REASON_PRIORITY: readonly UnavailableReason[] = [
  'fully_booked',
  'daily_limit_reached',
  'resource_unavailable',
  'past_cutoff',
  'closed',
  'no_qualified_professional',
];

function mergeReasons(reasons: readonly UnavailableReason[]): UnavailableReason {
  for (const candidate of REASON_PRIORITY) {
    if (reasons.includes(candidate)) return candidate;
  }
  return 'fully_booked';
}

const WAITLIST_REASONS: ReadonlySet<AvailabilityReason> = new Set([
  'fully_booked',
  'daily_limit_reached',
  'resource_unavailable',
]);

function emptyResponse(
  date: string,
  reason: AvailabilityReason,
  timezone = 'UTC',
): AvailabilityResponse {
  return {
    date,
    timezone,
    granularityMinutes: 0,
    strategy: 'anchored',
    totalDurationMinutes: 0,
    serviceDurationMinutes: 0,
    slots: [],
    unavailableReason: reason,
    waitlistAvailable: WAITLIST_REASONS.has(reason),
    professionals: [],
  };
}

/**
 * Calcula a disponibilidade a partir do contexto já carregado.
 *
 * Roda o motor **uma vez por profissional**, porque cada um pode ter duração
 * própria por serviço (`professional_services.duration_minutes`) — um barbeiro
 * sênior leva menos tempo no mesmo corte. Rodar uma vez só para todos assumiria
 * uma duração única e produziria grade errada para quem tem sobrescrita.
 *
 * N é a equipe da unidade, então o laço é pequeno.
 */
export function computeFromContext(
  context: DayContext,
  request: Pick<
    AvailabilityRequest,
    'date' | 'collapse' | 'assignmentStrategy' | 'preferredProfessionalId' | 'now'
  >,
): AvailabilityResponse {
  const { location } = context;
  const now = request.now ?? new Date();

  const maxDate = new Date(now.getTime() + location.maxLeadDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (request.date > maxDate) {
    return emptyResponse(request.date, 'beyond_booking_window', location.timezone);
  }

  const cutoff = cutoffMinuteFor(location.timezone, request.date, now, location.minLeadMinutes);

  const bufferPolicy = location.bufferPolicy === 'per_service' ? 'perService' : 'outer';
  const allSlots: Slot[] = [];
  const reasons: UnavailableReason[] = [];
  let totalDuration = 0;
  let serviceDuration = 0;

  for (const professional of context.professionals) {
    const day = resolveWorkingDay({
      weekday: context.weekday,
      weeklyPlans: context.weeklyPlans.get(professional.id) ?? [],
      exceptions: context.exceptions.get(professional.id) ?? [],
    });

    // Duração e preço deste profissional para os serviços escolhidos.
    let priceCents = 0;
    const services: Service[] = context.services.map((service) => {
      const override = professional.overrides.get(service.id);
      priceCents += override?.priceCents ?? service.priceCents;
      return {
        id: service.id,
        durationMinutes: override?.durationMinutes ?? service.durationMinutes,
        bufferBeforeMinutes: service.bufferBeforeMinutes,
        bufferAfterMinutes: service.bufferAfterMinutes,
        requiredResources: service.requiredResources,
      };
    });

    const result = computeAvailability({
      date: request.date,
      services,
      comboRules: context.comboRules,
      resourcePools: context.resourcePools,
      strategy: location.slotStrategy,
      bufferPolicy,
      granularityMinutes: location.granularityMinutes,
      ...(cutoff !== null ? { earliestStartMinute: cutoff } : {}),
      professionals: [
        {
          professionalId: professional.id,
          working: day.working,
          breaks: day.breaks,
          busy: context.busy.get(professional.id) ?? [],
          appointmentCount: context.appointmentCount.get(professional.id) ?? 0,
          ...(professional.dailyLimit !== null ? { dailyLimit: professional.dailyLimit } : {}),
          price: priceCents,
        },
      ],
    });

    totalDuration = Math.max(totalDuration, result.totalDurationMinutes);
    serviceDuration = Math.max(serviceDuration, result.serviceDurationMinutes);

    if (result.slots.length > 0) allSlots.push(...result.slots);
    else if (result.unavailableReason) reasons.push(result.unavailableReason);
  }

  let slots = allSlots.sort(
    (a, b) => a.start.localeCompare(b.start) || a.professionalId.localeCompare(b.professionalId),
  );

  if (request.collapse) {
    slots = collapseByStart(slots, {
      ...(request.assignmentStrategy ? { strategy: request.assignmentStrategy } : {}),
      ...(request.preferredProfessionalId
        ? { preferredProfessionalId: request.preferredProfessionalId }
        : {}),
      loadByProfessional: context.appointmentCount,
      busyByProfessional: context.busy,
    });
  }

  const reason =
    slots.length > 0
      ? null
      : context.professionals.length === 0
        ? 'no_qualified_professional'
        : mergeReasons(reasons);

  return {
    date: request.date,
    timezone: location.timezone,
    granularityMinutes: location.granularityMinutes,
    strategy: location.slotStrategy,
    totalDurationMinutes: totalDuration,
    serviceDurationMinutes: serviceDuration,
    // O instante UTC acompanha cada slot: o cliente exibe o horário local já
    // resolvido e o front nunca recalcula fuso.
    slots: slots.map((slot) => ({
      ...slot,
      startsAt: localToInstant(location.timezone, request.date, toMinutes(slot.start)).toISOString(),
      endsAt: localToInstant(location.timezone, request.date, toMinutes(slot.end)).toISOString(),
    })),
    unavailableReason: reason,
    waitlistAvailable: reason !== null && WAITLIST_REASONS.has(reason),
    professionals: context.professionals.map((item) => ({ id: item.id, name: item.name })),
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** Ponto de entrada: abre a transação com o tenant fixado e calcula. */
export async function getAvailability(
  request: AvailabilityRequest,
): Promise<AvailabilityResponse> {
  return withTenant(request.tenantId, async (tx) => {
    const context = await loadContextOrNull(tx, request);
    if (!context) return emptyResponse(request.date, 'unknown_location');
    return computeFromContext(context, request);
  });
}

async function loadContextOrNull(
  tx: TransactionClient,
  request: AvailabilityRequest,
): Promise<DayContext | null> {
  return loadDayContext(tx, {
    locationId: request.locationId,
    serviceIds: request.serviceIds,
    date: request.date,
    ...(request.professionalId ? { professionalId: request.professionalId } : {}),
  });
}
