import { FakePaymentProvider, type PaymentProvider } from '@barbearia/core';
import { FakePspProvider, type PspProvider } from './psp.js';
import { StripeCliente } from './stripe.js';
import { StripePaymentProvider, StripePspProvider } from './stripe-pagamento.js';

/**
 * Quem decide qual adquirente está no ar (bloco 34).
 *
 * ## Por que uma função só, e não um `new` em cada processo
 *
 * O produto tem dois processos que cobram — a API (estorno de crédito, e a
 * partir do bloco 35 a comanda) e o worker (a régua da assinatura). Cada um
 * escolhendo o seu provedor significa que ligar a Stripe é lembrar de dois
 * lugares, e o que acontece de verdade é ligar num e esquecer no outro: a régua
 * debitando de verdade enquanto o estorno devolve dinheiro de mentira.
 *
 * Esta é a **única** função do produto que sabe que a Stripe existe. Tudo o
 * mais fala com `PspProvider` e `PaymentProvider`.
 *
 * ## Por que o padrão é não ter adquirente
 *
 * Modo ausente é o modo do bloco 28: nada é debitado sozinho e quem quita
 * fatura é o Super Admin registrando o que viu no extrato. Um padrão que caísse
 * na Stripe faria um ambiente mal configurado cobrar cartão de verdade — e o
 * erro só apareceria na fatura de alguém.
 */

export type ModoDoAdquirente = 'nenhum' | 'fake' | 'stripe';

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
  if (bruto === 'nenhum' || bruto === 'fake' || bruto === 'stripe') return bruto;
  throw new Error(`PSP_MODO inválido: ${bruto}. Use nenhum, fake ou stripe.`);
}

/**
 * O adquirente da **plataforma cobrando a barbearia**.
 *
 * `null` quando não há nenhum: a régua entende isso e segue emitindo fatura sem
 * debitar, que é o comportamento do bloco 28.
 */
export function adquirenteDaPlataforma(modo = modoDoAdquirente()): PspProvider | null {
  switch (modo) {
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

/**
 * O adquirente da **barbearia cobrando o cliente dela**.
 *
 * Nunca `null`, e a diferença em relação ao de cima é o que acontece sem
 * adquirente: lá a plataforma simplesmente não debita, aqui o balcão precisa de
 * uma resposta na tela. O fake devolve um Pix que não existe, que é honesto em
 * desenvolvimento e impossível de confundir com dinheiro de verdade — o
 * copia-e-cola sai literalmente com `fake` no meio.
 */
export function adquirenteDaComanda(modo = modoDoAdquirente()): PaymentProvider {
  return modo === 'stripe'
    ? new StripePaymentProvider(new StripeCliente())
    : new FakePaymentProvider();
}
