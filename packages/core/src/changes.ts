/**
 * Quando o cliente ainda pode mexer no próprio agendamento.
 *
 * Lógica pura: recebe quantos minutos faltam para o serviço começar e quantas
 * vezes o horário já foi remarcado. Nada de relógio aqui — quem lê a hora é a
 * borda, e é isso que torna estes casos testáveis sem congelar tempo.
 *
 * A SPEC (Parte 2 §2.7) pede as três regras como configuráveis: antecedência
 * mínima para cancelar, para remarcar, e teto de remarcações.
 */

export interface ChangeWindow {
  readonly cancelMinHours: number;
  readonly rescheduleMinHours: number;
  readonly maxReschedules: number;
}

export type ChangeRefusal = 'too_late' | 'too_many_reschedules' | 'already_started';

export type ChangeDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: ChangeRefusal; readonly minHours: number };

/**
 * Já passou da hora?
 *
 * Separado do limite de antecedência porque as duas recusas pedem textos
 * diferentes: "já começou" não tem conserto, "faltam menos de 2 horas" o
 * cliente entende como regra da casa e liga para a barbearia.
 */
function started(minutesUntilStart: number): boolean {
  return minutesUntilStart <= 0;
}

export function canCancel(
  minutesUntilStart: number,
  window: Pick<ChangeWindow, 'cancelMinHours'>,
): ChangeDecision {
  if (started(minutesUntilStart)) {
    return { allowed: false, refusal: 'already_started', minHours: window.cancelMinHours };
  }
  if (minutesUntilStart < window.cancelMinHours * 60) {
    return { allowed: false, refusal: 'too_late', minHours: window.cancelMinHours };
  }
  return { allowed: true };
}

export function canReschedule(
  minutesUntilStart: number,
  timesRescheduled: number,
  window: Pick<ChangeWindow, 'rescheduleMinHours' | 'maxReschedules'>,
): ChangeDecision {
  if (started(minutesUntilStart)) {
    return { allowed: false, refusal: 'already_started', minHours: window.rescheduleMinHours };
  }
  // O teto vem antes da antecedência: quem já esgotou as remarcações não deve
  // ver "remarque com mais antecedência", porque não vai adiantar.
  if (timesRescheduled >= window.maxReschedules) {
    return {
      allowed: false,
      refusal: 'too_many_reschedules',
      minHours: window.rescheduleMinHours,
    };
  }
  if (minutesUntilStart < window.rescheduleMinHours * 60) {
    return { allowed: false, refusal: 'too_late', minHours: window.rescheduleMinHours };
  }
  return { allowed: true };
}

/** Minutos entre dois instantes, truncados. A borda converte; o núcleo conta. */
export function minutesBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 60000);
}
