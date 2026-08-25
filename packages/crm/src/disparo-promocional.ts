import {
  instantToLocal,
  TETO_PROMOCIONAL_MES,
  TIPOS_PROMOCIONAIS,
  type TipoDeNotificacao,
} from '@barbearia/core';
import type { TransactionClient } from '@barbearia/db';

export type MotivoDaReservaPromocional =
  | 'ja_recebeu_hoje'
  | 'teto_do_mes'
  | 'envio_em_andamento'
  | 'entrega_incerta'
  | 'ja_enviado';

export interface ReservaPromocional {
  readonly nossa: boolean;
  readonly motivo: MotivoDaReservaPromocional | null;
}

const LIMITE_DE_ENVIO_EM_VOO_MS = 10 * 60_000;

/**
 * Reserva a cota promocional antes de qualquer chamada externa.
 *
 * Campanha, automação e envio avulso passam por esta mesma trava. O advisory
 * lock serializa a decisão por cliente; a linha em `notification_send_intents`
 * sobrevive ao commit e impede que outra frente use a mesma vaga enquanto a
 * Meta ainda está sendo chamada. Assim a rede fica fora da transação sem abrir
 * a antiga janela "li zero, você também leu zero, os dois enviaram".
 */
export async function reservarDisparoPromocional(
  tx: TransactionClient,
  params: {
    readonly tenantId: string;
    readonly customerId: string;
    readonly intentKey: string;
    readonly tipo: TipoDeNotificacao;
    readonly agora: Date;
    readonly timeZone: string;
  },
): Promise<ReservaPromocional> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`barberdock:promo:${params.tenantId}:${params.customerId}`}, 0)
    )
  `;

  const existentes = await tx.$queryRaw<
    { status: 'sending' | 'uncertain' | 'sent'; updated_at: Date }[]
  >`
    SELECT status, updated_at
      FROM notification_send_intents
     WHERE tenant_id = ${params.tenantId}::uuid
       AND intent_key = ${params.intentKey}
     LIMIT 1
  `;
  const existente = existentes[0];
  if (existente) {
    if (existente.status === 'sent') return { nossa: false, motivo: 'ja_enviado' };
    if (existente.status === 'uncertain') return { nossa: false, motivo: 'entrega_incerta' };

    if (params.agora.getTime() - existente.updated_at.getTime() >= LIMITE_DE_ENVIO_EM_VOO_MS) {
      await tx.$executeRaw`
        UPDATE notification_send_intents
           SET status = 'uncertain', updated_at = ${params.agora}
         WHERE tenant_id = ${params.tenantId}::uuid
           AND intent_key = ${params.intentKey} AND status = 'sending'
      `;
      return { nossa: false, motivo: 'entrega_incerta' };
    }
    return { nossa: false, motivo: 'envio_em_andamento' };
  }

  const diaLocal = instantToLocal(params.timeZone, params.agora).date;
  const contagens = await tx.$queryRaw<{ hoje: bigint; no_mes: bigint }[]>`
    SELECT
      (
        SELECT count(*) FROM notification_send_intents i
         WHERE i.tenant_id = ${params.tenantId}::uuid
           AND i.customer_id = ${params.customerId}::uuid
           AND i.quota_date = ${diaLocal}::date
           AND i.status IN ('sending', 'uncertain', 'sent')
      ) + (
        SELECT count(*) FROM notifications n
         WHERE n.customer_id = ${params.customerId}::uuid
           AND n.status = 'sent'
           AND n.kind = ANY(${[...TIPOS_PROMOCIONAIS]}::notification_kind[])
           AND (n.sent_at AT TIME ZONE ${params.timeZone})::date = ${diaLocal}::date
           AND NOT EXISTS (
             SELECT 1 FROM notification_send_intents i
              WHERE i.tenant_id = ${params.tenantId}::uuid AND i.notification_id = n.id
           )
      ) AS hoje,
      (
        SELECT count(*) FROM notification_send_intents i
         WHERE i.tenant_id = ${params.tenantId}::uuid
           AND i.customer_id = ${params.customerId}::uuid
           AND i.quota_at > ${params.agora}::timestamptz - interval '30 days'
           AND i.status IN ('sending', 'uncertain', 'sent')
      ) + (
        SELECT count(*) FROM notifications n
         WHERE n.customer_id = ${params.customerId}::uuid
           AND n.status = 'sent'
           AND n.kind = ANY(${[...TIPOS_PROMOCIONAIS]}::notification_kind[])
           AND n.sent_at > ${params.agora}::timestamptz - interval '30 days'
           AND NOT EXISTS (
             SELECT 1 FROM notification_send_intents i
              WHERE i.tenant_id = ${params.tenantId}::uuid AND i.notification_id = n.id
           )
      ) AS no_mes
  `;
  const contagem = contagens[0] ?? { hoje: 0n, no_mes: 0n };
  if (Number(contagem.hoje) > 0) return { nossa: false, motivo: 'ja_recebeu_hoje' };
  if (Number(contagem.no_mes) >= TETO_PROMOCIONAL_MES) {
    return { nossa: false, motivo: 'teto_do_mes' };
  }

  const novas = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO notification_send_intents
      (tenant_id, intent_key, status, customer_id, quota_at, quota_date)
    VALUES (
      ${params.tenantId}::uuid,
      ${params.intentKey}, 'sending', ${params.customerId}::uuid,
      ${params.agora}, ${diaLocal}::date
    )
    ON CONFLICT (tenant_id, intent_key) DO NOTHING
    RETURNING id
  `;
  if (!novas[0]) return { nossa: false, motivo: 'envio_em_andamento' };
  return { nossa: true, motivo: null };
}

/** Confirma envio e cria exatamente uma linha de histórico para a cota. */
export async function confirmarDisparoPromocional(
  tx: TransactionClient,
  params: {
    readonly intentKey: string;
    readonly tipo: TipoDeNotificacao;
    readonly customerId: string;
    readonly phoneMasked: string | null;
    readonly wamid?: string | null;
    readonly enviadoEm: Date;
  },
): Promise<boolean> {
  const linhas = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO notifications (tenant_id, kind, customer_id, status, phone_masked, sent_at)
    SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid,
           ${params.tipo}::notification_kind, ${params.customerId}::uuid,
           'sent', ${params.phoneMasked}, ${params.enviadoEm}
      FROM notification_send_intents i
     WHERE i.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
       AND i.intent_key = ${params.intentKey}
       AND i.status = 'sending'
    RETURNING id
  `;
  const notificacao = linhas[0];
  if (!notificacao) return false;

  const afetadas = await tx.$executeRaw`
    UPDATE notification_send_intents
       SET status = 'sent', notification_id = ${notificacao.id}::uuid,
           wamid = ${params.wamid ?? null}, updated_at = ${params.enviadoEm}
     WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
       AND intent_key = ${params.intentKey} AND status = 'sending'
  `;
  return afetadas === 1;
}

/** Desfecho externo ambíguo: ocupa a cota e nunca é reenviado automaticamente. */
export async function marcarDisparoPromocionalIncerto(
  tx: TransactionClient,
  intentKey: string,
  agora: Date,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE notification_send_intents
       SET status = 'uncertain', updated_at = ${agora}
     WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
       AND intent_key = ${intentKey} AND status = 'sending'
  `;
}

/** Falha definitiva antes de aceitação libera a vaga para uma tentativa futura. */
export async function liberarDisparoPromocional(
  tx: TransactionClient,
  intentKey: string,
): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM notification_send_intents
     WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
       AND intent_key = ${intentKey} AND status = 'sending'
  `;
}
