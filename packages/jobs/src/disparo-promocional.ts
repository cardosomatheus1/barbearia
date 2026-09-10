import {
  instantToLocal,
  TETO_PROMOCIONAL_MES,
  TIPOS_PROMOCIONAIS,
  type TipoDeNotificacao,
} from '@barbearia/core';
import { registrarDesfechoDaNotificacao } from './notificacao-desfecho.js';
import type { TransactionClient } from '@barbearia/db';

export type MotivoDaReservaPromocional =
  | 'ja_recebeu_hoje'
  | 'teto_do_mes'
  | 'envio_em_andamento'
  | 'entrega_incerta'
  | 'ja_enviado'
  | 'optou_por_nao_receber';

export interface ReservaPromocional {
  readonly nossa: boolean;
  readonly motivo: MotivoDaReservaPromocional | null;
}

const LIMITE_DE_ENVIO_EM_VOO_MS = 10 * 60_000;

/**
 * Reserva a cota promocional antes de qualquer chamada externa.
 *
 * Retorno, campanha, automação e envio avulso passam por esta mesma trava. O advisory
 * lock serializa a decisão por cliente; a linha em `notification_send_intents`
 * sobrevive ao commit e impede que outra frente use a mesma vaga enquanto a
 * rede ainda está sendo chamada. Assim a rede fica fora da transação sem abrir
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
     WHERE intent_key = ${params.intentKey}
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
         WHERE intent_key = ${params.intentKey} AND status = 'sending'
      `;
      return { nossa: false, motivo: 'entrega_incerta' };
    }
    return { nossa: false, motivo: 'envio_em_andamento' };
  }

  const [cliente] = await tx.$queryRaw<{ accepts_marketing: boolean }[]>`SELECT accepts_marketing FROM customers
    WHERE id = ${params.customerId}::uuid AND anonymized_at IS NULL FOR SHARE`;
  if (!cliente?.accepts_marketing) return { nossa: false, motivo: 'optou_por_nao_receber' };
  const [saida] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM whatsapp_inbound
    WHERE customer_id = ${params.customerId}::uuid AND handled_at IS NULL AND payload = 'parar_de_receber:' LIMIT 1`;
  if (saida) return { nossa: false, motivo: 'optou_por_nao_receber' };

  const diaLocal = instantToLocal(params.timeZone, params.agora).date;
  const contagens = await tx.$queryRaw<{ hoje: bigint; no_mes: bigint }[]>`
    SELECT
      (
        SELECT count(*) FROM notification_send_intents i
         WHERE i.customer_id = ${params.customerId}::uuid
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
              WHERE i.notification_id = n.id
           )
      ) AS hoje,
      (
        SELECT count(*) FROM notification_send_intents i
         WHERE i.customer_id = ${params.customerId}::uuid
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
              WHERE i.notification_id = n.id
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
  return registrarDesfechoDaNotificacao(tx, { intentKey: params.intentKey, tipo: params.tipo,
    customerId: params.customerId, phoneMasked: params.phoneMasked,
    wamid: params.wamid ?? null, estado: 'sent', agora: params.enviadoEm });
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
     WHERE intent_key = ${intentKey} AND status = 'sending'
  `;
}

/** Falha definitiva antes de aceitação libera a vaga para uma tentativa futura. */
export async function liberarDisparoPromocional(
  tx: TransactionClient,
  intentKey: string,
): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM notification_send_intents
     WHERE intent_key = ${intentKey} AND status = 'sending'
  `;
}
