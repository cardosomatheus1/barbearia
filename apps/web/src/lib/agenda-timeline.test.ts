import { describe, expect, it } from 'vitest';
import {
  alvosLivres,
  alturaPx,
  hhmm,
  limitesDoDia,
  livresDoProfissional,
  minutos,
  subtrair,
  topPx,
} from './agenda-timeline';

const dia = {
  workingDays: [
    { professionalId: 'p1', working: [{ start: '09:00', end: '18:00' }], breaks: [{ start: '12:00', end: '13:00' }] },
    { professionalId: 'p2', working: [{ start: '10:00', end: '20:00' }], breaks: [] },
  ],
  entries: [
    { professionalId: 'p1', occupiedStart: '09:30', occupiedEnd: '10:30' },
    { professionalId: 'p2', occupiedStart: '18:00', occupiedEnd: '19:00' },
  ],
  exceptions: [],
};

describe('agenda em linha do tempo', () => {
  it('converte relógio sem depender do fuso do processo', () => {
    expect(minutos('09:30')).toBe(570);
    expect(hhmm(570)).toBe('09:30');
  });

  it('usa o mesmo eixo para profissionais com jornadas diferentes', () => {
    expect(limitesDoDia(dia)).toEqual({ start: 540, end: 1200 });
  });

  it('buraco desconta atendimento e almoço', () => {
    expect(livresDoProfissional(dia, 'p1')).toEqual([
      { start: 540, end: 570 },
      { start: 630, end: 720 },
      { start: 780, end: 1080 },
    ]);
  });

  it('subtração respeita janela ocupada inteira', () => {
    expect(subtrair([{ start: 540, end: 720 }], [{ start: 570, end: 630 }])).toEqual([
      { start: 540, end: 570 },
      { start: 630, end: 720 },
    ]);
  });

  it('buraco longo vira alvos de meia hora e não uma ação única de três horas', () => {
    expect(alvosLivres([{ start: 780, end: 870 }])).toEqual([
      { start: 780, end: 810 },
      { start: 810, end: 840 },
      { start: 840, end: 870 },
    ]);
  });

  it('resto muito curto é incorporado ao alvo anterior', () => {
    expect(alvosLivres([{ start: 600, end: 670 }])).toEqual([
      { start: 600, end: 630 },
      { start: 630, end: 670 },
    ]);
  });

  it('posição e altura continuam proporcionais ao tempo', () => {
    const limites = { start: 540, end: 1080 };
    expect(topPx(600, limites)).toBe(90);
    expect(alturaPx(600, 660)).toBe(90);
    expect(alturaPx(600, 720)).toBe(180);
  });

  it('meia hora comporta alvo de 44px sem esticar a régua; quinze minutos não', () => {
    expect(alturaPx(540, 570)).toBeGreaterThanOrEqual(44);
    expect(alturaPx(705, 720)).toBeLessThan(44);
  });
});
