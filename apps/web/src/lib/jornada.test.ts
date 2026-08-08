import { describe, expect, it } from 'vitest';
import { lerJornada, linhasDaJornada, minutosOuNulo, type LinhaDoFormulario } from './jornada';

const linha = (parcial: Partial<LinhaDoFormulario> & { weekday: number }): LinhaDoFormulario => ({
  trabalha: true,
  inicio: '09:00',
  fim: '18:00',
  pausaInicio: null,
  pausaFim: null,
  ...parcial,
});

describe('jornada da semana', () => {
  it('"18:00" vale 1080 minutos, não 18', () => {
    expect(minutosOuNulo('18:00')).toBe(1080);
    expect(minutosOuNulo('09:30')).toBe(570);
    expect(minutosOuNulo('00:00')).toBe(0);
  });

  it('devolve nulo em vez de estourar com o que o campo aceitar', () => {
    expect(minutosOuNulo('')).toBeNull();
    expect(minutosOuNulo(null)).toBeNull();
    expect(minutosOuNulo('25:00')).toBeNull();
    expect(minutosOuNulo('meio-dia')).toBeNull();
  });

  it('dia desmarcado não vira faixa — é assim que se fecha a segunda', () => {
    const lida = lerJornada([
      linha({ weekday: 1, trabalha: false }),
      linha({ weekday: 2 }),
    ]);

    expect(lida.ok).toBe(true);
    if (!lida.ok) return;
    expect(lida.faixas.map((f) => f.weekday)).toEqual([2]);
  });

  it('dia marcado sem horário é erro, não folga silenciosa', () => {
    const lida = lerJornada([linha({ weekday: 3, inicio: '', fim: '' })]);
    expect(lida).toEqual({ ok: false, code: 'horario_invalido', weekday: 3 });
  });

  it('saída antes da entrada é recusada antes de sair da tela', () => {
    const lida = lerJornada([linha({ weekday: 4, inicio: '18:00', fim: '09:00' })]);
    expect(lida).toEqual({ ok: false, code: 'fim_antes_do_inicio', weekday: 4 });
  });

  it('meia pausa é erro: o formulário não adivinha quando o almoço acaba', () => {
    const lida = lerJornada([linha({ weekday: 5, pausaInicio: '12:00' })]);
    expect(lida).toEqual({ ok: false, code: 'horario_invalido', weekday: 5 });
  });

  it('pausa fora da jornada do dia é recusada', () => {
    const lida = lerJornada([
      linha({ weekday: 6, inicio: '09:00', fim: '13:00', pausaInicio: '14:00', pausaFim: '15:00' }),
    ]);
    expect(lida).toEqual({ ok: false, code: 'pausa_fora', weekday: 6 });
  });

  it('a pausa entra na faixa do dia', () => {
    const lida = lerJornada([
      linha({ weekday: 2, pausaInicio: '12:00', pausaFim: '13:00' }),
    ]);

    expect(lida.ok).toBe(true);
    if (!lida.ok) return;
    expect(lida.faixas[0]).toEqual({
      weekday: 2,
      startMinute: 540,
      endMinute: 1080,
      breaks: [{ start: 720, end: 780 }],
    });
  });

  it('o que foi gravado volta para os campos sem perder a pausa', () => {
    const linhas = linhasDaJornada([
      { weekday: 2, startMinute: 540, endMinute: 1080, breaks: [{ start: 720, end: 780 }] },
    ]);

    const terca = linhas.find((l) => l.weekday === 2);
    expect(terca).toMatchObject({
      trabalha: true,
      inicio: '09:00',
      fim: '18:00',
      pausaInicio: '12:00',
      pausaFim: '13:00',
    });

    // E o resto da semana volta em branco, não com o horário do dia anterior.
    expect(linhas.filter((l) => l.trabalha)).toHaveLength(1);
  });

  it('ida e volta pela tela não muda a jornada', () => {
    const original = [
      { weekday: 1, startMinute: 480, endMinute: 1200, breaks: [] },
      { weekday: 6, startMinute: 540, endMinute: 780, breaks: [{ start: 600, end: 630 }] },
    ];

    const lida = lerJornada(linhasDaJornada(original));
    expect(lida.ok).toBe(true);
    if (!lida.ok) return;
    expect([...lida.faixas].sort((a, b) => a.weekday - b.weekday)).toEqual(original);
  });
});
