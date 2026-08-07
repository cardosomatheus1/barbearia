import { intersect, normalize, subtract, type Minutes, type TimeRange } from './time.js';

/**
 * Resolução da jornada de um profissional numa data específica.
 *
 * Lógica pura: recebe a jornada semanal e as exceções já filtradas para a data,
 * devolve as janelas de trabalho. Nada de banco, nada de relógio.
 *
 * SPEC Parte 2 §2.1. A ordem de precedência é:
 *
 *   bloqueio pontual > exceção do profissional > exceção da unidade
 *   > feriado > jornada semanal
 */

export interface WeeklyPlan {
  /** 0 = domingo, 6 = sábado. */
  readonly weekday: number;
  readonly start: Minutes;
  readonly end: Minutes;
  readonly breaks?: readonly TimeRange[];
}

export type ExceptionKind = 'custom_hours' | 'day_off' | 'holiday' | 'vacation';
export type ExceptionScope = 'professional' | 'location';

export interface ScheduleException {
  readonly kind: ExceptionKind;
  readonly scope: ExceptionScope;
  /** Obrigatórios quando `kind` é `custom_hours`. */
  readonly start?: Minutes;
  readonly end?: Minutes;
  readonly reason?: string;
}

export interface ResolvedDay {
  /** Janelas em que o profissional atende. Vazio significa fechado. */
  readonly working: readonly TimeRange[];
  /** Intervalos dentro da jornada (almoço, descanso). */
  readonly breaks: readonly TimeRange[];
  /** Por que o dia ficou vazio. `null` quando há jornada. */
  readonly closedBy: ExceptionKind | 'no_weekly_plan' | null;
}

const CLOSING_KINDS: ReadonlySet<ExceptionKind> = new Set(['day_off', 'holiday', 'vacation']);

function toRange(exception: ScheduleException): TimeRange | null {
  if (exception.start === undefined || exception.end === undefined) return null;
  if (exception.start >= exception.end) return null;
  return { start: exception.start, end: exception.end };
}

function firstOfKind(
  exceptions: readonly ScheduleException[],
  scope: ExceptionScope,
  predicate: (kind: ExceptionKind) => boolean,
): ScheduleException | undefined {
  return exceptions.find((item) => item.scope === scope && predicate(item.kind));
}

/**
 * Resolve a jornada de uma data.
 *
 * Duas decisões que a SPEC deixava implícitas e que são resolvidas aqui:
 *
 * 1. **Exceção do profissional vence fechamento da unidade.** Se a barbearia
 *    marcou feriado mas um barbeiro declarou horário para aquele dia, ele
 *    atende. É o caso real de atendimento agendado em feriado — e a ordem de
 *    precedência da SPEC coloca o profissional acima da unidade.
 *
 * 2. **Horário especial da unidade recorta a jornada semanal**, em vez de
 *    substituí-la. "24/12 a unidade fecha 16:00" precisa preservar o almoço e o
 *    início normal do barbeiro, só antecipando o fim.
 */
export function resolveWorkingDay(input: {
  readonly weekday: number;
  readonly weeklyPlans: readonly WeeklyPlan[];
  readonly exceptions?: readonly ScheduleException[];
  /** Bloqueios pontuais do dia — têm a maior precedência e são sempre subtraídos. */
  readonly blocks?: readonly TimeRange[];
}): ResolvedDay {
  const exceptions = input.exceptions ?? [];
  const plan = input.weeklyPlans.find((candidate) => candidate.weekday === input.weekday);
  const weeklyBreaks = normalize(plan?.breaks ?? []);

  const empty = (closedBy: ResolvedDay['closedBy']): ResolvedDay => ({
    working: [],
    breaks: [],
    closedBy,
  });

  // 1. Folga, férias ou feriado do próprio profissional: encerra o dia.
  const professionalClosure = firstOfKind(exceptions, 'professional', (kind) =>
    CLOSING_KINDS.has(kind),
  );
  if (professionalClosure) return empty(professionalClosure.kind);

  // 2. Horário especial do profissional: autoritativo, não é recortado pela unidade.
  const professionalHours = firstOfKind(exceptions, 'professional', (kind) => kind === 'custom_hours');

  let base: TimeRange[];

  if (professionalHours) {
    const range = toRange(professionalHours);
    if (!range) return empty('custom_hours');
    base = [range];
  } else {
    // 3. Sem exceção do profissional, o fechamento da unidade vale.
    const locationClosure = firstOfKind(exceptions, 'location', (kind) => CLOSING_KINDS.has(kind));
    if (locationClosure) return empty(locationClosure.kind);

    if (!plan) return empty('no_weekly_plan');
    if (plan.start >= plan.end) return empty('no_weekly_plan');
    base = [{ start: plan.start, end: plan.end }];

    // 4. Horário especial da unidade recorta a jornada.
    const locationHours = firstOfKind(exceptions, 'location', (kind) => kind === 'custom_hours');
    if (locationHours) {
      const range = toRange(locationHours);
      if (!range) return empty('custom_hours');
      base = intersect(base, [range]);
      if (base.length === 0) return empty('custom_hours');
    }
  }

  // 5. Bloqueios pontuais recortam qualquer jornada resolvida.
  const working = subtract(base, input.blocks ?? []);
  if (working.length === 0) {
    return { working: [], breaks: [], closedBy: input.blocks?.length ? 'day_off' : 'no_weekly_plan' };
  }

  // Os intervalos continuam valendo, recortados para dentro da jornada final:
  // o almoço não deixa de existir porque o dia teve horário especial.
  return { working, breaks: intersect(weeklyBreaks, working), closedBy: null };
}
