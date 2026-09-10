-- Canal explícito por unidade; a configuração Meta existente é preservada.
ALTER TABLE locations ADD CONSTRAINT locations_id_tenant UNIQUE (id, tenant_id);
CREATE TABLE whatsapp_channels (
  location_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transport text NOT NULL CHECK (transport IN ('meta', 'baileys')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, tenant_id) REFERENCES locations(id, tenant_id) ON DELETE RESTRICT
);

CREATE TABLE whatsapp_baileys_sessions (
  location_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  logout_generation uuid,
  desired boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'desconectado' CHECK (status IN
    ('desconectado', 'aguardando_qr', 'conectando', 'conectado', 'reconectando', 'novo_qr', 'erro')),
  pairing_until timestamptz,
  qr_cipher text,
  qr_until timestamptz,
  phone_e164 text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- Unicidade global sem expor a outra conta pela política de leitura.
  phone_hash text UNIQUE,
  owner_token uuid,
  lease_until timestamptz,
  retry_at timestamptz,
  next_send_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text CHECK (length(last_error) <= 80),
  connected_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, tenant_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES locations(id, tenant_id) ON DELETE RESTRICT,
  CHECK ((qr_cipher IS NULL) = (qr_until IS NULL)),
  CHECK ((owner_token IS NULL) = (lease_until IS NULL))
);

CREATE TABLE whatsapp_baileys_auth (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  generation uuid NOT NULL,
  record_type text NOT NULL CHECK (length(record_type) BETWEEN 1 AND 100),
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 512),
  cipher text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, generation, record_type, key_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES whatsapp_baileys_sessions(location_id, tenant_id) ON DELETE CASCADE
);

-- Registro mínimo de descoberta, como whatsapp_numbers: o worker encontra o
-- tenant antes de abrir withTenant. Não contém QR, telefone nem autenticação.
CREATE TABLE whatsapp_baileys_routes (
  location_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (location_id, tenant_id) REFERENCES whatsapp_baileys_sessions(location_id, tenant_id) ON DELETE CASCADE
);
ALTER TABLE whatsapp_baileys_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_baileys_routes FORCE ROW LEVEL SECURITY;
CREATE POLICY routes_leitura ON whatsapp_baileys_routes FOR SELECT USING (true);
CREATE POLICY routes_insercao ON whatsapp_baileys_routes FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY routes_remocao ON whatsapp_baileys_routes FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON whatsapp_baileys_routes TO barbearia_app;
CREATE FUNCTION whatsapp_baileys_route_sync() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.desired THEN
    INSERT INTO public.whatsapp_baileys_routes(location_id, tenant_id)
      VALUES(NEW.location_id, NEW.tenant_id) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.whatsapp_baileys_routes WHERE location_id = NEW.location_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_baileys_route_sync AFTER INSERT OR UPDATE OF desired ON whatsapp_baileys_sessions
FOR EACH ROW EXECUTE FUNCTION whatsapp_baileys_route_sync();
REVOKE ALL ON FUNCTION whatsapp_baileys_route_sync() FROM PUBLIC;

CREATE TABLE whatsapp_baileys_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  generation uuid NOT NULL,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  intent_key text NOT NULL CHECK (length(intent_key) BETWEEN 1 AND 200),
  message_id text NOT NULL UNIQUE CHECK (message_id ~ '^[A-Z0-9]{20,64}$'),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  payload_cipher text,
  redacted_at timestamptz,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'uncertain', 'sent', 'delivered', 'read', 'failed')),
  recipient_hash text,
  last_error text CHECK (length(last_error) <= 80),
  started_at timestamptz,
  accepted_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, intent_key, attempt),
  FOREIGN KEY (location_id, tenant_id) REFERENCES whatsapp_baileys_sessions(location_id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX whatsapp_baileys_outbox_queue ON whatsapp_baileys_outbox (location_id, created_at)
  WHERE status = 'queued';
CREATE INDEX whatsapp_baileys_outbox_uncertain ON whatsapp_baileys_outbox (location_id, started_at)
  WHERE status IN ('sending', 'uncertain');

CREATE FUNCTION whatsapp_baileys_outbox_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.location_id, NEW.generation, NEW.intent_key,
      NEW.attempt, NEW.message_id, NEW.payload_hash, NEW.created_at)
    IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.location_id, OLD.generation, OLD.intent_key,
      OLD.attempt, OLD.message_id, OLD.payload_hash, OLD.created_at)
  THEN RAISE EXCEPTION 'Intencao de mensagem e imutavel'; END IF;
  IF NEW.payload_cipher IS DISTINCT FROM OLD.payload_cipher AND
    (NEW.payload_cipher IS NOT NULL OR NEW.redacted_at IS NULL OR NEW.status IN ('queued','sending'))
  THEN RAISE EXCEPTION 'Conteudo so pode ser removido pela retencao'; END IF;
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id AND NEW.customer_id IS NOT NULL
  THEN RAISE EXCEPTION 'Destinatario nao pode ser alterado'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_baileys_outbox_immutable BEFORE UPDATE ON whatsapp_baileys_outbox
FOR EACH ROW EXECUTE FUNCTION whatsapp_baileys_outbox_immutable();
REVOKE ALL ON FUNCTION whatsapp_baileys_outbox_immutable() FROM PUBLIC;

-- Textos locais compartilham seleção e referência com campanhas. Nunca têm
-- aprovação Meta: disponibilidade local é uma coluna e regra próprias.
ALTER TABLE whatsapp_templates
  ADD COLUMN transport text NOT NULL DEFAULT 'meta' CHECK (transport IN ('meta', 'baileys')),
  ADD COLUMN local_enabled boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT whatsapp_templates_local_sem_meta CHECK
    (transport = 'meta' OR (status = 'rascunho' AND meta_id IS NULL AND submission_state <> 'sending'));
CREATE INDEX whatsapp_templates_local_kind ON whatsapp_templates (location_id, kind, created_at DESC)
  WHERE transport = 'baileys' AND local_enabled;

DO $$ DECLARE nome text; BEGIN
  FOREACH nome IN ARRAY ARRAY['whatsapp_channels', 'whatsapp_baileys_sessions', 'whatsapp_baileys_auth', 'whatsapp_baileys_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', nome);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', nome);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', nome);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO barbearia_app', nome);
  END LOOP;
  GRANT DELETE ON whatsapp_baileys_auth TO barbearia_app;
END $$;

-- A seleção usa a mesma disponibilidade em campanhas, automações e envio manual.
-- security_invoker mantém FORCE RLS do chamador nas tabelas subjacentes.
CREATE VIEW whatsapp_templates_disponiveis WITH (security_invoker = true) AS
SELECT t.* FROM whatsapp_templates t
LEFT JOIN whatsapp_channels c ON c.location_id = t.location_id
WHERE t.transport = COALESCE(c.transport, 'meta')
  AND ((t.transport = 'meta' AND t.status = 'aprovado')
    OR (t.transport = 'baileys' AND t.local_enabled));
GRANT SELECT ON whatsapp_templates_disponiveis TO barbearia_app;

CREATE INDEX whatsapp_baileys_outbox_retencao ON whatsapp_baileys_outbox(created_at) WHERE payload_cipher IS NOT NULL;
CREATE INDEX whatsapp_baileys_outbox_cliente ON whatsapp_baileys_outbox(customer_id) WHERE customer_id IS NOT NULL;
CREATE FUNCTION whatsapp_baileys_anonimizar_cliente() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.anonymized_at IS NOT NULL AND OLD.anonymized_at IS NULL THEN
    UPDATE public.whatsapp_baileys_outbox SET
      status = CASE WHEN status = 'queued' THEN 'failed' WHEN status = 'sending' THEN 'uncertain' ELSE status END,
      last_error = CASE WHEN status IN ('queued','sending') THEN 'cliente_anonimizado' ELSE last_error END,
      payload_cipher = NULL, customer_id = NULL, recipient_hash = NULL, redacted_at = now(), updated_at = now()
    WHERE customer_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_baileys_anonimizar_cliente AFTER UPDATE OF anonymized_at ON customers
FOR EACH ROW EXECUTE FUNCTION whatsapp_baileys_anonimizar_cliente();
REVOKE ALL ON FUNCTION whatsapp_baileys_anonimizar_cliente() FROM PUBLIC;

-- O registro original de resultado incerto permanece append-only. A confirmação
-- posterior é um novo fato ligado a ele; a intenção aponta para o fato vigente.
ALTER TABLE notifications ADD COLUMN previous_notification_id uuid REFERENCES notifications(id);
CREATE UNIQUE INDEX notifications_uma_correcao ON notifications(previous_notification_id)
  WHERE previous_notification_id IS NOT NULL;

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'aviso_clube';
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'nota_fiscal';
