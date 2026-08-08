import { describe, expect, it } from 'vitest';
import {
  conflitaComExcecao,
  exigeFaixa,
  validarExcecao,
  type EntradaDeExcecao,
} from './excecao.js';

const base: EntradaDeExcecao = {
  tipo: 'block',
  data: '2026-08-14',
  startMinute: 840,
  endMinute: 900,
  professionalId: 'ruan',
};

describe('exceção de agenda', () => {
  it('bloqueio com faixa válida passa', () => {
    expect(validarExcecao(base)).toBeNull();
  });

  it('folga fecha o dia inteiro e não aceita faixa', () => {
    // Engolir a faixa em silêncio gravaria uma folga que fecha meio dia — e o
    // barbeiro que pediu o dia todo apareceria na grade da tarde.
    expect(
      validarExcecao({ ...base, tipo: 'day_off', startMinute: null, endMinute: null }),
    ).toBeNull();
    expect(validarExcecao({ ...base, tipo: 'day_off' })).toBe('faixa_indevida');
  });

  it('bloqueio sem faixa é recusado', () => {
    expect(
      validarExcecao({ ...base, startMinute: null, endMinute: null }),
    ).toBe('faixa_ausente');
  });

  it('faixa invertida é recusada antes de tocar no banco', () => {
    expect(validarExcecao({ ...base, startMinute: 900, endMinute: 840 })).toBe('faixa_invertida');
  });

  it('faixa de duração zero é recusada — semiaberto, encostar não é ocupar', () => {
    expect(validarExcecao({ ...base, startMinute: 840, endMinute: 840 })).toBe('faixa_invertida');
  });

  it('faixa fora do dia é recusada', () => {
    expect(validarExcecao({ ...base, startMinute: 840, endMinute: 1441 })).toBe('faixa_fora_do_dia');
    expect(validarExcecao({ ...base, startMinute: -1, endMinute: 900 })).toBe('faixa_fora_do_dia');
  });

  it('meia-noite como fim do dia é aceita', () => {
    expect(validarExcecao({ ...base, startMinute: 1380, endMinute: 1440 })).toBeNull();
  });

  it('exceção precisa de um alvo', () => {
    expect(
      validarExcecao({ ...base, professionalId: null, locationId: null }),
    ).toBe('alvo_ausente');
  });

  it('exceção não pode ser do profissional e da unidade ao mesmo tempo', () => {
    // A precedência distingue as duas; a mesma linha sendo as duas coisas
    // tiraria o sentido da regra "exceção do profissional vence a da unidade".
    expect(validarExcecao({ ...base, locationId: 'matriz' })).toBe('alvo_duplo');
  });

  it('data mal formada é recusada', () => {
    expect(validarExcecao({ ...base, data: '14/08/2026' })).toBe('data_invalida');
  });

  it('tipo inventado é recusado', () => {
    expect(
      validarExcecao({ ...base, tipo: 'ferias' as never }),
    ).toBe('tipo_invalido');
  });

  it('só bloqueio e horário diferente pedem faixa', () => {
    expect(exigeFaixa('block')).toBe(true);
    expect(exigeFaixa('custom_hours')).toBe(true);
    expect(exigeFaixa('day_off')).toBe(false);
    expect(exigeFaixa('holiday')).toBe(false);
    expect(exigeFaixa('vacation')).toBe(false);
  });
});

describe('conflito com agendamento existente', () => {
  const agendamento = { startMinute: 840, endMinute: 900 };

  it('exceção de dia inteiro pega qualquer horário', () => {
    expect(
      conflitaComExcecao({ agendamento, excecao: { startMinute: null, endMinute: null } }),
    ).toBe(true);
  });

  it('bloqueio em cima do horário conflita', () => {
    expect(
      conflitaComExcecao({ agendamento, excecao: { startMinute: 850, endMinute: 870 } }),
    ).toBe(true);
  });

  it('bloqueio que encosta no fim não conflita', () => {
    // Semiaberto [início, fim): o bloqueio das 15h não pega o corte que termina
    // às 15h. É a mesma regra do motor de disponibilidade.
    expect(
      conflitaComExcecao({ agendamento, excecao: { startMinute: 900, endMinute: 960 } }),
    ).toBe(false);
  });

  it('bloqueio que encosta no início não conflita', () => {
    expect(
      conflitaComExcecao({ agendamento, excecao: { startMinute: 780, endMinute: 840 } }),
    ).toBe(false);
  });

  it('bloqueio que engole o agendamento conflita', () => {
    expect(
      conflitaComExcecao({ agendamento, excecao: { startMinute: 600, endMinute: 1200 } }),
    ).toBe(true);
  });

  it('bloqueio em outra parte do dia não conflita', () => {
    expect(
      conflitaComExcecao({ agendamento, excecao: { startMinute: 1000, endMinute: 1100 } }),
    ).toBe(false);
  });
});
