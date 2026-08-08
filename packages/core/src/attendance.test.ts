import { describe, expect, it } from 'vitest';
import {
  allowedActions,
  canApply,
  punctuality,
  realDuration,
  statusAfter,
  type AppointmentStatus,
} from './attendance.js';

describe('transições do atendimento', () => {
  it('quem chega sem ter confirmado faz check-in direto', () => {
    // É o caso comum, não a exceção. Obrigar a confirmar antes seria um toque a
    // mais com o cliente parado na frente da recepção.
    expect(canApply('pending', 'check_in')).toBe(true);
  });

  it('não deixa começar quem não chegou', () => {
    expect(canApply('pending', 'start')).toBe(false);
    expect(canApply('confirmed', 'start')).toBe(false);
    expect(canApply('checked_in', 'start')).toBe(true);
  });

  it('não deixa concluir quem não começou', () => {
    // Concluir sem começar zeraria a duração real, que é a base da estimativa
    // de espera da fila.
    for (const status of ['pending', 'confirmed', 'checked_in', 'waiting'] as const) {
      expect(canApply(status, 'complete')).toBe(false);
    }
    expect(canApply('in_progress', 'complete')).toBe(true);
  });

  it('quem chegou e desistiu ainda vira falta', () => {
    // Sem isso a recepção teria que cancelar em nome da barbearia, e o registro
    // diria que a culpa foi da casa — o que muda o score do cliente.
    expect(canApply('checked_in', 'no_show')).toBe(true);
    expect(canApply('waiting', 'no_show')).toBe(true);
  });

  it('falta marcada por engano pode ser desfeita', () => {
    expect(canApply('no_show', 'undo_no_show')).toBe(true);
    expect(statusAfter('undo_no_show')).toBe('checked_in');
  });

  it('estado terminal não aceita mais nada', () => {
    const terminais: AppointmentStatus[] = [
      'completed',
      'cancelled_customer',
      'cancelled_business',
      'rescheduled',
    ];
    for (const status of terminais) {
      expect(allowedActions(status)).toEqual([]);
    }
  });

  it('cancelar pelo balcão registra como cancelamento da barbearia', () => {
    // `cancelled_customer` pune o cliente no reliability score; quem cancela
    // aqui é a casa.
    expect(statusAfter('cancel')).toBe('cancelled_business');
  });

  it('nenhuma ação leva de volta a um estado já vivido', () => {
    // Guarda contra alguém acrescentar uma transição que faça o atendimento
    // andar para trás e duplicar métrica.
    const ordem: AppointmentStatus[] = [
      'pending', 'confirmed', 'checked_in', 'waiting', 'in_progress', 'completed',
    ];
    for (const [i, status] of ordem.entries()) {
      for (const acao of allowedActions(status)) {
        const destino = statusAfter(acao);
        const indiceDestino = ordem.indexOf(destino);
        if (indiceDestino >= 0) expect(indiceDestino).toBeGreaterThan(i);
      }
    }
  });
});

describe('pontualidade', () => {
  it('conta quanto falta para quem ainda vai chegar', () => {
    expect(punctuality(-15, 20)).toEqual({ kind: 'upcoming', minutesUntil: 15 });
  });

  it('mostra o relógio da falta automática antes de ele zerar', () => {
    // É o que evita a recepção ser pega de surpresa quando o status muda
    // sozinho.
    expect(punctuality(8, 20)).toEqual({
      kind: 'late',
      minutesLate: 8,
      noShowInMinutes: 12,
    });
  });

  it('marca a falta como devida ao cruzar a tolerância', () => {
    expect(punctuality(20, 20)).toEqual({ kind: 'no_show_due', minutesLate: 20 });
    expect(punctuality(45, 20)).toEqual({ kind: 'no_show_due', minutesLate: 45 });
  });

  it('tolerância zero deixa o atrasado atrasado, sem virar falta sozinho', () => {
    const situacao = punctuality(60, 0);
    expect(situacao.kind).toBe('late');
    expect(situacao.kind === 'late' && situacao.noShowInMinutes).toBe(Infinity);
  });

  it('a hora exata não é nem adiantado nem atrasado', () => {
    expect(punctuality(0, 20)).toEqual({ kind: 'due' });
  });
});

describe('duração real', () => {
  it('conta do início ao fim', () => {
    expect(
      realDuration(new Date('2026-08-08T12:00:00Z'), new Date('2026-08-08T12:38:00Z')),
    ).toBe(38);
  });

  it('é nula enquanto não terminou', () => {
    expect(realDuration(new Date('2026-08-08T12:00:00Z'), null)).toBeNull();
    expect(realDuration(null, null)).toBeNull();
  });

  it('recusa fim antes do início em vez de devolver negativo', () => {
    // Duração negativa entraria numa média e a estimativa de espera da fila
    // ficaria menor que a realidade.
    expect(
      realDuration(new Date('2026-08-08T12:38:00Z'), new Date('2026-08-08T12:00:00Z')),
    ).toBeNull();
  });
});
