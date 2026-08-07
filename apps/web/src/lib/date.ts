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
