/**
 * A vida de um atendimento no dia.
 *
 * Lógica pura: quais transições existem, e o que a recepção precisa enxergar
 * sobre quem ainda não chegou. Sem banco e sem relógio — o "agora" entra por
 * parâmetro, como no resto de `core`.
 *
 * A máquina de estados é a da SPEC (Parte 2 §2.11) e já estava no schema desde
 * o bloco 1. Até aqui ninguém a percorria: todo agendamento nascia `pending` e
 * morria `pending`.
 */

export type AppointmentStatus =
  | 'pending'
  | 'confirmed'
  | 'checked_in'
  | 'waiting'
  | 'in_progress'
  | 'completed'
  | 'cancelled_customer'
  | 'cancelled_business'
  | 'no_show'
  | 'rescheduled';

/** O que o balcão pode fazer com um atendimento. */
export type AttendanceAction =
  | 'confirm'
  | 'check_in'
  | 'wait'
  | 'start'
  | 'complete'
  | 'no_show'
  | 'undo_no_show'
  | 'cancel';

/**
 * Transições permitidas, por estado de origem.
 *
 * Duas escolhas que merecem explicação:
 *
 * - **`pending` aceita `check_in` direto.** O cliente que chega sem ter
 *   confirmado é o caso comum, não a exceção; obrigar a recepção a confirmar
 *   antes de marcar presença seria um toque a mais com o cliente na frente dela.
 *
 * - **`checked_in` e `waiting` ainda aceitam `no_show`.** Parece contraditório —
 *   a pessoa chegou —, mas é o cliente que cansou de esperar e foi embora. Sem
 *   isso a recepção teria que cancelar em nome da barbearia, e o registro diria
 *   que a culpa foi da casa.
 */
const TRANSICOES: Readonly<Record<AppointmentStatus, readonly AttendanceAction[]>> = {
  pending: ['confirm', 'check_in', 'no_show', 'cancel'],
  confirmed: ['check_in', 'no_show', 'cancel'],
  checked_in: ['wait', 'start', 'no_show', 'cancel'],
  waiting: ['start', 'no_show', 'cancel'],
  in_progress: ['complete', 'cancel'],
  completed: [],
  cancelled_customer: [],
  cancelled_business: [],
  // Reversão manual da falta, que a SPEC §2.11 exige explicitamente: marcar
  // falta por engano não pode ser definitivo.
  no_show: ['undo_no_show'],
  rescheduled: [],
};

const DESTINO: Readonly<Record<AttendanceAction, AppointmentStatus>> = {
  confirm: 'confirmed',
  check_in: 'checked_in',
  wait: 'waiting',
  start: 'in_progress',
  complete: 'completed',
  no_show: 'no_show',
  // Volta como "chegou": desfazer a falta é dizer que o cliente estava lá.
  undo_no_show: 'checked_in',
  cancel: 'cancelled_business',
};

export function allowedActions(status: AppointmentStatus): readonly AttendanceAction[] {
  return TRANSICOES[status] ?? [];
}

export function canApply(status: AppointmentStatus, action: AttendanceAction): boolean {
  return allowedActions(status).includes(action);
}

export function statusAfter(action: AttendanceAction): AppointmentStatus {
  return DESTINO[action];
}

/** Situação de quem ainda não chegou, do ponto de vista de quem olha a tela. */
export type Punctuality =
  | { readonly kind: 'upcoming'; readonly minutesUntil: number }
  | { readonly kind: 'due' }
  | { readonly kind: 'late'; readonly minutesLate: number; readonly noShowInMinutes: number }
  | { readonly kind: 'no_show_due'; readonly minutesLate: number };

/**
 * Quanto falta, ou quanto já passou.
 *
 * `noShowInMinutes` é quanto ainda falta da tolerância da unidade — e desde o
 * bloco 20 ele é uma **contagem regressiva de verdade**: passado o prazo, a
 * tarefa `agendamento.marcar_falta` vira o status sozinha. O aviso continua
 * existindo pelo mesmo motivo de antes, invertido: a recepção precisa poder
 * fazer check-in antes de o sistema decidir por ela.
 *
 * `toleranceMinutes` zero significa que a unidade não tem prazo de tolerância;
 * aí o atrasado permanece atrasado até alguém decidir.
 */
export function punctuality(
  minutesSinceStart: number,
  toleranceMinutes: number,
): Punctuality {
  if (minutesSinceStart < 0) return { kind: 'upcoming', minutesUntil: -minutesSinceStart };
  if (minutesSinceStart === 0) return { kind: 'due' };

  if (toleranceMinutes <= 0) {
    return { kind: 'late', minutesLate: minutesSinceStart, noShowInMinutes: Infinity };
  }
  if (minutesSinceStart >= toleranceMinutes) {
    return { kind: 'no_show_due', minutesLate: minutesSinceStart };
  }
  return {
    kind: 'late',
    minutesLate: minutesSinceStart,
    noShowInMinutes: toleranceMinutes - minutesSinceStart,
  };
}

/**
 * Duração real de um atendimento, em minutos.
 *
 * `null` quando não terminou. É o insumo da estimativa de espera da fila
 * presencial (SPEC §2.10), que precisa da duração **praticada**, não da
 * cadastrada — barbeiro que leva 40 minutos no corte de 30 faz a fila inteira
 * mentir se a conta usar o catálogo.
 */
export function realDuration(startedAt: Date | null, completedAt: Date | null): number | null {
  if (!startedAt || !completedAt) return null;
  const minutos = Math.round((completedAt.getTime() - startedAt.getTime()) / 60000);
  return minutos >= 0 ? minutos : null;
}
