import { FakeCobrancaDoClubeProvider, type CobrancaDoClubeProvider, FakeSplitProvider, type SplitProvider } from '@barbearia/core';
import { FakePaymentProvider, type PaymentProvider } from '@barbearia/core';
import { FakePspProvider, type PspProvider } from './psp.js';
import { StripeCliente } from './stripe.js';
import { StripePspProvider } from './stripe-pagamento.js';

/**
 * Configuração compartilhada pela API e pelo worker.
 * PSP_MODO controla somente a plataforma cobrando a assinatura da barbearia.
 * A conta Stripe do SaaS nunca recebe pagamentos dos clientes das lojas.
 *
 * ## Por que o padrão é não ter adquirente
 *
 * Modo ausente é o modo do bloco 28: nada é debitado sozinho e quem quita
 * fatura é o Super Admin registrando o que viu no extrato. Um padrão que caísse
 * na Stripe faria um ambiente mal configurado cobrar cartão de verdade — e o
 * erro só apareceria na fatura de alguém.
 */

export type ModoDoAdquirente = 'nenhum' | 'fake' | 'stripe';

function modoSeguroParaOAmbiente(modo: ModoDoAdquirente): ModoDoAdquirente {
  if (modo === 'fake' && process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'PSP_MODO=fake não pode ser usado em produção. ' +
        'Use nenhum enquanto a cobrança for manual ou stripe com credenciais reais.',
    );
  }
  return modo;
}

/**
 * Lê o modo, e **recusa o que não conhece**.
 *
 * `PSP_MODO=stripe_test` — um erro de digitação plausível — cairia em "nenhum"
 * numa leitura permissiva, e o sintoma seria a plataforma parar de cobrar sem
 * ninguém perceber por um mês. Falhar alto na subida é barulhento uma vez;
 * silêncio aqui custa um ciclo inteiro de faturamento.
 */
export function modoDoAdquirente(bruto = process.env['PSP_MODO']): ModoDoAdquirente {
  if (bruto === undefined || bruto === '') return 'nenhum';
  if (bruto === 'nenhum' || bruto === 'fake' || bruto === 'stripe') return modoSeguroParaOAmbiente(bruto);
  throw new Error(`PSP_MODO inválido: ${bruto}. Use nenhum, fake ou stripe.`);
}

/**
 * O adquirente da **plataforma cobrando a barbearia**.
 *
 * `null` quando não há nenhum: a régua entende isso e segue emitindo fatura sem
 * debitar, que é o comportamento do bloco 28.
 */
export function adquirenteDaPlataforma(modo = modoDoAdquirente()): PspProvider | null {
  switch (modoSeguroParaOAmbiente(modo)) {
    case 'nenhum':
      return null;
    case 'fake':
      return new FakePspProvider();
    case 'stripe':
      // `StripeCliente` só lê `STRIPE_SECRET_KEY` na hora da chamada, então
      // construí-lo aqui não falha. Quem falha alto é a primeira cobrança — e
      // é de propósito: derrubar o worker inteiro na subida por causa da
      // configuração de cobrança pararia também os lembretes de agendamento,
      // que não têm nada a ver com isso.
      return new StripePspProvider(new StripeCliente());
  }
}

/** Comanda tem configuração própria e nenhum gateway real nesta versão. */
export type ModoDaComanda = 'nenhum' | 'fake';

export function modoDaComanda(bruto = process.env['COMANDA_PSP_MODO']): ModoDaComanda {
  if (bruto === undefined || bruto === '' || bruto === 'nenhum') return 'nenhum';
  if (bruto === 'fake') {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('COMANDA_PSP_MODO=fake não pode ser usado em produção');
    }
    return 'fake';
  }
  throw new Error('COMANDA_PSP_MODO inválido. Use nenhum ou fake em teste; Stripe é exclusiva da assinatura do SaaS.');
}

export function cobrancaDaComandaDisponivel(modo = modoDaComanda()): boolean {
  return modoDaComanda(modo) === 'fake';
}

// A ausência de integração não pode fabricar uma confirmação de estorno.
// O erro preserva a operação pendente para tratamento pelo operador.
const comandaSemAdquirente: PaymentProvider = {
  async criarCobranca() { throw new Error('comanda_sem_adquirente'); },
  async consultar() { throw new Error('comanda_sem_adquirente'); },
  async cancelar() { throw new Error('comanda_sem_adquirente'); },
  async estornar() { throw new Error('comanda_sem_adquirente'); },
};

export function adquirenteDaComanda(modo = modoDaComanda()): PaymentProvider {
  return modoDaComanda(modo) === 'fake' ? new FakePaymentProvider() : comandaSemAdquirente;
}

/** A conta Stripe do SaaS não processa recebíveis nem assinaturas das lojas. */
const splitSemAdquirente: SplitProvider = {
  async cadastrarRecebedor() { throw new Error('split_sem_adquirente'); },
  async consultarRecebedor() { throw new Error('split_sem_adquirente'); },
  async transferir() { throw new Error('split_sem_adquirente'); },
};
const clubeSemAdquirente: CobrancaDoClubeProvider = {
  async cobrar() { throw new Error('clube_sem_adquirente'); },
};
let splitFake: SplitProvider | null = null;
let clubeFake: CobrancaDoClubeProvider | null = null;
export function splitDisponivel(): boolean { return modoDaComanda() === 'fake'; }
export function adquirenteDoSplit(): SplitProvider {
  return splitDisponivel() ? (splitFake ??= new FakeSplitProvider()) : splitSemAdquirente;
}
export function adquirenteDoClube(): CobrancaDoClubeProvider {
  return modoDaComanda() === 'fake' ? (clubeFake ??= new FakeCobrancaDoClubeProvider()) : clubeSemAdquirente;
}
