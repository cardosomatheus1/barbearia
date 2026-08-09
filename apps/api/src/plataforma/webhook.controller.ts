import { Controller, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  aplicarEvento,
  conferirAssinaturaDoWebhook,
  WebhookInvalido,
  type TipoDeEvento,
} from '@barbearia/platform';
import { z } from 'zod';
import { badRequest, DomainError } from '../common/errors.js';

/**
 * A porta do adquirente (bloco 29).
 *
 * É a **única** rota do produto sem sessão e com efeito sobre dinheiro, e por
 * isso ela é a rota mais desconfiada que existe aqui. Quem a chama não é o
 * cliente, não é o gestor e não é o Super Admin: é um servidor de terceiro que
 * não tem como se autenticar com nenhum dos três mecanismos.
 *
 * ## O que substitui a sessão
 *
 * Assinatura HMAC sobre o corpo **cru**, com instante dentro e janela de cinco
 * minutos, comparada em tempo constante. Os três detalhes importam, e o
 * porquê de cada um está em `conferirAssinaturaDoWebhook`.
 *
 * O segredo vem do ambiente e **falha alto quando ausente** — cair num padrão
 * vazio faria toda assinatura conferir, e a rota que quita fatura viraria
 * pública. É a mesma regra de `STAFF_EMAIL_PEPPER` e `MFA_SECRET_KEY`.
 *
 * ## E o que o corpo pode fazer depois de assinado
 *
 * Nada além do que o schema aceita. Assinatura prova origem, não intenção: um
 * evento legítimo com `chargeId` de outra barbearia continuaria sendo aplicado
 * pela cobrança amarrada, e é `aplicarEvento` quem resolve isso — a fatura é
 * encontrada **pelo** `psp_charge_id`, que só a nossa própria cobrança
 * escreveu.
 *
 * ## Por que a resposta é sempre 200 quando a assinatura confere
 *
 * O adquirente reentrega tudo que não recebeu 2xx. Responder 404 para um evento
 * sobre fatura já paga faria o provedor repetir por horas o que já está certo,
 * e no fim marcar o endereço como quebrado. Duplicata e desconhecido são
 * respostas normais: o desfecho vai no corpo, e a trilha fica em `psp_events`.
 */

const TIPOS: readonly TipoDeEvento[] = ['charge.paid', 'charge.failed', 'charge.pending'];

const eventoSchema = z.object({
  id: z.string().trim().min(1).max(200),
  type: z.enum(['charge.paid', 'charge.failed', 'charge.pending']),
  chargeId: z.string().trim().min(1).max(200),
  data: z.record(z.unknown()).default({}),
});

/**
 * O corpo cru, guardado pelo `verify` do parser de JSON.
 *
 * A assinatura é sobre os bytes que o adquirente assinou. Reserializar o objeto
 * já analisado mudaria espaço em branco e ordem de chave, e a conferência
 * passaria a depender do `JSON.stringify` do Node em vez do que o provedor
 * mandou.
 */
interface RequisicaoComCorpoCru extends Request {
  rawBody?: Buffer;
}

@Controller('v1/webhooks/psp')
export class WebhookDoPspController {
  @Post()
  async receber(
    @Req() requisicao: RequisicaoComCorpoCru,
    @Headers('x-psp-signature') assinatura?: string,
  ) {
    const segredo = process.env['PSP_WEBHOOK_SECRET'] ?? '';
    const corpoCru = requisicao.rawBody?.toString('utf8');
    if (corpoCru === undefined) {
      // Sem o corpo cru não há o que conferir, e aceitar sem conferir é pior do
      // que recusar: seria a rota que quita fatura, aberta.
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
         * 400 e mensagem genérica, com o código no corpo.
         *
         * O detalhe — se foi a janela, o formato ou o segredo — fica no log. Um
         * atacante que soubesse distinguir "assinatura inválida" de "fora da
         * janela" ganharia um oráculo para calibrar a tentativa seguinte.
         */
        throw badRequest('invalid_webhook', 'Webhook recusado');
      }
      throw erro;
    }

    const analisado = eventoSchema.safeParse(requisicao.body);
    if (!analisado.success) throw badRequest('invalid_webhook', 'Webhook recusado');

    const desfecho = await aplicarEvento({
      eventoId: analisado.data.id,
      tipo: analisado.data.type,
      chargeId: analisado.data.chargeId,
      payload: analisado.data.data,
    });

    return { desfecho };
  }
}

export const TIPOS_DE_EVENTO = TIPOS;
