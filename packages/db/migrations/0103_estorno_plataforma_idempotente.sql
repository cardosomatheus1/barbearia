/**
 * Idempotência da ação administrativa de estorno.
 *
 * A resposta do adquirente pode se perder e deixar o lançamento `pending`.
 * Sem uma chave da requisição, o operador que clica de novo cria outro refund,
 * debita o crédito outra vez e usa outro `estornoId` na Stripe — ou seja, a
 * retentativa vira uma segunda devolução legítima para o adquirente.
 */
ALTER TABLE refunds ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX refunds_idempotencia_idx
  ON refunds (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
