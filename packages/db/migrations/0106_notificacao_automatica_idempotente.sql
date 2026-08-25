-- Intenção de envio dos avisos automáticos que têm uma identidade natural.
--
-- `notifications` nasce depois do envio e portanto não cobre a janela em que a
-- Meta aceitou a mensagem mas a resposta se perdeu. Esta tabela nasce antes da
-- rede. Para lembretes/fila preferimos at-most-once: um estado `sending` que
-- sobrevive a crash é tratado como ambíguo e não é reenviado automaticamente.
CREATE TABLE IF NOT EXISTS notification_send_intents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  intent_key  varchar(180) NOT NULL,
  status      varchar(16) NOT NULL DEFAULT 'sending'
              CHECK (status IN ('sending', 'uncertain', 'sent')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, intent_key)
);

ALTER TABLE notification_send_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_send_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON notification_send_intents;
CREATE POLICY tenant_isolation ON notification_send_intents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
