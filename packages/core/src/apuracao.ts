/** Hora UTC em que o dia anterior já terminou em todas as unidades suportadas. */
export const HORA_DA_APURACAO_UTC = 9;

/**
 * Último business_day que o job diário já teve oportunidade de consolidar.
 * Antes das 09:00 UTC, a apuração de ontem ainda não rodou; o último garantido
 * é anteontem. Depois do corte, ontem passa a ser seguro.
 */
export function ultimoDiaApurado(agora: Date): string {
  const recuo = agora.getUTCHours() >= HORA_DA_APURACAO_UTC ? 1 : 2;
  return new Date(
    Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate() - recuo),
  ).toISOString().slice(0, 10);
}
