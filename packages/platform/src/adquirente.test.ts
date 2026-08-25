import { describe, expect, it } from 'vitest';
import { FakePaymentProvider } from '@barbearia/core';
import {
  adquirenteDaComanda,
  adquirenteDaPlataforma,
  modoDoAdquirente,
} from './adquirente.js';
import { FakePspProvider } from './psp.js';
import { StripePaymentProvider, StripePspProvider } from './stripe-pagamento.js';

/**
 * A escolha do adquirente (bloco 34).
 *
 * Estes testes existem por uma classe de defeito que não aparece em nenhum
 * outro: a configuração escrita errado que não derruba nada, e cujo sintoma só
 * aparece na fatura do mês seguinte.
 */

describe('o modo do adquirente', () => {
  it('sem variável, não há adquirente — e não é a Stripe', () => {
    // Um padrão que caísse na Stripe faria um ambiente mal configurado cobrar
    // cartão de verdade, e o erro apareceria na fatura de alguém.
    expect(modoDoAdquirente(undefined)).toBe('nenhum');
    expect(modoDoAdquirente('')).toBe('nenhum');
  });

  it('modo desconhecido falha alto em vez de virar "nenhum"', () => {
    /**
     * `stripe_test` é o erro de digitação plausível. Numa leitura permissiva
     * ele cairia em "nenhum", e a plataforma pararia de cobrar sem ninguém
     * perceber por um ciclo inteiro de faturamento.
     */
    expect(() => modoDoAdquirente('stripe_test')).toThrow(/PSP_MODO/);
    expect(() => modoDoAdquirente('STRIPE')).toThrow(/PSP_MODO/);
  });

  it('não aceita fake em produção, nem quando o modo é passado diretamente', () => {
    const anterior = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      expect(() => modoDoAdquirente('fake')).toThrow(/fake.*produção/i);
      expect(() => adquirenteDaPlataforma('fake')).toThrow(/fake.*produção/i);
      expect(() => adquirenteDaComanda('fake')).toThrow(/fake.*produção/i);
    } finally {
      if (anterior === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = anterior;
    }
  });

  it('reconhece os três modos escritos', () => {
    expect(modoDoAdquirente('nenhum')).toBe('nenhum');
    expect(modoDoAdquirente('fake')).toBe('fake');
    expect(modoDoAdquirente('stripe')).toBe('stripe');
  });
});

describe('as duas pontas seguem o mesmo modo', () => {
  it('sem adquirente, a plataforma não debita', () => {
    // É o comportamento do bloco 28: fatura emitida, quitação registrada à mão
    // pelo Super Admin a partir do extrato.
    expect(adquirenteDaPlataforma('nenhum')).toBeNull();
  });

  it('o modo stripe liga as duas pontas de uma vez', () => {
    /**
     * O defeito que esta função existe para impedir: ligar a Stripe num
     * processo e esquecer no outro — a régua debitando de verdade enquanto o
     * estorno devolve dinheiro de mentira.
     */
    expect(adquirenteDaPlataforma('stripe')).toBeInstanceOf(StripePspProvider);
    expect(adquirenteDaComanda('stripe')).toBeInstanceOf(StripePaymentProvider);
  });

  it('o modo fake liga as duas pontas de mentira', () => {
    expect(adquirenteDaPlataforma('fake')).toBeInstanceOf(FakePspProvider);
    expect(adquirenteDaComanda('fake')).toBeInstanceOf(FakePaymentProvider);
  });

  it('sem adquirente, o balcão ainda recebe uma resposta', () => {
    // A assimetria é de propósito: a plataforma pode simplesmente não debitar,
    // mas o balcão precisa de algo na tela.
    expect(adquirenteDaComanda('nenhum')).toBeInstanceOf(FakePaymentProvider);
  });

  it('construir o provedor da Stripe não exige a chave — cobrar exige', async () => {
    /**
     * Se o construtor lesse `STRIPE_SECRET_KEY`, uma configuração de cobrança
     * faltando derrubaria o worker inteiro na subida — e junto com ele os
     * lembretes de agendamento, que não têm nada a ver com dinheiro.
     */
    const anterior = process.env['STRIPE_SECRET_KEY'];
    delete process.env['STRIPE_SECRET_KEY'];
    try {
      const psp = adquirenteDaPlataforma('stripe');
      expect(psp).not.toBeNull();
      await expect(
        psp?.cobrar({
          tenantId: '11111111-1111-1111-1111-111111111111',
          faturaId: '22222222-2222-2222-2222-222222222222',
          valorCents: 100,
          tentativa: 1,
          pspCustomerId: 'cus_1',
          pspMethodId: 'pm_1',
        }),
      ).rejects.toThrow(/STRIPE_SECRET_KEY/);
    } finally {
      if (anterior !== undefined) process.env['STRIPE_SECRET_KEY'] = anterior;
    }
  });
});
