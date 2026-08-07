import { describe, expect, it } from 'vitest';
import {
  cutoffMinuteFor,
  instantToLocal,
  localToInstant,
  offsetMinutesAt,
  parseDate,
  weekdayIn,
} from './zone.js';

const BAHIA = 'America/Bahia'; // UTC-3, sem horário de verão
const NEW_YORK = 'America/New_York'; // com DST, para provar a lógica de transição

describe('parseDate', () => {
  it('aceita data válida', () => {
    expect(parseDate('2026-08-11')).toEqual({ year: 2026, month: 8, day: 11 });
  });

  it('rejeita formato e datas inexistentes', () => {
    expect(() => parseDate('11/08/2026')).toThrow();
    expect(() => parseDate('2026-13-01')).toThrow();
    expect(() => parseDate('2026-02-31')).toThrow();
    expect(() => parseDate('2025-02-29')).toThrow();
  });

  it('aceita 29/02 em ano bissexto', () => {
    expect(parseDate('2028-02-29').day).toBe(29);
  });
});

describe('offsetMinutesAt', () => {
  it('Bahia é UTC-3 o ano inteiro', () => {
    expect(offsetMinutesAt(BAHIA, new Date('2026-01-15T12:00:00Z'))).toBe(-180);
    expect(offsetMinutesAt(BAHIA, new Date('2026-07-15T12:00:00Z'))).toBe(-180);
  });

  it('Nova York muda com o horário de verão', () => {
    expect(offsetMinutesAt(NEW_YORK, new Date('2026-01-15T12:00:00Z'))).toBe(-300);
    expect(offsetMinutesAt(NEW_YORK, new Date('2026-07-15T12:00:00Z'))).toBe(-240);
  });

  it('rejeita fuso desconhecido', () => {
    expect(() => offsetMinutesAt('Marte/Olympus', new Date())).toThrow();
  });
});

describe('localToInstant', () => {
  it('converte 09:00 na Bahia para 12:00 UTC', () => {
    const instant = localToInstant(BAHIA, '2026-08-11', 9 * 60);
    expect(instant.toISOString()).toBe('2026-08-11T12:00:00.000Z');
  });

  it('converte meia-noite local', () => {
    expect(localToInstant(BAHIA, '2026-08-11', 0).toISOString()).toBe('2026-08-11T03:00:00.000Z');
  });

  it('respeita o horário de verão de Nova York', () => {
    expect(localToInstant(NEW_YORK, '2026-01-15', 9 * 60).toISOString()).toBe(
      '2026-01-15T14:00:00.000Z',
    );
    expect(localToInstant(NEW_YORK, '2026-07-15', 9 * 60).toISOString()).toBe(
      '2026-07-15T13:00:00.000Z',
    );
  });

  it('não depende do fuso do processo', () => {
    // O resultado é idêntico independentemente de TZ do host — o cálculo usa
    // exclusivamente o fuso passado.
    const a = localToInstant(BAHIA, '2026-08-11', 570);
    expect(a.getTime()).toBe(Date.UTC(2026, 7, 11, 12, 30));
  });

  it('rejeita minuto fora do dia', () => {
    expect(() => localToInstant(BAHIA, '2026-08-11', -1)).toThrow();
    expect(() => localToInstant(BAHIA, '2026-08-11', 1441)).toThrow();
  });
});

describe('instantToLocal', () => {
  it('faz o caminho de volta', () => {
    const local = instantToLocal(BAHIA, new Date('2026-08-11T12:30:00Z'));
    expect(local).toEqual({ date: '2026-08-11', minutes: 12 * 60 + 30 - 180 });
  });

  it('vira o dia corretamente', () => {
    // 01:00 UTC ainda é o dia anterior na Bahia.
    expect(instantToLocal(BAHIA, new Date('2026-08-11T01:00:00Z'))).toEqual({
      date: '2026-08-10',
      minutes: 22 * 60,
    });
  });

  it('é inverso de localToInstant', () => {
    for (const minutes of [0, 375, 720, 1080, 1439]) {
      const instant = localToInstant(BAHIA, '2026-08-11', minutes);
      expect(instantToLocal(BAHIA, instant)).toEqual({ date: '2026-08-11', minutes });
    }
  });
});

describe('cutoffMinuteFor', () => {
  it('não corta nada em data futura', () => {
    const now = new Date('2026-08-11T12:00:00Z'); // 09:00 na Bahia
    expect(cutoffMinuteFor(BAHIA, '2026-08-12', now, 30)).toBeNull();
  });

  it('aplica agora + antecedência quando é hoje', () => {
    const now = new Date('2026-08-11T12:00:00Z'); // 09:00 local
    expect(cutoffMinuteFor(BAHIA, '2026-08-11', now, 30)).toBe(9 * 60 + 30);
  });

  it('bloqueia data já passada', () => {
    const now = new Date('2026-08-11T12:00:00Z');
    expect(cutoffMinuteFor(BAHIA, '2026-08-10', now, 30)).toBeGreaterThan(24 * 60);
  });

  it('usa o fuso da unidade, não o do cliente — defeito D2', () => {
    // 02:00 UTC = 23:00 do dia 10 na Bahia. Um cliente em Tóquio veria 11:00 do
    // dia 11 no relógio dele; o corte precisa seguir a unidade.
    const now = new Date('2026-08-11T02:00:00Z');
    expect(cutoffMinuteFor(BAHIA, '2026-08-10', now, 0)).toBe(23 * 60);
  });
});

describe('weekdayIn', () => {
  it('identifica o dia da semana no fuso da unidade', () => {
    expect(weekdayIn(BAHIA, '2026-08-11')).toBe(2); // terça
    expect(weekdayIn(BAHIA, '2026-08-10')).toBe(1); // segunda
    expect(weekdayIn(BAHIA, '2026-08-16')).toBe(0); // domingo
  });

  it('não escorrega para o dia vizinho por causa do offset', () => {
    for (const date of ['2026-01-01', '2026-03-01', '2026-12-31']) {
      const viaUtc = new Date(`${date}T12:00:00Z`).getUTCDay();
      expect(weekdayIn(BAHIA, date)).toBe(viaUtc);
    }
  });
});
