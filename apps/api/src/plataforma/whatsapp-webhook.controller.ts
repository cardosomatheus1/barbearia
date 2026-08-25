import { Controller, Get, Headers, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  AssinaturaDoWhatsAppInvalida,
  conferirAssinaturaDaMeta,
  registrarEstadoDaMensagem,
  registrarResposta,
  numeroVisivelDaUnidadeConfere,
  prepararReconciliacaoDaUnidade,
  suspenderUnidadeWhatsApp,
  tenantDoNumero,
  tenantsDaWaba,
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
 * Eventos de mensagem usam o `phone_number_id` opaco em `whatsapp_numbers`.
 * Eventos de ciclo de vida usam a WABA opaca de `entry.id` em
 * `whatsapp_wabas`. As duas tabelas existem só para resolver tenant + unidade
 * antes da RLS; número visível, token e conversa continuam fora delas.
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
      /** WABA opaca; necessária para eventos de ciclo de vida sem metadata. */
      id: z.string().optional(),
      changes: z.array(
        z.object({
          /**
           * Qual assunto o evento trata.
           *
           * `messages` traz entrega, leitura e o toque nos botões.
           * `account_update` traz o que a Meta faz **com a conta** — e é por
           * ele que chega a desconexão da coexistência (bloco 85).
           */
          field: z.string().optional(),
          value: z.object({
            metadata: z.object({ phone_number_id: z.string() }).optional(),
            /**
             * O que aconteceu com a conta e, quando presente, o número
             * **visível** a que se refere. Ele serve apenas para desambiguar
             * unidades depois do roteamento por WABA; nunca é phone_number_id.
             */
            event: z.string().optional(),
            phone_number: z.string().optional(),
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
        /**
         * Eventos de ciclo de vida não são eventos de mensagem. Neles,
         * `entry.id` identifica a WABA; `phone_number`, quando existe, é o
         * número visível e não pode ser usado como `phone_number_id`.
         */
        if (mudanca.value.event) {
          if (!entrada.id) continue;
          let destinos = [...(await tenantsDaWaba(entrada.id))];

          // Uma WABA pode ter várias unidades. O número visível só participa
          // depois que os ids opacos resolveram tenant + unidade e a RLS existe.
          if (mudanca.value.phone_number && destinos.length > 1) {
            const conferidos = await Promise.all(
              destinos.map(async (destino) => ({
                destino,
                confere: await numeroVisivelDaUnidadeConfere({
                  tenantId: destino.tenantId,
                  locationId: destino.locationId,
                  numeroVisivel: mudanca.value.phone_number!,
                }),
              })),
            );
            destinos = conferidos.filter((item) => item.confere).map((item) => item.destino);
          }

          for (const destino of destinos) {
            if (mudanca.value.event === 'ACCOUNT_OFFBOARDED') {
              const mudou = await suspenderUnidadeWhatsApp({
                tenantId: destino.tenantId,
                locationId: destino.locationId,
                motivo:
                  'A Meta desconectou este número porque o WhatsApp Business foi registrado em outro aparelho. Conecte de novo para os avisos voltarem a sair por ele.',
              });
              if (mudou) tratados += 1;
            } else if (mudanca.value.event === 'PARTNER_REMOVED') {
              const mudou = await suspenderUnidadeWhatsApp({
                tenantId: destino.tenantId,
                locationId: destino.locationId,
                motivo:
                  'A Meta removeu a parceria desta conta do WhatsApp. Reconecte a conta para restabelecer os avisos.',
              });
              if (mudou) tratados += 1;
            } else if (mudanca.value.event === 'ACCOUNT_RECONNECTED') {
              const mudou = await prepararReconciliacaoDaUnidade({
                tenantId: destino.tenantId,
                locationId: destino.locationId,
              });
              if (mudou) tratados += 1;
            }
          }
          continue;
        }

        const numero = mudanca.value.metadata?.phone_number_id;
        if (!numero) continue;

        // Mensagens/estados abrem a barbearia exclusivamente pelo id opaco.
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
