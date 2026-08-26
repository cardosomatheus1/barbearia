import { randomUUID } from 'node:crypto';
import type { BotaoDaMensagem, BotaoQueLeva, TipoDeNotificacao } from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import { audit } from '@barbearia/identity';
import { enfileirar } from '@barbearia/jobs';
import { recusar } from './whatsapp-erros.js';

export interface ClaimDeTemplate {
  readonly id: string;
  readonly metaId: string | null;
  readonly claim: string;
}

/**
 * Toma posse persistente de uma submissão/edição, e **enfileira a ida à Meta**.
 *
 * `FOR UPDATE` serializa quem já tem linha; `ON CONFLICT DO NOTHING` fecha a
 * corrida de duas primeiras criações.
 *
 * ## A tarefa nasce dentro desta transação (bloco 133)
 *
 * É a regra de sempre: trabalho fora de requisição é tarefa em `jobs`,
 * enfileirada **dentro** da transação que cria o fato. Enfileirar depois do
 * commit abriria a janela em que a linha existe em `sending` e nada está
 * marcado para levá-la à Meta — e `sending` bloqueia a submissão seguinte, então
 * a barbearia ficaria com um texto travado e sem caminho.
 *
 * O `payload` carrega **ids**, nunca o corpo: `jobs` não tem RLS, e o texto que
 * a barbearia escreveu é dela. Quem lê o corpo é o handler, sob `withTenant`.
 *
 * A chave de idempotência é o **claim**, que é sorteado a cada reserva: uma
 * correção do mesmo texto amanhã é outra ida à Meta e precisa da tarefa dela.
 * Fosse o id do template, o `ON CONFLICT DO NOTHING` descartaria a segunda em
 * silêncio e o texto corrigido nunca sairia.
 */
export async function reservarSubmissaoDeTemplate(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly tipo: TipoDeNotificacao;
  readonly nome: string;
  readonly idioma: string;
  readonly corpo: string;
  readonly botoes: readonly (BotaoDaMensagem | BotaoQueLeva)[];
  readonly titulo: string | null;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<ClaimDeTemplate> {
  const claim = randomUUID();
  return withTenant(params.tenantId, async (tx) => {
    const existentes = await tx.$queryRaw<
      { id: string; meta_id: string | null; submission_state: string }[]
    >`
      SELECT id, meta_id, submission_state
        FROM whatsapp_templates
       WHERE location_id = ${params.locationId}::uuid
         AND name = ${params.nome}
         AND language = ${params.idioma}
       FOR UPDATE
    `;
    const existente = existentes[0] ?? null;
    if (existente && existente.submission_state !== 'idle') {
      recusar('template_em_processamento');
    }

    let linha: { id: string; meta_id: string | null } | undefined;
    if (existente) {
      const atualizadas = await tx.$queryRaw<{ id: string; meta_id: string | null }[]>`
        UPDATE whatsapp_templates
           SET kind = ${params.tipo}::notification_kind,
               body = ${params.corpo},
               buttons = ${JSON.stringify(params.botoes)}::jsonb,
               titulo = COALESCE(${params.titulo}, titulo),
               status = 'pendente',
               rejection_reason = NULL,
               submission_state = 'sending',
               submission_claim = ${claim}::uuid,
               submission_updated_at = now(),
               updated_at = now()
         WHERE id = ${existente.id}::uuid
           AND submission_state = 'idle'
        RETURNING id, meta_id
      `;
      linha = atualizadas[0];
    } else {
      const inseridas = await tx.$queryRaw<{ id: string; meta_id: string | null }[]>`
        INSERT INTO whatsapp_templates
          (tenant_id, location_id, kind, name, language, status, body, buttons, titulo,
           submission_state, submission_claim, submission_updated_at)
        SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid,
               ${params.locationId}::uuid, ${params.tipo}::notification_kind,
               ${params.nome}, ${params.idioma}, 'pendente', ${params.corpo},
               ${JSON.stringify(params.botoes)}::jsonb, ${params.titulo},
               'sending', ${claim}::uuid, now()
         WHERE EXISTS (SELECT 1 FROM locations WHERE id = ${params.locationId}::uuid)
        ON CONFLICT (location_id, name, language) DO NOTHING
        RETURNING id, meta_id
      `;
      linha = inseridas[0];
      if (!linha) recusar('template_em_processamento');
    }
    if (!linha) recusar('nao_configurado');

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'whatsapp.template_submitted',
      entity: 'whatsapp_templates',
      entityId: linha.id,
      after: { nome: params.nome, tipo: params.tipo },
    });
    await enfileirar(tx, {
      kind: 'whatsapp.submeter_template',
      payload: { templateId: linha.id, claim },
      idempotencyKey: `whatsapp-template:${claim}`,
    });
    return { id: linha.id, metaId: linha.meta_id, claim };
  });
}

/**
 * Fecha somente o claim desta tentativa. Transporte incerto continua bloqueado
 * até a conciliação por nome; recusa explícita volta a rascunho e pode tentar de
 * novo sem duplicar criação na Meta.
 */
export async function registrarFalhaDaSubmissao(params: {
  readonly tenantId: string;
  readonly templateId: string;
  readonly claim: string;
  readonly incerta: boolean;
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE whatsapp_templates
         SET submission_state = ${params.incerta ? 'uncertain' : 'idle'},
             submission_claim = ${params.incerta ? params.claim : null}::uuid,
             submission_updated_at = now(),
             status = ${params.incerta ? 'pendente' : 'rascunho'}::whatsapp_template_status,
             updated_at = now()
       WHERE id = ${params.templateId}::uuid
         AND submission_claim = ${params.claim}::uuid
    `;
  });
}
