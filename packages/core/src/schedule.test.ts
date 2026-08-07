import { describe, expect, it } from 'vitest';
import { resolveWorkingDay, type ScheduleException, type WeeklyPlan } from './schedule.js';
import { formatHHMM, parseHHMM, type TimeRange } from './time.js';

function r(spec: string): TimeRange {
  const [start, end] = spec.split('-');
  return { start: parseHHMM(start!), end: parseHHMM(end!) };
}

function show(ranges: readonly TimeRange[]): string[] {
  return ranges.map((range) => `${formatHHMM(range.start)}-${formatHHMM(range.end)}`);
}

/** Jornada real do Ruan no Domari: terça a sábado 09:00–18:00, segunda de folga. */
const PLANOS: WeeklyPlan[] = [
  { weekday: 2, start: parseHHMM('09:00'), end: parseHHMM('18:00'), breaks: [r('12:00-13:00')] },
  { weekday: 3, start: parseHHMM('09:00'), end: parseHHMM('18:00'), breaks: [r('12:00-13:00')] },
  { weekday: 6, start: parseHHMM('09:00'), end: parseHHMM('13:00') },
];

const TERCA = 2;
const SEGUNDA = 1;

describe('resolveWorkingDay — jornada semanal', () => {
  it('usa o plano do dia da semana', () => {
    const day = resolveWorkingDay({ weekday: TERCA, weeklyPlans: PLANOS });
    expect(show(day.working)).toEqual(['09:00-18:00']);
    expect(show(day.breaks)).toEqual(['12:00-13:00']);
    expect(day.closedBy).toBeNull();
  });

  it('dia sem plano é fechado', () => {
    const day = resolveWorkingDay({ weekday: SEGUNDA, weeklyPlans: PLANOS });
    expect(day.working).toEqual([]);
    expect(day.closedBy).toBe('no_weekly_plan');
  });

  it('dia com jornada mais curta preserva o horário próprio', () => {
    const day = resolveWorkingDay({ weekday: 6, weeklyPlans: PLANOS });
    expect(show(day.working)).toEqual(['09:00-13:00']);
    expect(day.breaks).toEqual([]);
  });
});

describe('resolveWorkingDay — exceções do profissional', () => {
  it('folga do profissional fecha o dia', () => {
    const day = resolveWorkingDay({
      weekday: TERCA,
      weeklyPlans: PLANOS,
      exceptions: [{ kind: 'day_off', scope: 'professional' }],
    });
    expect(day.working).toEqual([]);
    expect(day.closedBy).toBe('day_off');
  });

  it('férias fecham o dia', () => {
    const day = resolveWorkingDay({
      weekday: TERCA,
      weeklyPlans: PLANOS,
      exceptions: [{ kind: 'vacation', scope: 'professional' }],
    });
    expect(day.closedBy).toBe('vacation');
  });

  it('horário especial substitui a jornada semanal', () => {
    // "15/08 — João trabalhará 08:00–13:00" (SPEC Parte 2 §2.1).
    const day = resolveWorkingDay({
      weekday: TERCA,
      weeklyPlans: PLANOS,
      exceptions: [
        { kind: 'custom_hours', scope: 'professional', start: parseHHMM('08:00'), end: parseHHMM('13:00') },
      ],
    });
    expect(show(day.working)).toEqual(['08:00-13:00']);
  });

  it('horário especial mantém o almoço recortado para dentro', () => {
    const day = resolveWorkingDay({
      weekday: TERCA,
      weeklyPlans: PLANOS,
      exceptions: [
        { kind: 'custom_hours', scope: 'professional', start: parseHHMM('08:00'), end: parseHHMM('12:30') },
      ],
    });
    // O almoço é 12:00-13:00, mas o expediente acaba 12:30.
    expect(show(day.breaks)).toEqual(['12:00-12:30']);
  });

  it('horário especial descarta almoço que caiu fora', () => {
    const day = resolveWorkingDay({
      weekday: TERCA,
      weeklyPlans: PLANOS,
      exceptions: [
        { kind: 'custom_hours', scope: 'professional', start: parseHHMM('14:00'), end: parseHHMM('18:00') },
      ],
    });
    expect(day.breaks).toEqual([]);
  });
});

describe('resolveWorkingDay — exceções da unidade', () => {
  it('feriado da unidade fecha o dia', () => {
    const day = resolveWorkingDay({
      weekday: TERCA,
      weeklyPlans: PLANOS,
      exceptions: [{ kind: 'holiday', scope: 'location', reason: 'Independência da Bahia' }],
    });
    expect(day.working).toEqual([]);
    expect(day.closedBy).toBe('holiday');
  });

  it('horário especial da unidade recorta a jornada em vez de substituí-la', () => {
    // "24/12 — unidade fecha 16:00". O barbeiro começa no horário normal.
    const day = resolveWorkingDay({
      weekday: TERCA,
      weeklyPlans: PLANOS,
      exceptions: [
        { kind: 'custom_hours', scope: 'location', start: parseHHMM('09:00'), end: parseHHMM('16:00') },
      ],
    });
    expect(show(day.working)).toEqual(['09:00-16:00']);
    expect(show(day.breaks)).toEqual(['12:00-13:00']); // almoço preservado
  });

  it('horário da unidade sem interseção com a jornada fecha o dia', () => {
    const day = resolveWorkingDay({
      weekday: 6, // sábado 09:00-13:00
      weeklyPlans: PLANOS,
      exceptions: [
        { kind: 'custom_hours', scope: 'location', start: parseHHMM('18:00'), end: parseHHMM('22:00') },
      ],
    });
    expect(day.working).toEqual([]);
    expect(day.closedBy).toBe('custom_hours');
  });
});

describe('resolveWorkingDay — precedência entre escopos', () => {
  it('exceção do profissional vence fechamento da unidade', () => {
    // Barbearia fechada por feriado, mas o barbeiro declarou horário para o dia.
    const exceptions: ScheduleException[] = [
      { kind: 'holiday', scope: 'location' },
      { kind: 'custom_hours', scope: 'professional', start: parseHHMM('10:00'), end: parseHHMM('14:00') },
    ];
    const day = resolveWorkingDay({ weekday: TERCA, weeklyPlans: PLANOS, exceptions });
    expect(show(day.working)).toEqual(['10:00-14:00']);
    expect(day.closedBy).toBeNull();
  });

  it('horário do profissional não é recortado pelo horário da unidade', () => {
    const exceptions: ScheduleException[] = [
      { kind: 'custom_hours', scope: 'location', start: parseHHMM('09:00'), end: parseHHMM('16:00') },
      { kind: 'custom_hours', scope: 'professional', start: parseHHMM('08:00'), end: parseHHMM('18:00') },
    ];
    const day = resolveWorkingDay({ weekday: TERCA, weeklyPlans: PLANOS, exceptions });
    expect(show(day.working)).toEqual(['08:00-18:00']);
  });

  it('folga do profissional vence horário especial da unidade', () => {
    const exceptions: ScheduleException[] = [
      { kind: 'custom_hours', scope: 'location', start: parseHHMM('09:00'), end: parseHHMM('16:00') },
      { kind: 'day_off', scope: 'professional' },
    ];
    const day = resolveWorkingDay({ weekday: TERCA, weeklyPlans: PLANOS, exceptions });
    expect(day.working).toEqual([]);
    expect(day.closedBy).toBe('day_off');
  });
});

describe('resolveWorkingDay — bloqueios pontuais', () => {
  it('bloqueio recorta a jornada', () => {
    const day = resolveWorkingDay({
      weekday: TERCA,
      weeklyPlans: PLANOS,
      blocks: [r('15:00-16:00')],
    });
    expect(show(day.working)).toEqual(['09:00-15:00', '16:00-18:00']);
  });

  it('bloqueio vence até horário especial do profissional', () => {
    const day = resolveWorkingDay({
      weekday: TERCA,
      weeklyPlans: PLANOS,
      exceptions: [
        { kind: 'custom_hours', scope: 'professional', start: parseHHMM('08:00'), end: parseHHMM('13:00') },
      ],
      blocks: [r('09:00-10:00')],
    });
    expect(show(day.working)).toEqual(['08:00-09:00', '10:00-13:00']);
  });

  it('bloqueio que cobre a jornada inteira fecha o dia', () => {
    const day = resolveWorkingDay({
      weekday: TERCA,
      weeklyPlans: PLANOS,
      blocks: [r('08:00-19:00')],
    });
    expect(day.working).toEqual([]);
    expect(day.closedBy).toBe('day_off');
  });

  it('vários bloqueios recortam todos', () => {
    const day = resolveWorkingDay({
      weekday: TERCA,
      weeklyPlans: PLANOS,
      blocks: [r('10:00-10:30'), r('15:00-16:00')],
    });
    expect(show(day.working)).toEqual(['09:00-10:00', '10:30-15:00', '16:00-18:00']);
  });
});

describe('resolveWorkingDay — robustez', () => {
  it('custom_hours sem intervalo fecha em vez de explodir', () => {
    const day = resolveWorkingDay({
      weekday: TERCA,
      weeklyPlans: PLANOS,
      exceptions: [{ kind: 'custom_hours', scope: 'professional' }],
    });
    expect(day.working).toEqual([]);
    expect(day.closedBy).toBe('custom_hours');
  });

  it('plano degenerado é tratado como fechado', () => {
    const day = resolveWorkingDay({
      weekday: TERCA,
      weeklyPlans: [{ weekday: TERCA, start: 600, end: 600 }],
    });
    expect(day.closedBy).toBe('no_weekly_plan');
  });

  it('sem planos nem exceções, fechado', () => {
    expect(resolveWorkingDay({ weekday: TERCA, weeklyPlans: [] }).closedBy).toBe('no_weekly_plan');
  });
});
