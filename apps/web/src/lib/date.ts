/** Data local da unidade, em YYYY-MM-DD. O fuso é o da barbearia, nunca o do servidor. */
export function localDate(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts;
}

/** Soma dias a uma data local YYYY-MM-DD, sem passar por fuso. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const base = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** "seg", "ter"... no fuso da unidade. */
export function weekdayShort(timeZone: string, date: string): string {
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(`${date}T12:00:00Z`))
    .replace('.', '');
}

export function dayNumber(date: string): string {
  return date.slice(8, 10);
}

/**
 * Instante ISO em texto legível no fuso da unidade.
 *
 * O fuso é sempre o da barbearia. Formatar no fuso do servidor mostraria um
 * horário que não é o do corte — e o servidor pode estar em UTC.
 */
export function humanInstant(timeZone: string, iso: string): string {
  const quando = new Date(iso);
  const dia = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    weekday: 'long',
    day: '2-digit',
    month: 'long',
  }).format(quando);
  const hora = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(quando);
  return `${dia}, ${hora}`;
}
