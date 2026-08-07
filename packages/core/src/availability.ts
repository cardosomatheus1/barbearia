import {
  MINUTES_IN_DAY,
  formatHHMM,
  maxConcurrency,
  normalize,
  parseHHMM,
  saturatedRanges,
  subtract,
  type Minutes,
  type TimeRange,
} from './time.js';
import { resolveDuration, type ResolvedDuration } from './duration.js';
import { DEFAULT_GRANULARITY, generateStarts } from './slots.js';
import type {
  AvailabilityQuery,
  AvailabilityResult,
  ProfessionalDay,
  ResourcePool,
  ResourceRequirement,
  Service,
  Slot,
  UnavailableReason,
} from './types.js';

/**
 * Necessidade de recurso do conjunto de serviços escolhido.
 *
 * Agrega por **máximo**, não por soma: se o corte precisa de 1 cadeira e a barba
 * precisa de 1 cadeira, a visita inteira usa 1 cadeira — é a mesma. Somar
 * derrubaria a capacidade da unidade sem motivo.
 */
export function aggregateResourceNeeds(services: readonly Service[]): ResourceRequirement[] {
  const byType = new Map<string, number>();

  for (const service of services) {
    for (const requirement of service.requiredResources ?? []) {
      if (requirement.quantity <= 0) continue;
      const current = byType.get(requirement.resourceType) ?? 0;
      if (requirement.quantity > current) byType.set(requirement.resourceType, requirement.quantity);
    }
  }

  return [...byType].map(([resourceType, quantity]) => ({ resourceType, quantity }));
}

function hasResourceCapacity(
  probe: TimeRange,
  needs: readonly ResourceRequirement[],
  pools: ReadonlyMap<string, ResourcePool>,
): boolean {
  for (const need of needs) {
    const pool = pools.get(need.resourceType);
    // Recurso exigido que a unidade não cadastrou: trata como indisponível em vez
    // de ignorar em silêncio. Um serviço que exige maca numa unidade sem maca não
    // pode ser agendado.
    if (!pool) return false;

    const inUse = maxConcurrency(pool.busy ?? [], probe);
    if (inUse + need.quantity > pool.capacity) return false;
  }
  return true;
}

/** Janelas livres do profissional: jornada − intervalos − agendamentos − bloqueios. */
export function freeWindows(
  professional: ProfessionalDay,
  resourceHoles: readonly TimeRange[] = [],
): TimeRange[] {
  const holes = [
    ...(professional.breaks ?? []),
    ...(professional.busy ?? []),
    ...(professional.blocks ?? []),
    ...resourceHoles,
  ];
  return subtract(normalize(professional.working), holes);
}

/**
 * Faixas do dia em que algum recurso exigido está saturado.
 *
 * São subtraídas da janela livre **antes** da geração de slots, para que o
 * ancoramento também valha para recurso: quando a cadeira libera às 09:20, o
 * próximo slot nasce às 09:20 e não no próximo ponto da grade.
 */
export function resourceHoles(
  needs: readonly ResourceRequirement[],
  pools: ReadonlyMap<string, ResourcePool>,
): TimeRange[] {
  const holes: TimeRange[] = [];

  for (const need of needs) {
    const pool = pools.get(need.resourceType);
    // Recurso exigido que a unidade não cadastrou: o dia inteiro é inviável.
    if (!pool) return [{ start: 0, end: MINUTES_IN_DAY }];
    holes.push(...saturatedRanges(pool.busy ?? [], pool.capacity, need.quantity));
  }

  return normalize(holes);
}

interface Diagnostics {
  anyWorking: boolean;
  anyFreeWindow: boolean;
  anyCandidateStart: boolean;
  blockedByResource: boolean;
  blockedByCutoff: boolean;
  limitReached: boolean;
}

function resolveReason(diagnostics: Diagnostics, professionalCount: number): UnavailableReason {
  if (professionalCount === 0) return 'no_qualified_professional';
  if (!diagnostics.anyWorking) return 'closed';
  if (diagnostics.limitReached && !diagnostics.anyFreeWindow) return 'daily_limit_reached';
  if (diagnostics.blockedByResource && !diagnostics.anyCandidateStart) return 'resource_unavailable';
  if (diagnostics.blockedByCutoff && !diagnostics.anyCandidateStart) return 'past_cutoff';
  if (diagnostics.blockedByResource) return 'resource_unavailable';
  return 'fully_booked';
}

/**
 * Calcula os horários disponíveis para um dia.
 *
 * Função pura: não lê relógio, não acessa banco, não depende do fuso do processo.
 * Todo o cálculo acontece em minutos locais da unidade; o chamador converte para
 * instantes UTC na borda (SPEC Parte 2 §2.9 — resolve o defeito D2, em que o
 * sistema analisado usava o fuso do dispositivo do cliente).
 */
export function computeAvailability(query: AvailabilityQuery): AvailabilityResult {
  const strategy = query.strategy ?? 'anchored';
  const granularity = query.granularityMinutes ?? DEFAULT_GRANULARITY[strategy];

  const duration: ResolvedDuration = resolveDuration(query.services, {
    ...(query.comboRules ? { comboRules: query.comboRules } : {}),
    ...(query.bufferPolicy ? { bufferPolicy: query.bufferPolicy } : {}),
  });

  const needs = aggregateResourceNeeds(query.services);
  const pools = new Map((query.resourcePools ?? []).map((pool) => [pool.resourceType, pool]));
  const holes = resourceHoles(needs, pools);

  const diagnostics: Diagnostics = {
    anyWorking: false,
    anyFreeWindow: false,
    anyCandidateStart: false,
    blockedByResource: false,
    blockedByCutoff: false,
    limitReached: false,
  };

  const slots: Slot[] = [];

  for (const professional of query.professionals) {
    const working = normalize(professional.working);
    if (working.length > 0) diagnostics.anyWorking = true;

    const limit = professional.dailyLimit;
    if (limit !== undefined && (professional.appointmentCount ?? 0) >= limit) {
      diagnostics.limitReached = true;
      continue;
    }

    // Calculado uma vez: é a função mais quente do motor.
    const windows = freeWindows(professional, holes);
    if (holes.length > 0 && windows.length === 0 && freeWindows(professional).length > 0) {
      diagnostics.blockedByResource = true;
    }

    for (const window of windows) {
      diagnostics.anyFreeWindow = true;

      for (const start of generateStarts(window, duration.occupiedMinutes, granularity, strategy)) {
        if (query.earliestStartMinute !== undefined && start < query.earliestStartMinute) {
          diagnostics.blockedByCutoff = true;
          continue;
        }

        const occupied: TimeRange = { start, end: start + duration.occupiedMinutes };
        // As faixas saturadas já foram recortadas da janela; esta checagem é
        // rede de segurança e não deveria disparar.
        if (!hasResourceCapacity(occupied, needs, pools)) {
          diagnostics.blockedByResource = true;
          continue;
        }

        diagnostics.anyCandidateStart = true;

        const serviceStart = start + duration.bufferBefore;
        slots.push({
          start: formatHHMM(serviceStart),
          end: formatHHMM(serviceStart + duration.serviceMinutes),
          occupiedEnd: formatHHMM(occupied.end),
          professionalId: professional.professionalId,
          ...(professional.price !== undefined ? { price: professional.price } : {}),
        });
      }
    }
  }

  slots.sort(
    (a, b) => a.start.localeCompare(b.start) || a.professionalId.localeCompare(b.professionalId),
  );

  const reason = slots.length > 0 ? null : resolveReason(diagnostics, query.professionals.length);

  return {
    date: query.date,
    totalDurationMinutes: duration.occupiedMinutes,
    serviceDurationMinutes: duration.serviceMinutes,
    granularityMinutes: granularity,
    strategy,
    slots,
    unavailableReason: reason,
    // Não faz sentido oferecer fila para dia fechado ou serviço sem profissional
    // habilitado: nenhuma vaga vai surgir por cancelamento.
    waitlistAvailable:
      reason === 'fully_booked' ||
      reason === 'daily_limit_reached' ||
      reason === 'resource_unavailable',
  };
}

/** Estratégia de desempate quando o mesmo horário existe em vários profissionais. */
export type AssignmentStrategy =
  | 'preferred_first'
  | 'balance_load'
  | 'maximize_density'
  | 'round_robin';

export interface CollapseContext {
  readonly strategy?: AssignmentStrategy;
  /** Profissional habitual do cliente. */
  readonly preferredProfessionalId?: string;
  /** Carga atual por profissional, para `balance_load`. */
  readonly loadByProfessional?: ReadonlyMap<string, number>;
  /** Janelas ocupadas por profissional, para `maximize_density`. */
  readonly busyByProfessional?: ReadonlyMap<string, readonly TimeRange[]>;
}

function densityScore(
  slot: Slot,
  busyByProfessional: ReadonlyMap<string, readonly TimeRange[]> | undefined,
): number {
  const busy = busyByProfessional?.get(slot.professionalId);
  if (!busy || busy.length === 0) return 0;

  const startMinute = parseHHMM(slot.start);
  // Quanto mais perto de um atendimento existente, melhor: evita buraco morto.
  let best = Number.POSITIVE_INFINITY;
  for (const range of busy) {
    best = Math.min(best, Math.abs(range.end - startMinute), Math.abs(range.start - startMinute));
  }
  return -best;
}

/**
 * Colapsa a união de slots em um por horário, para o fluxo "qualquer profissional".
 *
 * O cliente vê apenas "10:20 — disponível"; o profissional é revelado na
 * confirmação e pode ser trocado antes de fechar (SPEC Parte 2 §2.5).
 */
export function collapseByStart(
  slots: readonly Slot[],
  context: CollapseContext = {},
): Slot[] {
  const strategy = context.strategy ?? 'preferred_first';
  const byStart = new Map<string, Slot[]>();

  for (const slot of slots) {
    const bucket = byStart.get(slot.start);
    if (bucket) bucket.push(slot);
    else byStart.set(slot.start, [slot]);
  }

  const roundRobinSeen = new Map<string, number>();
  const chosen: Slot[] = [];

  for (const [, candidates] of [...byStart].sort(([a], [b]) => a.localeCompare(b))) {
    let winner = candidates[0]!;

    for (const candidate of candidates.slice(1)) {
      let better = false;

      switch (strategy) {
        case 'preferred_first': {
          const preferred = context.preferredProfessionalId;
          better =
            preferred !== undefined &&
            candidate.professionalId === preferred &&
            winner.professionalId !== preferred;
          break;
        }
        case 'balance_load': {
          const load = context.loadByProfessional;
          better =
            (load?.get(candidate.professionalId) ?? 0) < (load?.get(winner.professionalId) ?? 0);
          break;
        }
        case 'maximize_density': {
          better =
            densityScore(candidate, context.busyByProfessional) >
            densityScore(winner, context.busyByProfessional);
          break;
        }
        case 'round_robin': {
          better =
            (roundRobinSeen.get(candidate.professionalId) ?? 0) <
            (roundRobinSeen.get(winner.professionalId) ?? 0);
          break;
        }
      }

      if (better) winner = candidate;
    }

    roundRobinSeen.set(winner.professionalId, (roundRobinSeen.get(winner.professionalId) ?? 0) + 1);
    chosen.push(winner);
  }

  return chosen;
}
