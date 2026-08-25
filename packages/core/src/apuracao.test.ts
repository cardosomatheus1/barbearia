import { describe, expect, it } from 'vitest';
import { ultimoDiaApurado } from './apuracao.js';

describe('último dia apurado', () => {
  it('antes das 09 UTC usa anteontem', () => {
    expect(ultimoDiaApurado(new Date('2026-08-24T00:30:00Z'))).toBe('2026-08-22');
    expect(ultimoDiaApurado(new Date('2026-08-24T08:59:59Z'))).toBe('2026-08-22');
  });

  it('a partir das 09 UTC libera ontem', () => {
    expect(ultimoDiaApurado(new Date('2026-08-24T09:00:00Z'))).toBe('2026-08-23');
    expect(ultimoDiaApurado(new Date('2026-08-24T23:59:59Z'))).toBe('2026-08-23');
  });
});
