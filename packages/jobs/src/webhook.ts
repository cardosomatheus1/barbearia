import type { TransactionClient } from '@barbearia/db';
import type { CorpoDoWebhook, EventoDeWebhook } from '@barbearia/core';
import { enfileirarPara } from './fila.js';

/**
 * Registrar um evento de webhook, de dentro da transação que cria o fato
 * (bloco 79).
 *
 * ## Por que isto mora em `jobs`
 *
 * Quem emite é `scheduling` (agendamento) e `finance` (comanda paga), e os dois
 * já dependem de `jobs` — foi assim que a comissão e a nota fiscal resolveram o
 * mesmo problema. Pôr isto em `identity` obrigaria `scheduling` a depender dela
 * por uma seta nova; pôr em `platform` inverteria a direção.
 *
 * A **entrega** é outra coisa e não mora aqui: ela decifra o segredo, assina e
 * fala com a internet. Ela chega ao worker injetada no `Contexto`, como
 * `varrerRetencao` e `avisarDeCobranca` — `jobs` continua sem saber que existe
 * criptografia.
 *
 * ## Dentro da transação, sempre
 *
 * O aviso nasce **junto** do fato. Depois do commit existe a janela em que o
 * horário foi marcado e o sistema do cliente não sabe — e é nela que o processo
 * cai. Mesma razão da comissão, da nota e do lembrete.
 */

export interface EventoParaEntregar {
  readonly tenantId: string;
  readonly evento: EventoDeWebhook;
  readonly objetoId: string;
  readonly locationId: string | null;
  readonly quando: Date;
}

/**
 * Grava uma entrega por endpoint inscrito no evento, e enfileira a tarefa.
 *
 * Uma instrução para todos os endpoints: um laço com ida ao banco por endpoint
 * seria N+1 dentro da transação que marca o horário — a mais quente do produto.
 *
 * Sem endpoint inscrito, não faz nada e não custa nada além da própria consulta.
 * É o caso da esmagadora maioria das barbearias, e por isso ele é o barato.
 */
export async function registrarEventoDeWebhook(
  tx: TransactionClient,
  entrada: EventoParaEntregar,
): Promise<number> {
  const corpoBase: Omit<CorpoDoWebhook, 'event_id'> = {
    event: entrada.evento,
    occurred_at: entrada.quando.toISOString(),
    object_id: entrada.objetoId,
    location_id: entrada.locationId,
  };

  /**
   * O `payload` é montado **no banco**, com o `event_id` da própria linha.
   *
   * Gerá-lo aqui exigiria sortear o uuid do lado de cá e confiar que ele chega
   * igual; e o corpo precisa carregar o mesmo id que a linha guarda, senão a
   * deduplicação do outro lado aponta para uma entrega que não existe.
   */
  const criadas = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event, payload)
    SELECT e.tenant_id, e.id, ${entrada.evento}::webhook_event,
           ${JSON.stringify(corpoBase)}::jsonb
      FROM webhook_endpoints e
     WHERE e.active
       AND ${entrada.evento}::webhook_event = ANY (e.events)
    RETURNING id
  `;
  if (criadas.length === 0) return 0;

  const ids = criadas.map((c) => c.id);
  await tx.$executeRaw`
    UPDATE webhook_deliveries
       SET payload = payload || jsonb_build_object('event_id', event_id::text)
     WHERE id = ANY (${ids}::uuid[])
  `;

  for (const id of ids) {
    await enfileirarPara(tx, entrada.tenantId, {
      kind: 'webhook.entregar',
      /** Id, nunca conteúdo: `jobs` não tem RLS, e o payload é legível sem tenant. */
      payload: { entregaId: id },
      rodarApos: entrada.quando,
    });
  }

  return criadas.length;
}
