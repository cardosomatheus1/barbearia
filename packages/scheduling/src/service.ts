import { withTenant } from '@barbearia/db';
import {
  collapseByStart,
  computeAvailability,
  cutoffMinuteFor,
  localToInstant,
  parseHHMM,
  resolveWorkingDay,
  type AssignmentStrategy,
  type Service,
  type Slot,
  type UnavailableReason,
} from '@barbearia/core';
import { loadRangeContext, type DayContext } from './repository.js';
import { datesBetween } from './range.js';

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
      // O motor aceitava `blocks` desde o bloco 1, mas o repositório passava
      // vazio: o barbeiro não tinha como fechar uma hora do dia.
      blocks: context.blocks.get(professional.id) ?? [],
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
      startsAt: localToInstant(location.timezone, request.date, parseHHMM(slot.start)).toISOString(),
      endsAt: localToInstant(location.timezone, request.date, parseHHMM(slot.end)).toISOString(),
    })),
    unavailableReason: reason,
    waitlistAvailable: reason !== null && WAITLIST_REASONS.has(reason),
    professionals: context.professionals.map((item) => ({ id: item.id, name: item.name })),
  };
}

/** Máximo de dias por consulta. Sem teto, um pedido varre anos de agenda. */
export const MAX_RANGE_DAYS = 14;

export interface AvailabilityRangeRequest extends Omit<AvailabilityRequest, 'date'> {
  readonly dateFrom: string;
  readonly dateTo?: string;
  /**
   * Agendamento a desconsiderar na ocupação.
   *
   * Existe para a grade de **remarcação**, que precisa ser a mesma que a
   * gravação vai validar. Sem isso as duas divergem: com a estratégia
   * `anchored`, o horário atual do cliente ancora a grade exibida, e ao gravar
   * — quando ele é ignorado — a grade recomeça do início da jornada e nenhum
   * dos horários oferecidos existe mais. Toda escolha era recusada.
   */
  readonly ignoreAppointmentId?: string;
}

export interface AvailabilityRangeResponse {
  readonly timezone: string;
  readonly strategy: 'anchored' | 'grid';
  readonly granularityMinutes: number;
  readonly days: readonly AvailabilityResponse[];
}

/**
 * Ponto de entrada: abre a transação com o tenant fixado e calcula o intervalo.
 *
 * O contexto é carregado **uma vez** para todo o intervalo e recortado por dia.
 * Consultar dia a dia seria N+1 entre datas (CLAUDE.md §3).
 */
export async function getAvailabilityRange(
  request: AvailabilityRangeRequest,
): Promise<AvailabilityRangeResponse> {
  const dates = datesBetween(request.dateFrom, request.dateTo ?? request.dateFrom, MAX_RANGE_DAYS);

  return withTenant(request.tenantId, async (tx) => {
    const context = await loadRangeContext(tx, {
      locationId: request.locationId,
      serviceIds: request.serviceIds,
      dates,
      ...(request.professionalId ? { professionalId: request.professionalId } : {}),
      ...(request.ignoreAppointmentId
        ? { ignoreAppointmentId: request.ignoreAppointmentId }
        : {}),
    });

    if (!context) {
      return {
        timezone: 'UTC',
        strategy: 'anchored' as const,
        granularityMinutes: 0,
        days: dates.map((date) => emptyResponse(date, 'unknown_location')),
      };
    }

    return {
      timezone: context.location.timezone,
      strategy: context.location.slotStrategy,
      granularityMinutes: context.location.granularityMinutes,
      days: dates.map((date) => {
        const day = context.days.get(date);
        if (!day) return emptyResponse(date, 'unknown_location', context.location.timezone);
        return computeFromContext(day, { ...request, date });
      }),
    };
  });
}

/** Conveniência para um único dia. */
export async function getAvailability(
  request: AvailabilityRequest,
): Promise<AvailabilityResponse> {
  const range = await getAvailabilityRange({ ...request, dateFrom: request.date });
  return range.days[0] ?? emptyResponse(request.date, 'unknown_location');
}
