import { Controller, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  aplicarEvento,
  conferirAssinaturaDoWebhook,
  estadoDoPagamento,
  WebhookInvalido,
} from '@barbearia/platform';
import { confirmarCobranca } from '@barbearia/finance';
import { primaryLocation } from '@barbearia/scheduling';
import { diaNaUnidade } from '@barbearia/core';
import { z } from 'zod';
import { badRequest, DomainError } from '../common/errors.js';

/**
 * A porta da Stripe (bloco 35).
 *
 * A segunda rota do produto sem sessão e com efeito sobre dinheiro — a primeira
 * é `/v1/webhooks/psp`, do bloco 29. As duas existem separadas porque o
 * envelope é diferente: aquela fala o vocabulário do produto (`charge.paid`,
 * `chargeId`), esta fala o da Stripe (`payment_intent.succeeded`,
 * `data.object`). Traduzir aqui é o que mantém o domínio sem saber que
 * adquirente existe.
 *
 * ## A assinatura é a mesma conta que já existia
 *
 * HMAC-SHA256 sobre `${instante}.${corpo cru}`, cabeçalho `t=…,v1=…`, janela de
 * cinco minutos, comparação em tempo constante. É **exatamente** o esquema da
 * Stripe, e `conferirAssinaturaDoWebhook` já o implementava desde o bloco 29 —
 * não houve uma linha nova de criptografia neste bloco.
 *
 * O segredo é `STRIPE_WEBHOOK_SECRET` e é **outro** que o do bloco 29: a Stripe
 * gera um por endereço cadastrado, e reaproveitar o primeiro faria a conferência
 * falhar de um jeito que parece código quebrado.
 *
 * ## Como o evento reencontra a barbearia
 *
 * Pelo metadado que **nós** mandamos na emissão (`tenant_id`, `order_id`), e é
 * por isso que ele existe: o evento da Stripe chega sem tenant, e procurar a
 * cobrança em todas as barbearias exigiria rodar sem isolamento — que é o que a
 * RLS existe para impedir.
 *
 * O metadado abre o tenant; **quem confirma é o id do pagamento**, procurado
 * dentro dele. Assinatura prova origem, não intenção: um evento legítimo com
 * metadado apontando para a barbearia errada não encontra cobrança nenhuma lá,
 * e vira `ignorado` em vez de mexer no dinheiro de quem não é dele.
 *
 * ## Por que a resposta é 200 sempre que a assinatura confere
 *
 * A Stripe reentrega tudo que não recebeu 2xx. Responder 404 para um evento
 * sobre comanda já paga faria ela repetir por horas o que já está certo, e no
 * fim marcar o endereço como quebrado. Duplicata e desconhecido são respostas
 * normais.
 */

/**
 * O envelope da Stripe, no mínimo que este produto lê.
 *
 * `passthrough` **não** é usado: o que não está aqui não entra. Um evento da
 * Stripe carrega dezenas de campos, e aceitar o objeto inteiro colocaria dado
 * do adquirente circulando por caminhos que ninguém revisou.
 */
const eventoDaStripe = z.object({
  id: z.string().trim().min(1).max(200),
  type: z.string().trim().min(1).max(120),
  data: z.object({
    object: z.object({
      id: z.string().trim().min(1).max(200),
      status: z.string().trim().max(60).optional(),
      payment_status: z.string().trim().max(60).optional(),
      payment_intent: z.string().trim().max(200).optional(),
      last_payment_error: z.object({ code: z.string().max(120).optional() }).optional(),
      metadata: z
        .object({
          tenant_id: z.string().uuid().optional(),
          order_id: z.string().uuid().optional(),
          fatura_id: z.string().uuid().optional(),
        })
        .optional(),
    }),
  }),
});

type EventoDaStripe = z.infer<typeof eventoDaStripe>;

/** O vocabulário da cobrança da plataforma (bloco 29), quando o evento é dela. */
const TIPO_DA_FATURA: Readonly<Record<string, 'charge.paid' | 'charge.failed'>> = {
  'payment_intent.succeeded': 'charge.paid',
  'payment_intent.payment_failed': 'charge.failed',
  'payment_intent.canceled': 'charge.failed',
};

interface RequisicaoComCorpoCru extends Request {
  rawBody?: Buffer;
}

@Controller('v1/webhooks/stripe')
export class StripeWebhookController {
  @Post()
  async receber(
    @Req() requisicao: RequisicaoComCorpoCru,
    @Headers('stripe-signature') assinatura?: string,
  ) {
    const segredo = process.env['STRIPE_WEBHOOK_SECRET'] ?? '';
    const corpoCru = requisicao.rawBody?.toString('utf8');
    if (corpoCru === undefined) {
      // Sem o corpo cru não há o que conferir, e aceitar sem conferir seria pior
      // do que recusar: a rota que fecha comanda, aberta.
      throw new DomainError('webhook_unverifiable', 500, 'Webhook não pôde ser verificado');
    }

    try {
      conferirAssinaturaDoWebhook({
        corpoCru,
        cabecalho: assinatura,
        segredo,
        agora: new Date(),
      });
    } catch (erro) {
      if (erro instanceof WebhookInvalido) {
        /**
         * 400 e mensagem genérica; o detalhe fica no log.
         *
         * Quem soubesse distinguir "assinatura inválida" de "fora da janela"
         * ganharia um oráculo para calibrar a tentativa seguinte.
         */
        throw badRequest('invalid_webhook', 'Webhook recusado');
      }
      throw erro;
    }

    const analisado = eventoDaStripe.safeParse(requisicao.body);
    if (!analisado.success) throw badRequest('invalid_webhook', 'Webhook recusado');

    const evento = analisado.data;
    const objeto = evento.data.object;

    // A mensalidade da barbearia (bloco 29) chega pelo mesmo endereço, e é
    // reconhecida pelo metadado que a régua manda. Ela segue pelo caminho que
    // já existe, sem uma segunda máquina de estados.
    if (objeto.metadata?.fatura_id) {
      const tipo = TIPO_DA_FATURA[evento.type];
      if (!tipo) return { desfecho: 'ignorado' };
      return {
        desfecho: await aplicarEvento({
          eventoId: evento.id,
          tipo,
          chargeId: objeto.id,
          payload: { origem: 'stripe', tipo: evento.type },
        }),
      };
    }

    const tenantId = objeto.metadata?.tenant_id;
    if (!tenantId || !objeto.metadata?.order_id) return { desfecho: 'ignorado' };

    const estado = estadoDaStripe(evento);
    if (estado === null) return { desfecho: 'ignorado' };

    /**
     * O dia da unidade, não o do servidor.
     *
     * A comissão é datada pelo dia da barbearia: às 22h de Salvador o UTC já
     * virou, e ela cairia no mês seguinte do acerto do barbeiro (defeito D2, o
     * mesmo que erra a grade). Aqui isso importa ainda mais do que no balcão,
     * porque o webhook chega quando o adquirente quiser.
     */
    const local = await primaryLocation(tenantId);
    if (!local) return { desfecho: 'ignorado' };

    const resultado = await confirmarCobranca({
      tenantId,
      eventoId: evento.id,
      tipo: evento.type,
      pagamentoId: objeto.id,
      estado,
      ...(objeto.last_payment_error?.code ? { motivo: objeto.last_payment_error.code } : {}),
      hojeNaUnidade: diaNaUnidade(null, local.timezone, new Date()).dia,
    });

    return { desfecho: resultado.desfecho };
  }
}

/**
 * O estado que o evento carrega, ou `null` quando o evento não nos diz nada.
 *
 * `null` e não `aguardando`: a Stripe manda evento de coisas que este produto
 * não acompanha (`payment_intent.created`, `charge.updated`), e tratá-los como
 * estado faria a máquina de estados ser exercida à toa — e, pior, registraria
 * um evento consumido que a reentrega do evento **de verdade** encontraria já
 * gravado.
 */
function estadoDaStripe(evento: EventoDaStripe): 'pago' | 'recusado' | 'expirado' | null {
  const objeto = evento.data.object;

  if (evento.type === 'checkout.session.completed') {
    return objeto.payment_status === 'paid' ? 'pago' : null;
  }
  if (evento.type === 'checkout.session.expired') return 'expirado';

  if (!evento.type.startsWith('payment_intent.')) return null;
  if (!objeto.status) return null;

  const traduzido = estadoDoPagamento(objeto.status);
  return traduzido === 'aguardando' ? null : traduzido;
}
