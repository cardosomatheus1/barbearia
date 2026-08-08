import { describe, expect, it } from 'vitest';
import { canCancel, canReschedule, minutesBetween } from './changes.js';

const JANELA = { cancelMinHours: 2, rescheduleMinHours: 2, maxReschedules: 2 };

describe('cancelamento pelo cliente', () => {
  it('permite quando falta exatamente a antecedência mínima', () => {
    // A borda é inclusiva: "pelo menos 2 horas" inclui 2 horas cravadas. Excluir
    // faria a tela oferecer o botão e a API recusá-lo no mesmo minuto.
    expect(canCancel(120, JANELA)).toEqual({ allowed: true });
  });

  it('recusa um minuto dentro da janela', () => {
    expect(canCancel(119, JANELA)).toEqual({
      allowed: false,
      refusal: 'too_late',
      minHours: 2,
    });
  });

  it('distingue "já começou" de "faltou antecedência"', () => {
    // Dois textos diferentes: um o cliente resolve ligando, o outro não tem
    // conserto nenhum.
    expect(canCancel(0, JANELA)).toMatchObject({ refusal: 'already_started' });
    expect(canCancel(-30, JANELA)).toMatchObject({ refusal: 'already_started' });
  });

  it('janela zero deixa cancelar até o minuto anterior', () => {
    // É política válida: quem prefere a vaga livre na fila a um cliente irritado
    // configura zero.
    expect(canCancel(1, { cancelMinHours: 0 })).toEqual({ allowed: true });
    expect(canCancel(0, { cancelMinHours: 0 })).toMatchObject({ refusal: 'already_started' });
  });
});

describe('remarcação pelo cliente', () => {
  it('permite dentro do teto e da antecedência', () => {
    expect(canReschedule(120, 1, JANELA)).toEqual({ allowed: true });
  });

  it('recusa ao atingir o teto de remarcações', () => {
    expect(canReschedule(60 * 24, 2, JANELA)).toMatchObject({
      refusal: 'too_many_reschedules',
    });
  });

  it('teto esgotado vence a falta de antecedência', () => {
    // Quem já remarcou o máximo não pode receber "remarque com mais
    // antecedência": remarcar antes não resolveria nada.
    expect(canReschedule(10, 2, JANELA)).toMatchObject({ refusal: 'too_many_reschedules' });
  });

  it('teto zero proíbe qualquer remarcação', () => {
    expect(canReschedule(60 * 24, 0, { rescheduleMinHours: 2, maxReschedules: 0 })).toMatchObject({
      refusal: 'too_many_reschedules',
    });
  });

  it('janela de remarcação é independente da de cancelamento', () => {
    // Remarcar preserva a receita; a barbearia costuma tolerá-lo mais tarde do
    // que toleraria perder o horário.
    const solta = { rescheduleMinHours: 1, maxReschedules: 2 };
    expect(canReschedule(90, 0, solta)).toEqual({ allowed: true });
    expect(canCancel(90, { cancelMinHours: 2 })).toMatchObject({ refusal: 'too_late' });
  });
});

describe('minutesBetween', () => {
  it('conta minutos inteiros para frente', () => {
    expect(
      minutesBetween(new Date('2026-08-07T12:00:00Z'), new Date('2026-08-07T14:30:00Z')),
    ).toBe(150);
  });

  it('é negativo quando o alvo já passou', () => {
    expect(
      minutesBetween(new Date('2026-08-07T12:00:00Z'), new Date('2026-08-07T11:00:00Z')),
    ).toBe(-60);
  });

  it('trunca para baixo — 59 segundos não viram um minuto', () => {
    // Arredondar para cima daria ao cliente um minuto que ele não tem, e a API
    // recusaria o cancelamento que a tela ofereceu.
    expect(
      minutesBetween(new Date('2026-08-07T12:00:00Z'), new Date('2026-08-07T12:00:59Z')),
    ).toBe(0);
  });
});
