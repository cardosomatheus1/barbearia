import { describe, expect, it } from 'vitest';

import { comandaVisivel, type Comanda } from './comanda.js';

/**
 * A comanda de referência: com cliente identificado e com conta de fiado.
 *
 * Escrita inteira e não montada com `as never` — foi um `as never` que deixou
 * dezenove testes mandarem nulo numa coluna com `DEFAULT`, e aqui o que se
 * quer provar é exatamente **quais** campos somem.
 */
const COMANDA: Comanda = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'open',
  customerId: '22222222-2222-4222-8222-222222222222',
  customerName: 'Carlos Eduardo Nascimento',
  appointmentId: null,
  openedAt: '2026-08-20T12:00:00.000Z',
  closedAt: null,
  itens: [],
  desconto: null,
  gorjetaCents: 0,
  subtotalCents: 4900,
  descontoCents: 0,
  totalCents: 4900,
  trocoCents: 0,
  pagamentos: [],
  conta: { saldoCents: -3000, limiteCents: 30000 },
};

describe('a comanda que o balcão recebe', () => {
  it('quem pode ver cliente recebe a comanda inteira', () => {
    expect(comandaVisivel({ comanda: COMANDA, podeVerCliente: true })).toEqual(COMANDA);
  });

  it('quem não pode ver cliente perde nome, id e a conta — e continua com a venda', () => {
    const vista = comandaVisivel({ comanda: COMANDA, podeVerCliente: false });

    expect(vista.customerName).toBeNull();
    // O id junto: redigir o nome e deixá-lo passar entrega a mesma pessoa por
    // outra coluna — ele é a chave da ficha, do fiado e da fidelidade.
    expect(vista.customerId).toBeNull();
    // A conta inteira, e não os dois números zerados: um saldo 0 com teto 0
    // diria "não pode fiar" sobre quem pode, que é o número errado com cara de
    // certo.
    expect(vista.conta).toBeNull();

    // E o PDV continua de pé: é isto que separa redigir de recusar.
    expect(vista.totalCents).toBe(4900);
    expect(vista.status).toBe('open');
    expect(vista.id).toBe(COMANDA.id);
  });
});
