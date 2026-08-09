import { describe, expect, it } from 'vitest';
import { faltamDias } from './prazo';

/**
 * O relógio entra por parâmetro, sempre.
 *
 * Um `new Date()` dentro da função faria estes testes passarem hoje e falharem
 * na virada do mês — e a suíte precisa rodar igual sob qualquer `TZ`.
 */

const em = (iso: string) => new Date(iso);

describe('quanto falta para o prazo do titular', () => {
  it('diz 15 no dia em que o pedido de 15 dias nasce', () => {
    /**
     * A regressão que motivou contar por calendário.
     *
     * O pedido nasce às 9h e a tela é aberta às 14h do **mesmo dia** — que é o
     * caso real, porque quem registra o pedido volta para a fila em seguida.
     * Subtraindo instantes sobram 14 dias e 19 horas, e "vence em 14 dias" faz
     * o dono concluir que a tela erra no primeiro pedido que ele abre.
     *
     * Comparar no instante exato da criação não pegaria nada: ali a subtração
     * dá 15 redondo, e o teste passaria em cima do defeito.
     */
    const criado = em('2026-08-09T09:00:00Z');
    const vence = new Date(criado.getTime() + 15 * 86_400_000);
    expect(faltamDias(vence, em('2026-08-09T14:00:00Z')).texto).toBe('vence em 15 dias');
  });

  it('não muda com a hora do dia — o prazo é do dia, não do relógio', () => {
    const vence = em('2026-08-24T09:00:00Z');
    expect(faltamDias(vence, em('2026-08-09T00:01:00Z')).texto).toBe('vence em 15 dias');
    expect(faltamDias(vence, em('2026-08-09T23:59:00Z')).texto).toBe('vence em 15 dias');
  });

  it('vira no dia seguinte, não em vinte e quatro horas', () => {
    const vence = em('2026-08-24T09:00:00Z');
    expect(faltamDias(vence, em('2026-08-10T00:01:00Z')).texto).toBe('vence em 14 dias');
  });

  it('marca como urgente a reta final, o dia do vencimento e o atraso', () => {
    const vence = em('2026-08-24T12:00:00Z');
    expect(faltamDias(vence, em('2026-08-20T12:00:00Z')).urgente).toBe(false);
    expect(faltamDias(vence, em('2026-08-21T12:00:00Z')).urgente).toBe(true);
    expect(faltamDias(vence, em('2026-08-24T12:00:00Z'))).toEqual({
      texto: 'vence hoje',
      urgente: true,
    });
    expect(faltamDias(vence, em('2026-08-26T12:00:00Z'))).toEqual({
      texto: 'venceu há 2 dias',
      urgente: true,
    });
  });

  it('escreve "dia" no singular dos dois lados', () => {
    const vence = em('2026-08-24T12:00:00Z');
    expect(faltamDias(vence, em('2026-08-23T12:00:00Z')).texto).toBe('vence em 1 dia');
    expect(faltamDias(vence, em('2026-08-25T12:00:00Z')).texto).toBe('venceu há 1 dia');
  });
});
