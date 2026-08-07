import { describe, expect, it } from 'vitest';
import {
  formatHHMM,
  saturatedRanges,
  intersect,
  maxConcurrency,
  normalize,
  parseHHMM,
  subtract,
  type TimeRange,
} from './time.js';

/** Açúcar para escrever intervalos como "09:00-10:00" nos testes. */
function r(spec: string): TimeRange {
  const [start, end] = spec.split('-');
  return { start: parseHHMM(start!), end: parseHHMM(end!) };
}

function show(ranges: readonly TimeRange[]): string[] {
  return ranges.map((range) => `${formatHHMM(range.start)}-${formatHHMM(range.end)}`);
}

describe('parseHHMM / formatHHMM', () => {
  it('converte nos dois sentidos', () => {
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('09:30')).toBe(570);
    expect(parseHHMM('23:59')).toBe(1439);
    expect(formatHHMM(570)).toBe('09:30');
    expect(formatHHMM(0)).toBe('00:00');
  });

  it('aceita 24:00 como fim de expediente à meia-noite', () => {
    expect(formatHHMM(1440)).toBe('24:00');
  });

  it('rejeita formato inválido', () => {
    expect(() => parseHHMM('9:30')).toThrow();
    expect(() => parseHHMM('24:00')).toThrow();
    expect(() => parseHHMM('09:60')).toThrow();
    expect(() => parseHHMM('abc')).toThrow();
  });
});

describe('normalize', () => {
  it('ordena e funde intervalos sobrepostos', () => {
    expect(show(normalize([r('10:00-11:00'), r('09:00-10:30')]))).toEqual(['09:00-11:00']);
  });

  it('funde intervalos adjacentes', () => {
    expect(show(normalize([r('09:00-10:00'), r('10:00-11:00')]))).toEqual(['09:00-11:00']);
  });

  it('preserva intervalos separados', () => {
    expect(show(normalize([r('09:00-10:00'), r('11:00-12:00')]))).toEqual([
      '09:00-10:00',
      '11:00-12:00',
    ]);
  });

  it('descarta intervalos degenerados', () => {
    expect(normalize([{ start: 600, end: 600 }, { start: 700, end: 600 }])).toEqual([]);
  });

  it('absorve intervalo contido em outro', () => {
    expect(show(normalize([r('09:00-18:00'), r('12:00-13:00')]))).toEqual(['09:00-18:00']);
  });
});

describe('subtract', () => {
  it('remove um buraco no meio', () => {
    expect(show(subtract([r('09:00-18:00')], [r('12:00-13:00')]))).toEqual([
      '09:00-12:00',
      '13:00-18:00',
    ]);
  });

  it('remove vários buracos', () => {
    const free = subtract(
      [r('09:00-18:00')],
      [r('10:00-10:30'), r('12:00-13:00'), r('15:00-15:20')],
    );
    expect(show(free)).toEqual([
      '09:00-10:00',
      '10:30-12:00',
      '13:00-15:00',
      '15:20-18:00',
    ]);
  });

  it('lida com buracos sobrepostos entre si', () => {
    expect(show(subtract([r('09:00-18:00')], [r('12:00-14:00'), r('13:00-15:00')]))).toEqual([
      '09:00-12:00',
      '15:00-18:00',
    ]);
  });

  it('devolve vazio quando o buraco cobre tudo', () => {
    expect(subtract([r('09:00-18:00')], [r('08:00-19:00')])).toEqual([]);
  });

  it('corta nas bordas', () => {
    expect(show(subtract([r('09:00-18:00')], [r('09:00-10:00')]))).toEqual(['10:00-18:00']);
    expect(show(subtract([r('09:00-18:00')], [r('17:00-18:00')]))).toEqual(['09:00-17:00']);
  });

  it('ignora buraco fora da base', () => {
    expect(show(subtract([r('09:00-12:00')], [r('14:00-15:00')]))).toEqual(['09:00-12:00']);
  });

  it('opera sobre base com múltiplos segmentos', () => {
    const free = subtract([r('09:00-12:00'), r('14:00-18:00')], [r('11:00-15:00')]);
    expect(show(free)).toEqual(['09:00-11:00', '15:00-18:00']);
  });

  it('sem buracos devolve a base normalizada', () => {
    expect(show(subtract([r('10:00-11:00'), r('09:00-10:00')], []))).toEqual(['09:00-11:00']);
  });
});

describe('intersect', () => {
  it('devolve a sobreposição', () => {
    expect(show(intersect([r('09:00-12:00')], [r('11:00-14:00')]))).toEqual(['11:00-12:00']);
  });

  it('devolve vazio quando não há sobreposição', () => {
    expect(intersect([r('09:00-10:00')], [r('11:00-12:00')])).toEqual([]);
  });

  it('cruza múltiplos segmentos dos dois lados', () => {
    const result = intersect(
      [r('09:00-12:00'), r('14:00-18:00')],
      [r('11:00-15:00'), r('16:00-17:00')],
    );
    expect(show(result)).toEqual(['11:00-12:00', '14:00-15:00', '16:00-17:00']);
  });
});

describe('maxConcurrency', () => {
  it('conta zero sem sobreposição', () => {
    expect(maxConcurrency([r('09:00-10:00')], r('11:00-12:00'))).toBe(0);
  });

  it('conta usos simultâneos no ponto de pico', () => {
    const usage = [r('09:00-10:00'), r('09:30-10:30'), r('09:45-11:00')];
    expect(maxConcurrency(usage, r('09:00-11:00'))).toBe(3);
  });

  it('não conta intervalo que apenas encosta', () => {
    // Semiaberto: [09:00,10:00) não conflita com [10:00,11:00).
    expect(maxConcurrency([r('09:00-10:00')], r('10:00-11:00'))).toBe(0);
  });

  it('limita a contagem à sonda', () => {
    const usage = [r('08:00-09:00'), r('08:30-09:30')];
    expect(maxConcurrency(usage, r('09:00-10:00'))).toBe(1);
  });
});

describe('saturatedRanges', () => {
  it('sem uso, nada está saturado', () => {
    expect(saturatedRanges([], 2, 1)).toEqual([]);
  });

  it('capacidade 1: qualquer uso satura', () => {
    expect(show(saturatedRanges([r('09:00-09:20')], 1, 1))).toEqual(['09:00-09:20']);
  });

  it('capacidade 2: satura só onde há dois usos simultâneos', () => {
    const usage = [r('09:00-10:00'), r('09:30-10:30')];
    expect(show(saturatedRanges(usage, 2, 1))).toEqual(['09:30-10:00']);
  });

  it('funde faixas saturadas contíguas', () => {
    const usage = [r('09:00-10:00'), r('10:00-11:00')];
    expect(show(saturatedRanges(usage, 1, 1))).toEqual(['09:00-11:00']);
  });

  it('exigência maior que a capacidade satura o dia inteiro', () => {
    expect(show(saturatedRanges([], 1, 2))).toEqual(['00:00-24:00']);
  });

  it('exigência de 2 numa capacidade de 3 ainda cabe com um uso', () => {
    // 1 em uso + 2 exigidos = 3, exatamente a capacidade.
    expect(saturatedRanges([r('09:00-10:00')], 3, 2)).toEqual([]);
  });

  it('exigência de 2 numa capacidade de 3 satura com dois usos', () => {
    const usage = [r('09:00-10:00'), r('09:30-11:00')];
    // 2 em uso + 2 exigidos = 4 > 3, só onde os dois se sobrepõem.
    expect(show(saturatedRanges(usage, 3, 2))).toEqual(['09:30-10:00']);
  });

  it('exigência zero nunca satura', () => {
    expect(saturatedRanges([r('09:00-10:00')], 1, 0)).toEqual([]);
  });
});
