import { describe, expect, it } from 'vitest';
import {
  cutoffMinuteFor,
  diaNaUnidade,
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

describe('a janela do dia na unidade', () => {
  it('vai da meia-noite local à meia-noite local seguinte', () => {
    // Salvador é UTC-3 o ano inteiro: o dia começa às 03:00 UTC.
    const janela = diaNaUnidade('2026-03-10', 'America/Bahia', new Date('2026-03-10T12:00:00Z'));

    expect(janela.de.toISOString()).toBe('2026-03-10T03:00:00.000Z');
    expect(janela.ate.toISOString()).toBe('2026-03-11T03:00:00.000Z');
  });

  it('meia-noite UTC não serve: o faturamento pegaria três horas de ontem', () => {
    const janela = diaNaUnidade('2026-03-10', 'America/Bahia', new Date('2026-03-10T12:00:00Z'));
    // O erro que este teste existe para impedir.
    expect(janela.de.toISOString()).not.toBe('2026-03-10T00:00:00.000Z');
  });

  it('sem dia informado, "hoje" é o da unidade e não o do aparelho', () => {
    // 01:30 UTC ainda é o dia anterior em Salvador (22:30). Um relógio lendo
    // UTC mostraria o faturamento de amanhã, vazio, às dez e meia da noite.
    const janela = diaNaUnidade(null, 'America/Bahia', new Date('2026-03-11T01:30:00Z'));
    expect(janela.dia).toBe('2026-03-10');
  });

  it('atravessa a virada do mês', () => {
    const janela = diaNaUnidade('2026-01-31', 'America/Bahia', new Date('2026-01-31T12:00:00Z'));
    expect(janela.ate.toISOString()).toBe('2026-02-01T03:00:00.000Z');
  });

  it('o intervalo é semiaberto: a meia-noite seguinte é do outro dia', () => {
    const hoje = diaNaUnidade('2026-03-10', 'America/Bahia', new Date('2026-03-10T12:00:00Z'));
    const amanha = diaNaUnidade('2026-03-11', 'America/Bahia', new Date('2026-03-11T12:00:00Z'));
    expect(hoje.ate.toISOString()).toBe(amanha.de.toISOString());
  });

  it('data malformada é recusada, não vira intervalo errado em silêncio', () => {
    expect(() => diaNaUnidade('10/03/2026', 'America/Bahia', new Date())).toThrow();
  });
});

describe('o cache de offset não muda a resposta', () => {
  /**
   * A otimização do bloco 23 guarda o offset por dia UTC quando o dia é
   * uniforme. O risco inteiro dela mora num lugar só: o dia da virada.
   *
   * Este teste percorre a virada de Nova York **minuto a minuto** — as duas,
   * a que adianta e a que atrasa — e compara o resultado com o cálculo direto
   * do Intl. Se o cache pegar o offset de antes e servir depois, ele falha.
   */
  const direto = (timeZone: string, instant: Date): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
    const ler = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    const asUtc = Date.UTC(ler('year'), ler('month') - 1, ler('day'), ler('hour'), ler('minute'), ler('second'));
    return Math.round((asUtc - instant.getTime()) / 60_000);
  };

  it.each([
    ['início do horário de verão', Date.UTC(2026, 2, 8, 0, 0)],
    ['fim do horário de verão', Date.UTC(2026, 10, 1, 0, 0)],
  ])('Nova York, %s: cada minuto do dia bate com o Intl', (_nome, inicioDoDia) => {
    const divergencias: string[] = [];

    for (let m = 0; m < 24 * 60; m++) {
      const instante = new Date(inicioDoDia + m * 60_000);
      const comCache = offsetMinutesAt('America/New_York', instante);
      const semCache = direto('America/New_York', instante);
      if (comCache !== semCache) {
        divergencias.push(`${instante.toISOString()}: cache ${comCache} ≠ Intl ${semCache}`);
      }
    }

    expect(divergencias).toEqual([]);
  });

  it('o dia da virada de fato tem dois offsets — senão o teste acima não prova nada', () => {
    // Sem esta linha, um dia sem transição passaria no teste anterior e daria
    // a impressão de que o caso difícil foi coberto.
    const dia = Date.UTC(2026, 2, 8, 0, 0);
    const primeiro = offsetMinutesAt('America/New_York', new Date(dia));
    const ultimo = offsetMinutesAt('America/New_York', new Date(dia + 86_399_000));

    expect(primeiro).not.toBe(ultimo);
  });

  it('a segunda chamada devolve o mesmo que a primeira', () => {
    // O caminho quente: dia uniforme, valor servido do cache.
    const instante = new Date(Date.UTC(2026, 5, 15, 14, 30));
    const primeira = offsetMinutesAt('America/Bahia', instante);
    const segunda = offsetMinutesAt('America/Bahia', instante);
    const outroMinuto = offsetMinutesAt('America/Bahia', new Date(Date.UTC(2026, 5, 15, 3, 7)));

    expect(primeira).toBe(-180);
    expect(segunda).toBe(-180);
    expect(outroMinuto).toBe(-180);
  });
});
