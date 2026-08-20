import { describe, expect, it } from 'vitest';
import { BookingError, BookingRecusadoPorScore } from '@barbearia/scheduling';
import { STATUS_DA_RESERVA, traduzirReserva } from '../src/common/booking-http.js';
import { DomainError } from '../src/common/errors.js';

/**
 * O tradutor único da recusa do motor.
 *
 * Cinco superfícies chamam `createAppointment` e `rescheduleAppointment`, e cada
 * uma escrevia a própria tradução: `slot_taken` era 409 em três, 400 numa e
 * **500** na API pública, que não traduzia nada. Isto aqui é o que impede a
 * sexta.
 */
describe('a recusa do motor traduzida para HTTP', () => {
  it('todo motivo de recusa tem status, e nenhum cai no padrão', () => {
    /**
     * O mapa é `Record<BookingFailure, number>` justamente para o compilador
     * cobrar o dia em que o motor ganhar a décima primeira recusa. Este teste é
     * a metade que roda: `score_no_pico` ficou fora dos quatro mapas antigos
     * porque todos usavam chave larga com `?? 400`.
     */
    for (const [motivo, status] of Object.entries(STATUS_DA_RESERVA)) {
      expect(status, motivo).toBeGreaterThanOrEqual(400);
      expect(status, motivo).toBeLessThan(500);
    }
  });

  it('horário tomado é 409, e nunca erro do servidor', () => {
    try {
      traduzirReserva(new BookingError('slot_taken', 'Esse horário acabou de ser marcado'));
      expect.unreachable('deveria ter lançado');
    } catch (erro) {
      expect(erro).toBeInstanceOf(DomainError);
      expect((erro as DomainError).status).toBe(409);
      expect((erro as DomainError).code).toBe('slot_taken');
    }
  });

  it('a recusa por confiabilidade sai sem nomear o mecanismo, e sem o número', () => {
    /**
     * O score é interno por regra da SPEC §2.13, e o bloco 60 já tinha tirado
     * `score_no_pico` da URL da página pública. Este bloco levou a tradução para
     * a API com chave, onde não há tela que sanease depois — então a troca mora
     * no tradutor, valendo para as cinco de uma vez.
     */
    try {
      traduzirReserva(new BookingRecusadoPorScore(32, 60, new Date('2026-08-20T12:00:00Z')));
      expect.unreachable('deveria ter lançado');
    } catch (erro) {
      const saiu = erro as DomainError;
      expect(saiu.status).toBe(409);
      expect(saiu.code).toBe('so_recepcao');

      const corpo = JSON.stringify({ code: saiu.code, message: saiu.message });
      expect(corpo).not.toContain('score');
      expect(corpo).not.toContain('32');
      expect(corpo).not.toContain('60');
    }
  });

  it('erro que não é do motor atravessa sem virar recusa de reserva', () => {
    // Cada controller tem os erros do próprio assunto para tratar depois: um
    // tradutor que engolisse o alheio faria a rota responder 200 com nada.
    expect(() => traduzirReserva(new Error('banco caiu'))).not.toThrow();
  });
});
