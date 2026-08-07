import { parseDate } from '@barbearia/core';

/** Datas locais YYYY-MM-DD, inclusivas. */
export function datesBetween(from: string, to: string, maxDays: number): string[] {
  const start = parseDate(from);
  const end = parseDate(to);

  const startUtc = Date.UTC(start.year, start.month - 1, start.day);
  const endUtc = Date.UTC(end.year, end.month - 1, end.day);

  if (endUtc < startUtc) {
    throw new RangeError(`Intervalo invertido: ${from} > ${to}`);
  }

  const days = Math.floor((endUtc - startUtc) / 86_400_000) + 1;
  if (days > maxDays) {
    // Limite explícito: sem ele, um único pedido varre anos de agenda e vira
    // negação de serviço barata (CLAUDE.md §2).
    throw new RangeError(`Intervalo de ${days} dias excede o máximo de ${maxDays}`);
  }

  const result: string[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(startUtc + i * 86_400_000);
    result.push(day.toISOString().slice(0, 10));
  }
  return result;
}
