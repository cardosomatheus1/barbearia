/**
 * Álgebra de intervalos em minutos locais.
 *
 * Todo o cálculo de disponibilidade acontece em "minutos desde a meia-noite no
 * fuso da unidade". A conversão para instante UTC é feita apenas na borda
 * (ver `zone.ts`). Isso mantém o motor puro, determinístico e testável sem
 * depender de relógio, fuso do processo ou biblioteca de data.
 *
 * SPEC Parte 2 §2.9 — o fuso do dispositivo do cliente nunca entra no cálculo.
 */

/** Minutos desde a meia-noite local. 0 = 00:00, 1439 = 23:59. */
export type Minutes = number;

/** Intervalo semiaberto [start, end). */
export interface TimeRange {
  readonly start: Minutes;
  readonly end: Minutes;
}

export const MINUTES_IN_DAY = 24 * 60;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Converte "09:30" em 570. Lança em formato inválido. */
export function parseHHMM(value: string): Minutes {
  const match = HHMM.exec(value);
  if (!match) {
    throw new RangeError(`Horário inválido: "${value}" (esperado HH:mm entre 00:00 e 23:59)`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Converte 570 em "09:30". Aceita 1440 como "24:00" (fim de expediente à meia-noite). */
export function formatHHMM(minutes: Minutes): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MINUTES_IN_DAY) {
    throw new RangeError(`Minuto fora do dia: ${minutes}`);
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function isValidRange(range: TimeRange): boolean {
  return (
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end <= MINUTES_IN_DAY &&
    range.start < range.end
  );
}

export function duration(range: TimeRange): Minutes {
  return range.end - range.start;
}

export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function contains(outer: TimeRange, inner: TimeRange): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * Ordena e funde intervalos que se sobrepõem ou se tocam.
 * [09:00-10:00] + [10:00-11:00] => [09:00-11:00]
 */
export function normalize(ranges: readonly TimeRange[]): TimeRange[] {
  const valid = ranges.filter(isValidRange);
  if (valid.length === 0) return [];

  const sorted = [...valid].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TimeRange[] = [];

  // `sorted` tem ao menos um elemento; o índice 0 é seguro.
  let current = { start: sorted[0]!.start, end: sorted[0]!.end };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    if (next.start <= current.end) {
      // Sobreposto ou adjacente: estende.
      if (next.end > current.end) current = { start: current.start, end: next.end };
    } else {
      merged.push(current);
      current = { start: next.start, end: next.end };
    }
  }
  merged.push(current);
  return merged;
}

/**
 * Subtrai `holes` de `base`, devolvendo os pedaços livres.
 *
 * É a operação central do motor: jornada − intervalos − agendamentos − bloqueios.
 */
export function subtract(base: readonly TimeRange[], holes: readonly TimeRange[]): TimeRange[] {
  const normalizedBase = normalize(base);
  const normalizedHoles = normalize(holes);
  if (normalizedHoles.length === 0) return normalizedBase;

  const result: TimeRange[] = [];

  for (const segment of normalizedBase) {
    let cursor = segment.start;

    for (const hole of normalizedHoles) {
      if (hole.end <= cursor) continue; // buraco já passou
      if (hole.start >= segment.end) break; // buracos estão ordenados: acabou

      if (hole.start > cursor) {
        result.push({ start: cursor, end: Math.min(hole.start, segment.end) });
      }
      cursor = Math.max(cursor, hole.end);
      if (cursor >= segment.end) break;
    }

    if (cursor < segment.end) {
      result.push({ start: cursor, end: segment.end });
    }
  }

  return result.filter(isValidRange);
}

/** Interseção de dois conjuntos de intervalos. */
export function intersect(a: readonly TimeRange[], b: readonly TimeRange[]): TimeRange[] {
  const left = normalize(a);
  const right = normalize(b);
  const result: TimeRange[] = [];

  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const l = left[i]!;
    const r = right[j]!;
    const start = Math.max(l.start, r.start);
    const end = Math.min(l.end, r.end);
    if (start < end) result.push({ start, end });

    if (l.end < r.end) i++;
    else j++;
  }
  return result;
}

/**
 * Quantos intervalos de `ranges` cobrem simultaneamente qualquer ponto de `probe`.
 * Usado para capacidade de recurso: N cadeiras => no máximo N usos concorrentes.
 */
export function maxConcurrency(ranges: readonly TimeRange[], probe: TimeRange): number {
  const events: Array<{ at: Minutes; delta: number }> = [];

  for (const range of ranges) {
    if (!isValidRange(range) || !overlaps(range, probe)) continue;
    events.push({ at: Math.max(range.start, probe.start), delta: 1 });
    events.push({ at: Math.min(range.end, probe.end), delta: -1 });
  }
  if (events.length === 0) return 0;

  // Saídas antes de entradas no mesmo instante: intervalo semiaberto não conflita
  // com o que termina exatamente onde ele começa.
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);

  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    if (current > peak) peak = current;
  }
  return peak;
}
