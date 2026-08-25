-- Mensagem avulsa: idempotência antes da rede.
--
-- `whatsapp_messages.wamid` deduplica webhooks depois que a Meta devolveu o id,
-- mas não protege o intervalo mais perigoso: a Meta aceita o envio e a resposta
-- se perde antes de o Barberdock receber o wamid. A intenção abaixo nasce antes
-- da chamada externa; enquanto estiver `enviando` ou `incerto`, outra chave para
-- o mesmo cliente+texto também é bloqueada. A escolha é deliberadamente
-- at-most-once: diante de ambiguidade, não mandar duas vezes é mais seguro do que
-- assumir que a primeira falhou.

CREATE TABLE IF NOT EXISTS whatsapp_manual_send_intents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  template_id       uuid REFERENCES whatsapp_templates(id) ON DELETE RESTRICT,
  kind              notification_kind NOT NULL,
  idempotency_key   varchar(128) NOT NULL,
  -- UUIDs + tipo; nenhum telefone/nome/texto pessoal entra nesta chave.
  intent_fingerprint text NOT NULL,
  status            text NOT NULL CHECK (status IN ('enviando', 'incerto', 'enviado')),
  wamid             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_manual_send_intent_enviado_tem_wamid CHECK (
    status <> 'enviado' OR (wamid IS NOT NULL AND length(btrim(wamid)) > 0)
  )
);

ALTER TABLE whatsapp_manual_send_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_manual_send_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON whatsapp_manual_send_intents;
CREATE POLICY tenant_isolation ON whatsapp_manual_send_intents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_manual_send_intents_idempotency_key
  ON whatsapp_manual_send_intents (tenant_id, location_id, idempotency_key);

-- Mesmo com refresh da ficha, uma chave nova não contorna um envio cujo
-- desfecho ainda é desconhecido.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_manual_send_intents_um_em_voo
  ON whatsapp_manual_send_intents (tenant_id, location_id, intent_fingerprint)
  WHERE status IN ('enviando', 'incerto');

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_manual_send_intents TO barbearia_app;
