import { Controller, Get, Headers, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  AssinaturaDoWhatsAppInvalida,
  conferirAssinaturaDaMeta,
  registrarEstadoDaMensagem,
  registrarResposta,
  tenantDoNumero,
  type EstadoDaMensagem,
} from '@barbearia/crm';
import { z } from 'zod';
import { badRequest, DomainError } from '../common/errors.js';

/**
 * A porta da Meta (bloco 55, SPEC §4.12).
 *
 * A terceira rota do produto sem sessão, depois das duas do adquirente. O que
 * ela recebe é de dois tipos e chega pelo mesmo endereço: o que aconteceu com
 * uma mensagem que saiu (entregue, lida, falhou) e o que o cliente respondeu
 * (o toque num botão, ou texto).
 *
 * ## A assinatura é outra conta que a do adquirente
 *
 * A Stripe assina `${instante}.${corpo}` e manda o instante, o que permite
 * recusar reenvio antigo por janela de tempo. A Meta assina **só o corpo cru**,
 * em `X-Hub-Signature-256`, com o *app secret* — não há instante, então não há
 * janela.
 *
 * O que substitui a janela é a idempotência por id de mensagem: reenviar um
 * evento capturado grava o mesmo `wamid`, esbarra na unicidade e não faz nada.
 * É por isso que aquela constraint existe no banco e não só no código.
 *
 * ## Como o evento reencontra a barbearia
 *
 * Pelo `phone_number_id`, que é o número **dela** — e a busca é em
 * `whatsapp_numbers`, a única tabela deste bloco sem RLS. É a mesma razão de
 * `tenant_slugs`: o webhook chega antes de existir tenant no contexto, e
 * procurar numa tabela com row security sem tenant devolve zero linhas, sempre
 * e em silêncio.
 *
 * Assinatura prova origem, não intenção: um evento legítimo apontando para um
 * número que não é nosso não encontra barbearia nenhuma e vira `ignorado`.
 *
 * ## Por que a resposta é 200 sempre que a assinatura confere
 *
 * A Meta reentrega o que não recebeu 2xx, e depois marca o endereço como
 * quebrado. Duplicata e evento desconhecido são respostas normais dela.
 */

interface RequisicaoComCorpoCru extends Request {
  rawBody?: Buffer;
}

/**
 * O envelope da Meta, no mínimo que este produto lê.
 *
 * Sem `passthrough`: o que não está aqui não entra. Um webhook da Meta carrega
 * dezenas de campos, e aceitar o objeto inteiro poria dado que ninguém decidiu
 * guardar dentro do produto.
 */
const eventoDaMeta = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            metadata: z.object({ phone_number_id: z.string() }).optional(),
            statuses: z
              .array(
                z.object({
                  id: z.string(),
                  status: z.string(),
                  errors: z
                    .array(z.object({ title: z.string().optional() }))
                    .optional(),
                }),
              )
              .optional(),
            messages: z
              .array(
                z.object({
                  id: z.string(),
                  from: z.string(),
                  type: z.string(),
                  text: z.object({ body: z.string() }).optional(),
                  button: z.object({ payload: z.string().optional() }).optional(),
                  interactive: z
                    .object({
                      button_reply: z.object({ id: z.string() }).optional(),
                    })
                    .optional(),
                }),
              )
              .optional(),
          }),
        }),
      ),
    }),
  ),
});

/**
 * O vocabulário da Meta traduzido para o do produto.
 *
 * `accepted` e `sent` são a mesma coisa para quem opera — a mensagem saiu — e
 * juntá-los aqui evita um estado que a tela teria que explicar. O que **não**
 * está neste mapa é ignorado sem consumir a entrega, que é o precedente do
 * evento do adquirente que não diz estado: registrá-lo como consumido faria a
 * reentrega do evento de verdade não fazer nada.
 */
const ESTADO: Readonly<Record<string, EstadoDaMensagem>> = {
  sent: 'enviada',
  accepted: 'enviada',
  delivered: 'entregue',
  read: 'lida',
  failed: 'falhou',
};

@Controller('v1/webhooks/whatsapp')
export class WhatsAppWebhookController {
  /**
   * A verificação do endereço, que a Meta faz uma vez ao cadastrar.
   *
   * Ela chama com um desafio e espera o texto de volta, em claro. O token é de
   * ambiente e a comparação recusa quando ele falta — cair num padrão vazio
   * deixaria qualquer um registrar o próprio endereço como se fosse o nosso.
   */
  @Get()
  verificar(
    @Query('hub.mode') modo?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') desafio?: string,
  ): string {
    const esperado = process.env['WHATSAPP_VERIFY_TOKEN'] ?? '';
    if (!esperado || modo !== 'subscribe' || token !== esperado || !desafio) {
      throw badRequest('invalid_webhook', 'Webhook recusado');
    }
    return desafio;
  }

  @Post()
  async receber(
    @Req() requisicao: RequisicaoComCorpoCru,
    @Headers('x-hub-signature-256') assinatura?: string,
  ) {
    const segredo = process.env['WHATSAPP_APP_SECRET'] ?? '';
    const corpoCru = requisicao.rawBody?.toString('utf8');
    if (corpoCru === undefined) {
      // Sem o corpo cru não há o que conferir, e aceitar sem conferir seria
      // pior do que recusar: a rota que cancela horário, aberta.
      throw new DomainError('webhook_unverifiable', 500, 'Webhook não pôde ser verificado');
    }

    try {
      conferirAssinaturaDaMeta({ corpoCru, cabecalho: assinatura, segredo });
    } catch (erro) {
      if (erro instanceof AssinaturaDoWhatsAppInvalida) {
        /**
         * 400 e mensagem genérica; o detalhe fica no log.
         *
         * Quem soubesse distinguir "assinatura ausente" de "assinatura
         * inválida" ganharia um oráculo para calibrar a tentativa seguinte.
         */
        throw badRequest('invalid_webhook', 'Webhook recusado');
      }
      throw erro;
    }

    const analisado = eventoDaMeta.safeParse(requisicao.body);
    if (!analisado.success) throw badRequest('invalid_webhook', 'Webhook recusado');

    let tratados = 0;
    for (const entrada of analisado.data.entry) {
      for (const mudanca of entrada.changes) {
        const numero = mudanca.value.metadata?.phone_number_id;
        if (!numero) continue;

        // O número abre a barbearia; nada com RLS é lido antes disto.
        const dono = await tenantDoNumero(numero);
        if (!dono) continue;

        for (const estado of mudanca.value.statuses ?? []) {
          const traduzido = ESTADO[estado.status];
          if (!traduzido) continue;
          await registrarEstadoDaMensagem({
            tenantId: dono.tenantId,
            wamid: estado.id,
            estado: traduzido,
            motivo: estado.errors?.[0]?.title ?? null,
          });
          tratados += 1;
        }

        for (const mensagem of mudanca.value.messages ?? []) {
          /**
           * O toque no botão vem em dois formatos, e os dois são da Meta.
           *
           * `button.payload` é o do template aprovado — é o que este produto
           * manda. `interactive.button_reply.id` é o da mensagem interativa, que
           * a Meta usa em outro fluxo. Ler os dois custa uma linha e evita que
           * o botão pare de funcionar quando ela mudar de formato.
           */
          const payload =
            mensagem.button?.payload ?? mensagem.interactive?.button_reply?.id ?? null;

          await registrarResposta({
            tenantId: dono.tenantId,
            wamid: mensagem.id,
            telefone: mensagem.from.startsWith('+') ? mensagem.from : `+${mensagem.from}`,
            payload,
            texto: mensagem.text?.body ?? null,
          });
          tratados += 1;
        }
      }
    }

    return { ok: true, tratados };
  }
}
