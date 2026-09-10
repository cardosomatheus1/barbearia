-- Emissores municipais reutilizados: escolha por unidade e arquivo fiscal isolado.
ALTER TABLE fiscal_settings ADD COLUMN native_emitter text NOT NULL DEFAULT 'nacional'
  CHECK (native_emitter IN ('nacional', 'municipal'));

CREATE TABLE fiscal_municipal_settings (
  location_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
  credentials_cipher text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, tenant_id) REFERENCES fiscal_settings(location_id, tenant_id) ON DELETE RESTRICT
);
CREATE TABLE fiscal_rps_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cnpj text NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  municipality_ibge text NOT NULL CHECK (municipality_ibge ~ '^[0-9]{7}$'),
  environment text NOT NULL CHECK (environment IN ('homologacao', 'producao')),
  series text NOT NULL CHECK (series ~ '^[a-zA-Z0-9]{1,5}$'),
  last_number integer NOT NULL CHECK (last_number > 0),
  PRIMARY KEY (cnpj, municipality_ibge, environment, series)
);
CREATE TABLE fiscal_municipal_documents (
  invoice_id uuid PRIMARY KEY,
  location_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('homologacao', 'producao')),
  snapshot_cipher text NOT NULL,
  request_cipher text,
  response_cipher text,
  initial_response_cipher text,
  rejection_codes text[],
  nfse_cipher text,
  number text CHECK (length(number) <= 100),
  verification_code text CHECK (length(verification_code) <= 100),
  protocol text CHECK (length(protocol) <= 100),
  batch_number integer,
  cancel_request_cipher text,
  cancel_event_cipher text,
  cancel_error_code text CHECK (length(cancel_error_code) <= 80),
  lease_token uuid,
  lease_until timestamptz,
  attempt_at timestamptz,
  last_error_code text CHECK (length(last_error_code) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (invoice_id, location_id, tenant_id)
    REFERENCES fiscal_invoices(id, location_id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX fiscal_municipal_documents_location ON fiscal_municipal_documents (location_id, created_at DESC);

CREATE TABLE fiscal_municipal_exchanges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('emitir', 'consultar', 'cancelar', 'preparar_cancelamento')),
  payload_cipher text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (invoice_id, location_id, tenant_id)
    REFERENCES fiscal_invoices(id, location_id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX fiscal_municipal_exchanges_invoice ON fiscal_municipal_exchanges (invoice_id, created_at);

CREATE FUNCTION fiscal_municipal_document_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.invoice_id, NEW.location_id, NEW.tenant_id, NEW.environment, NEW.snapshot_cipher, NEW.created_at)
     IS DISTINCT FROM (OLD.invoice_id, OLD.location_id, OLD.tenant_id, OLD.environment, OLD.snapshot_cipher, OLD.created_at)
     OR (OLD.nfse_cipher IS NOT NULL AND NEW.nfse_cipher IS DISTINCT FROM OLD.nfse_cipher)
     OR (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number)
     OR (OLD.verification_code IS NOT NULL AND NEW.verification_code IS DISTINCT FROM OLD.verification_code)
     OR (OLD.cancel_event_cipher IS NOT NULL AND NEW.cancel_event_cipher IS DISTINCT FROM OLD.cancel_event_cipher)
     OR (OLD.request_cipher IS NOT NULL AND NEW.request_cipher IS DISTINCT FROM OLD.request_cipher)
     OR (OLD.attempt_at IS NOT NULL AND NEW.attempt_at IS DISTINCT FROM OLD.attempt_at)
     OR (OLD.initial_response_cipher IS NOT NULL AND NEW.initial_response_cipher IS DISTINCT FROM OLD.initial_response_cipher)
     OR (OLD.rejection_codes IS NOT NULL AND NEW.rejection_codes IS DISTINCT FROM OLD.rejection_codes)
     OR (OLD.protocol IS NOT NULL AND NEW.protocol IS DISTINCT FROM OLD.protocol)
     OR (OLD.batch_number IS NOT NULL AND NEW.batch_number IS DISTINCT FROM OLD.batch_number)
     OR (OLD.cancel_request_cipher IS NOT NULL AND OLD.cancel_error_code IS NULL
         AND NEW.cancel_request_cipher IS DISTINCT FROM OLD.cancel_request_cipher)
  THEN RAISE EXCEPTION 'Documento municipal persistido e imutavel'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_municipal_document_immutable BEFORE UPDATE ON fiscal_municipal_documents
FOR EACH ROW EXECUTE FUNCTION fiscal_municipal_document_immutable();
REVOKE ALL ON FUNCTION fiscal_municipal_document_immutable() FROM PUBLIC;

DO $$ DECLARE nome text; BEGIN
  FOREACH nome IN ARRAY ARRAY['fiscal_municipal_settings', 'fiscal_rps_counters', 'fiscal_municipal_documents', 'fiscal_municipal_exchanges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', nome);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', nome);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', nome);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
      EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM barbearia_app', nome);
      IF nome = 'fiscal_municipal_exchanges' THEN
        -- Default privileges do schema podem conceder UPDATE a tabelas novas.
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM barbearia_app', nome);
        EXECUTE format('GRANT SELECT, INSERT ON %I TO barbearia_app', nome);
      ELSE
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO barbearia_app', nome);
      END IF;
    END IF;
  END LOOP;
END $$;
