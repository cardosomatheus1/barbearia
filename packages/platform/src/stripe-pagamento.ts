import {
  chaveDoAdquirente,
  chaveDoEstorno,
  type CobrancaCriada,
  type EstadoDoPagamento,
  type PaymentProvider,
  type PedidoDePagamento,
} from '@barbearia/core';
import { StripeCliente, StripeError } from './stripe.js';
import {
  EstornoRecusado,
  type EstadoDaCobranca,
  type PedidoDeCobranca,
  type PedidoDeEstorno,
  type PspProvider,
  type RespostaDaCobranca,
} from './psp.js';

/**
 * O identificador na URL, sempre codificado.
 *
 * Ele é opaco e hoje vem só da nossa própria emissão, mas o bloco 35 passa a
 * lê-lo de um webhook. Um `/` ou um `?` no meio mudaria **qual** recurso da
 * Stripe a consulta endereça — e um estado lido do recurso errado é pior que
 * um erro, porque parece resposta.
 */
const noCaminho = (id: string): string => encodeURIComponent(id);

/**
 * As duas pontas da Stripe, sobre o mesmo cliente (bloco 34).
 *
 * Este arquivo fecha a lacuna "adquirente de verdade", declarada desde o bloco
 * 29: a integração inteira existia — contrato, webhook assinado, conciliação,
 * trilha do que o provedor disse — e o único provedor era o de mentira.
 *
 * ## O que continua não estando provado, e está escrito
 *
 * Não há conta contratada nem rede para a Stripe neste ambiente. O que os
 * testes provam é o contrato do lado de cá: o que sai na requisição e como a
 * resposta é lida. Que a Stripe aceita estas chamadas depende de conta, e
 * nenhum teste local substitui isso — por isso o `FakePaymentProvider` continua
 * sendo o provedor de desenvolvimento e a conciliação por polling continua
 * sendo a rede de segurança.
 *
 * Duas coisas específicas do Brasil precisam ser confirmadas contra a conta
 * quando ela existir, e estão na tabela de lacunas: a disponibilidade do Pix e
 * o prazo de expiração que a Stripe permite para ele.
 */

/**
 * O estado da Stripe traduzido para o do produto.
 *
 * A tabela é escrita e não derivada por prefixo. `requires_action` e
 * `processing` parecem "ainda vai dar certo" e são coisas diferentes —
 * `requires_action` é o cliente precisando fazer algo (abrir o app do banco,
 * confirmar 3DS) e `processing` é a Stripe conferindo. Os dois viram
 * `aguardando`, mas por motivos diferentes, e um `startsWith` esconderia isso.
 *
 * Estado desconhecido vira `aguardando` e **não** `recusado`: a Stripe
 * acrescenta estado, e tratar o que não se conhece como recusa faria uma
 * cobrança boa ser cancelada no dia em que ela publicasse um estado novo.
 */
export function estadoDoPagamento(status: string): EstadoDoPagamento {
  switch (status) {
    case 'succeeded':
      return 'pago';
    case 'canceled':
      return 'expirado';
    case 'requires_payment_method':
      // Só é recusa depois de uma tentativa. Antes dela é o estado inicial de
      // um PaymentIntent sem meio anexado, que ainda não falhou em nada.
      return 'recusado';
    default:
      return 'aguardando';
  }
}

interface PaymentIntent {
  id: string;
  status: string;
  next_action?: {
    pix_display_qr_code?: { data?: string; expires_at?: number };
  };
}

interface Sessao {
  id: string;
  url?: string;
  status?: string;
  payment_status?: string;
  expires_at?: number;
  payment_intent?: string;
}

/**
 * A barbearia cobrando o cliente dela.
 *
 * Pix e cartão saem por `PaymentIntent`; link sai por `Checkout Session`, que é
 * uma página hospedada pela Stripe. A escolha não é estética: link é para
 * mandar por WhatsApp a quem não está no balcão, e hospedar essa página nós
 * mesmos significaria receber dado de cartão — o que este produto não faz e não
 * quer fazer (não existe coluna para PAN nem CVV, e há invariante que reprova
 * se alguém criar uma).
 */
export class StripePaymentProvider implements PaymentProvider {
  constructor(private readonly cliente: StripeCliente = new StripeCliente()) {}

  async criarCobranca(pedido: PedidoDePagamento): Promise<CobrancaCriada> {
    if (pedido.meio === 'link') return this.criarLink(pedido);
    return this.criarIntent(pedido);
  }

  private async criarIntent(pedido: PedidoDePagamento): Promise<CobrancaCriada> {
    const intent = await this.cliente.post<PaymentIntent>(
      '/payment_intents',
      {
        amount: pedido.valorCents,
        currency: 'brl',
        description: pedido.descricao,
        payment_method_types: [pedido.meio === 'pix' ? 'pix' : 'card'],
        /**
         * A comanda e a barbearia viajam como metadado.
         *
         * É por eles que o webhook reencontra o que cobrar sem consultar nada:
         * o evento da Stripe chega sem tenant, e um webhook que precisasse
         * procurar o pagamento em todas as barbearias teria que rodar sem
         * isolamento — que é exatamente o que a RLS existe para impedir.
         */
        metadata: { order_id: pedido.orderId, tenant_id: pedido.tenantId },
        ...(pedido.meio === 'pix'
          ? { payment_method_data: { type: 'pix' }, confirm: true }
          : {}),
      },
      { idempotencyKey: chaveDoAdquirente(pedido) },
    );

    const qr = intent.next_action?.pix_display_qr_code;
    return {
      estado: estadoDoPagamento(intent.status),
      pagamentoId: intent.id,
      ...(qr?.data ? { pixCopiaECola: qr.data } : {}),
      ...(qr?.expires_at ? { expiraEm: new Date(qr.expires_at * 1000) } : {}),
    };
  }

  private async criarLink(pedido: PedidoDePagamento): Promise<CobrancaCriada> {
    const sessao = await this.cliente.post<Sessao>(
      '/checkout/sessions',
      {
        mode: 'payment',
        currency: 'brl',
        // `price_data` inline em vez de um catálogo de preços na Stripe: o
        // preço já é decidido pela comanda, e espelhá-lo lá criaria uma
        // segunda fonte da verdade para número que muda a cada venda.
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'brl',
              unit_amount: pedido.valorCents,
              product_data: { name: pedido.descricao },
            },
          },
        ],
        metadata: { order_id: pedido.orderId, tenant_id: pedido.tenantId },
      },
      { idempotencyKey: chaveDoAdquirente(pedido) },
    );

    return {
      estado: sessao.payment_status === 'paid' ? 'pago' : 'aguardando',
      pagamentoId: sessao.id,
      ...(sessao.url ? { url: sessao.url } : {}),
      ...(sessao.expires_at ? { expiraEm: new Date(sessao.expires_at * 1000) } : {}),
    };
  }

  async consultar(pagamentoId: string): Promise<EstadoDoPagamento> {
    // O prefixo diz o recurso: `cs_` é sessão de checkout, `pi_` é intent. É a
    // própria Stripe que garante isso, e ler o prefixo evita guardar de que
    // tipo cada pagamento é numa segunda coluna que pode divergir.
    if (pagamentoId.startsWith('cs_')) {
      const sessao = await this.cliente.get<Sessao>(`/checkout/sessions/${noCaminho(pagamentoId)}`);
      if (sessao.payment_status === 'paid') return 'pago';
      return sessao.status === 'expired' ? 'expirado' : 'aguardando';
    }

    const intent = await this.cliente.get<PaymentIntent>(`/payment_intents/${noCaminho(pagamentoId)}`);
    return estadoDoPagamento(intent.status);
  }

  async estornar(
    pagamentoId: string,
    valorCents?: number,
  ): Promise<{ readonly estornoId: string }> {
    const estorno = await this.cliente.post<{ id: string }>(
      '/refunds',
      {
        payment_intent: pagamentoId,
        ...(valorCents === undefined ? {} : { amount: valorCents }),
      },
      // Estorno é POST que move dinheiro, e portanto exige chave. Derivada, não
      // sorteada: a retentativa precisa produzir a mesma, senão a resposta que
      // se perdeu devolve o dinheiro duas vezes.
      { idempotencyKey: chaveDoEstorno(pagamentoId, valorCents) },
    );
    return { estornoId: estorno.id };
  }
}

/**
 * A plataforma cobrando a barbearia — a outra ponta, mesmo cliente.
 *
 * `off_session: true` e `confirm: true` porque não há ninguém olhando: é a
 * régua de cobrança rodando de madrugada sobre um cartão salvo. É também o que
 * diz à Stripe que ela deve tentar sem pedir 3DS — e o que faz a recusa vir com
 * o motivo, que é o que a escada de retentativa do bloco 28 registra.
 */
export class StripePspProvider implements PspProvider {
  constructor(private readonly cliente: StripeCliente = new StripeCliente()) {}

  async cobrar(pedido: PedidoDeCobranca): Promise<RespostaDaCobranca> {
    try {
      const intent = await this.cliente.post<PaymentIntent>(
        '/payment_intents',
        {
          amount: pedido.valorCents,
          currency: 'brl',
          customer: pedido.pspCustomerId,
          payment_method: pedido.pspMethodId,
          off_session: true,
          confirm: true,
          metadata: { fatura_id: pedido.faturaId, tenant_id: pedido.tenantId },
        },
        // A fatura é a chave: a régua pode rodar duas vezes no mesmo dia — dois
        // workers, um reinício — e a segunda volta não pode emitir a segunda
        // cobrança da mesma fatura.
        { idempotencyKey: `fatura:${pedido.faturaId}` },
      );

      return { estado: paraEstadoDaCobranca(intent.status), chargeId: intent.id };
    } catch (erro) {
      /**
       * Recusa é resposta, não falha.
       *
       * A Stripe devolve 402 com `error.code` quando o cartão não passa, e
       * deixar isso subir como exceção faria a régua tratar "o cartão foi
       * recusado" — que é informação — como "o adquirente está fora do ar",
       * que é outra coisa e não deve gastar degrau da escada.
       */
      if (erro instanceof StripeError && erro.status === 402) {
        return { estado: 'recusada', chargeId: '', motivo: erro.code };
      }
      throw erro;
    }
  }

  async consultar(chargeId: string): Promise<EstadoDaCobranca> {
    const intent = await this.cliente.get<PaymentIntent>(`/payment_intents/${noCaminho(chargeId)}`);
    return paraEstadoDaCobranca(intent.status);
  }

  /**
   * Devolve dinheiro **de uma cobrança**, nunca "da conta".
   *
   * A primeira versão deste método mandava `{ customer, amount }`, o que a
   * Stripe recusa: `POST /refunds` precisa saber o que está sendo estornado.
   * O efeito seria pior do que um erro — o crédito da barbearia já teria sido
   * debitado e o lançamento gravado quando a chamada falhasse, e o dinheiro
   * sumiria do saldo dela sem chegar em lugar nenhum.
   */
  async estornar(pedido: PedidoDeEstorno): Promise<{ readonly refundId: string }> {
    try {
      const estorno = await this.cliente.post<{ id: string }>(
        '/refunds',
        { payment_intent: pedido.pspChargeId, amount: pedido.valorCents },
        // A chave é o lançamento, e não a cobrança: estornar duas vezes
        // metade de uma fatura é operação legítima, e uma chave derivada do
        // valor faria a segunda ser engolida como repetição da primeira.
        { idempotencyKey: `estorno:${pedido.estornoId}` },
      );
      return { refundId: estorno.id };
    } catch (erro) {
      /**
       * Recusa definitiva e indisponibilidade são coisas diferentes, e quem
       * sabe a diferença é este arquivo.
       *
       * 4xx é a Stripe dizendo "não vou fazer isso" — a cobrança não existe, já
       * foi estornada inteira, o valor não cabe. Aí o crédito debitado tem que
       * voltar, porque nada saiu da conta. 5xx e falha de rede são ambíguos: o
       * estorno **pode** ter sido feito, e devolver o crédito nesse caso
       * pagaria a barbearia duas vezes.
       */
      if (erro instanceof StripeError && erro.status >= 400 && erro.status < 500) {
        throw new EstornoRecusado(erro.code, erro.message);
      }
      throw erro;
    }
  }
}

/** O mesmo mapa, na linguagem da cobrança da plataforma (bloco 29). */
export function paraEstadoDaCobranca(status: string): EstadoDaCobranca {
  switch (status) {
    case 'succeeded':
      return 'paga';
    case 'requires_payment_method':
    case 'canceled':
      return 'recusada';
    default:
      return 'pendente';
  }
}
