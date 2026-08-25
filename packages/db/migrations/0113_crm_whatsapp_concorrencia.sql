-- 0113 — CRM/WhatsApp: cota promocional serializada e roteamento por WABA.
--
-- Campanha, automação e envio avulso compartilhavam as mesmas contagens, mas
-- não a mesma reserva. Duas transações podiam ler zero e ambas enviar. A tabela
-- de intenção já existia para avisos automáticos; as colunas abaixo a tornam
-- também o ledger de cota enquanto a chamada externa está em voo.
ALTER TABLE notification_send_intents
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS quota_at timestamptz,
  ADD COLUMN IF NOT EXISTS quota_date date,
  ADD COLUMN IF NOT EXISTS notification_id uuid REFERENCES notifications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS wamid text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notification_send_intents_cota_coerente'
       AND conrelid = 'notification_send_intents'::regclass
  ) THEN
    ALTER TABLE notification_send_intents
      ADD CONSTRAINT notification_send_intents_cota_coerente CHECK (
        (customer_id IS NULL AND quota_at IS NULL AND quota_date IS NULL)
        OR
        (customer_id IS NOT NULL AND quota_at IS NOT NULL AND quota_date IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS notification_send_intents_cota_cliente_idx
  ON notification_send_intents (customer_id, quota_at DESC)
  WHERE customer_id IS NOT NULL AND status IN ('sending', 'uncertain', 'sent');

-- Rede de segurança além do advisory lock: uma vaga promocional por dia local.
CREATE UNIQUE INDEX IF NOT EXISTS notification_send_intents_uma_promocao_dia
  ON notification_send_intents (tenant_id, customer_id, quota_date)
  WHERE customer_id IS NOT NULL AND status IN ('sending', 'uncertain', 'sent');

-- `entry.id` dos webhooks de ciclo de vida identifica a WABA, enquanto eventos
-- de mensagem trazem `phone_number_id`. A WABA pode rotear várias unidades, mas
-- pertence a um único tenant. `whatsapp_waba_owners` torna essa propriedade
-- declarativa: duas contas não conseguem registrar a mesma WABA nem em corrida.
CREATE TABLE IF NOT EXISTS whatsapp_waba_owners (
  waba_id    text PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE (waba_id, tenant_id)
);

ALTER TABLE whatsapp_waba_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_waba_owners FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_waba_owners_leitura ON whatsapp_waba_owners;
DROP POLICY IF EXISTS whatsapp_waba_owners_insercao ON whatsapp_waba_owners;
DROP POLICY IF EXISTS whatsapp_waba_owners_alteracao ON whatsapp_waba_owners;
DROP POLICY IF EXISTS whatsapp_waba_owners_remocao ON whatsapp_waba_owners;
CREATE POLICY whatsapp_waba_owners_leitura ON whatsapp_waba_owners FOR SELECT USING (true);
CREATE POLICY whatsapp_waba_owners_insercao ON whatsapp_waba_owners
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY whatsapp_waba_owners_alteracao ON whatsapp_waba_owners
  FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY whatsapp_waba_owners_remocao ON whatsapp_waba_owners
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_waba_owners TO barbearia_app;

CREATE TABLE IF NOT EXISTS whatsapp_wabas (
  waba_id      text NOT NULL,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  PRIMARY KEY (waba_id, location_id),
  FOREIGN KEY (waba_id, tenant_id)
    REFERENCES whatsapp_waba_owners(waba_id, tenant_id) ON DELETE CASCADE
);

ALTER TABLE whatsapp_wabas ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_wabas FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_wabas_leitura ON whatsapp_wabas;
DROP POLICY IF EXISTS whatsapp_wabas_insercao ON whatsapp_wabas;
DROP POLICY IF EXISTS whatsapp_wabas_alteracao ON whatsapp_wabas;
DROP POLICY IF EXISTS whatsapp_wabas_remocao ON whatsapp_wabas;

CREATE POLICY whatsapp_wabas_leitura ON whatsapp_wabas
  FOR SELECT USING (true);
CREATE POLICY whatsapp_wabas_insercao ON whatsapp_wabas
  FOR INSERT WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY whatsapp_wabas_alteracao ON whatsapp_wabas
  FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY whatsapp_wabas_remocao ON whatsapp_wabas
  FOR DELETE USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_wabas TO barbearia_app;

-- A antiga unicidade da automação usava dia UTC. A cota compartilhada acima
-- usa o dia local da unidade e cobre também campanha/avulso; manter as duas
-- criaria falsos conflitos perto da meia-noite local.
DROP INDEX IF EXISTS automation_sends_uma_por_dia;
CREATE INDEX IF NOT EXISTS automation_sends_por_cliente_dia_idx
  ON automation_sends (tenant_id, customer_id, sent_at DESC)
  WHERE sent_at IS NOT NULL;

-- Submissão/edição de template também cruza uma fronteira externa. Sem claim,
-- duas requisições do mesmo nome podem ambas decidir "criar" antes de a Meta
-- devolver o primeiro meta_id. `uncertain` conserva a dúvida após timeout e a
-- conciliação por nome é quem resolve se a Meta chegou a aceitar.
ALTER TABLE whatsapp_templates
  ADD COLUMN IF NOT EXISTS submission_state text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS submission_claim uuid,
  ADD COLUMN IF NOT EXISTS submission_updated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'whatsapp_templates_submission_state_valido'
       AND conrelid = 'whatsapp_templates'::regclass
  ) THEN
    ALTER TABLE whatsapp_templates
      ADD CONSTRAINT whatsapp_templates_submission_state_valido CHECK (
        submission_state IN ('idle', 'sending', 'uncertain')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'whatsapp_templates_submission_claim_coerente'
       AND conrelid = 'whatsapp_templates'::regclass
  ) THEN
    ALTER TABLE whatsapp_templates
      ADD CONSTRAINT whatsapp_templates_submission_claim_coerente CHECK (
        (submission_state = 'idle' AND submission_claim IS NULL)
        OR (submission_state IN ('sending', 'uncertain') AND submission_claim IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS whatsapp_templates_submission_pendente_idx
  ON whatsapp_templates (location_id, submission_updated_at)
  WHERE submission_state IN ('sending', 'uncertain');
