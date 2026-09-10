import { adquirenteDoSplit, adquirenteDoClube, splitDisponivel } from './adquirente.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakePaymentProvider } from '@barbearia/core';
import {
  adquirenteDaComanda,
  adquirenteDaPlataforma,
  modoDoAdquirente,
  modoDaComanda,
  cobrancaDaComandaDisponivel,
} from './adquirente.js';
import { FakePspProvider } from './psp.js';
import { StripePspProvider } from './stripe-pagamento.js';

afterEach(() => vi.unstubAllEnvs());

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

describe('Stripe cobra exclusivamente a assinatura SaaS', () => {
  it('sem adquirente, a plataforma não debita', () => {
    // É o comportamento do bloco 28: fatura emitida, quitação registrada à mão
    // pelo Super Admin a partir do extrato.
    expect(adquirenteDaPlataforma('nenhum')).toBeNull();
  });

  it('ativar Stripe não habilita cobrança nem estorno de comanda', async () => {
    vi.stubEnv('PSP_MODO', 'stripe');
    vi.stubEnv('COMANDA_PSP_MODO', 'nenhum');
    expect(adquirenteDaPlataforma()).toBeInstanceOf(StripePspProvider);
    expect(cobrancaDaComandaDisponivel()).toBe(false);
    await expect(adquirenteDaComanda().estornar('pi_outra_conta')).rejects.toThrow('comanda_sem_adquirente');
    expect(() => modoDaComanda('stripe')).toThrow(/exclusiva/);
  });

  it('as simulações de assinatura e de comanda são escolhidas separadamente', () => {
    expect(adquirenteDaPlataforma('fake')).toBeInstanceOf(FakePspProvider);
    expect(adquirenteDaComanda('fake')).toBeInstanceOf(FakePaymentProvider);
  });

  it('sem adquirente, consulta e cancelamento também falham explicitamente', async () => {
    const provider = adquirenteDaComanda('nenhum');
    await expect(provider.consultar('pi_1')).rejects.toThrow('comanda_sem_adquirente');
    await expect(provider.cancelar('pi_1')).rejects.toThrow('comanda_sem_adquirente');
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
  it('Stripe do SaaS não habilita cobrança do clube nem inventa cadastro de recebedor', async () => {
    vi.stubEnv('PSP_MODO', 'stripe'); vi.stubEnv('COMANDA_PSP_MODO', 'nenhum');
    expect(splitDisponivel()).toBe(false);
    await expect(adquirenteDoSplit().consultarRecebedor('sintetico')).rejects.toThrow('split_sem_adquirente');
    await expect(adquirenteDoClube().cobrar({ tenantId: 'sintetico', faturaId: 'sintetica', token: 'sintetico',
      valorCents: 1000, tentativa: 1, descricao: 'Teste isolado', idempotencyKey: 'sintetica:1' })).rejects.toThrow('clube_sem_adquirente');
  });

});
