-- Emissor próprio: credenciais cifradas, reserva de DPS e documentos sob RLS.
-- O XML original tem finalidade de guarda fiscal; não é refeito pelo cadastro vivo.
ALTER TABLE fiscal_settings ADD CONSTRAINT fiscal_settings_unidade_tenant UNIQUE (location_id, tenant_id);
ALTER TABLE fiscal_invoices ADD CONSTRAINT fiscal_invoices_id_unidade_tenant UNIQUE (id, location_id, tenant_id);

CREATE TABLE fiscal_native_settings (
  location_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('homologacao', 'producao')),
  series integer NOT NULL CHECK (series BETWEEN 1 AND 49999),
  national_service_code text NOT NULL CHECK (national_service_code ~ '^[0-9]{6}$'),
  municipal_service_code text CHECK (municipal_service_code ~ '^[0-9]{3}$'),
  nbs text CHECK (nbs ~ '^[0-9]{9}$'),
  simples_total_bps integer CHECK (simples_total_bps BETWEEN 0 AND 9999),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, tenant_id) REFERENCES fiscal_settings(location_id, tenant_id) ON DELETE RESTRICT
);

CREATE TABLE fiscal_certificates (
  location_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cnpj text NOT NULL CHECK (cnpj ~ '^[0-9]{14}$'),
  envelope_cipher text NOT NULL,
  fingerprint text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL CHECK (valid_until > valid_from),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (location_id, tenant_id) REFERENCES fiscal_settings(location_id, tenant_id) ON DELETE RESTRICT
);

CREATE TABLE fiscal_dps_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cnpj text NOT NULL CHECK (cnpj ~ '^[0-9]{14}$'),
  municipality_ibge text NOT NULL CHECK (municipality_ibge ~ '^[0-9]{7}$'),
  environment text NOT NULL CHECK (environment IN ('homologacao', 'producao')),
  series integer NOT NULL CHECK (series BETWEEN 1 AND 49999),
  last_number bigint NOT NULL CHECK (last_number BETWEEN 1 AND 999999999999999),
  -- A identidade perante o fisco é do CNPJ, inclusive entre duas unidades.
  PRIMARY KEY (cnpj, municipality_ibge, environment, series)
);

CREATE TABLE fiscal_native_documents (
  invoice_id uuid PRIMARY KEY,
  location_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('homologacao', 'producao')),
  dps_id text NOT NULL CHECK (dps_id ~ '^DPS[0-9]{42}$'),
  snapshot_cipher text NOT NULL,
  signed_dps_cipher text,
  nfse_cipher text,
  pdf_cipher text,
  access_key text CHECK (access_key ~ '^[0-9]{50}$'),
  cancel_request_cipher text,
  cancel_event_cipher text,
  cancel_error_code text CHECK (length(cancel_error_code) <= 80),
  lease_token uuid,
  lease_until timestamptz,
  attempt_at timestamptz,
  last_error_code text CHECK (length(last_error_code) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment, dps_id),
  UNIQUE (environment, access_key),
  FOREIGN KEY (invoice_id, location_id, tenant_id)
    REFERENCES fiscal_invoices(id, location_id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX fiscal_native_documents_location ON fiscal_native_documents (location_id, created_at DESC);

CREATE FUNCTION fiscal_native_document_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.invoice_id, NEW.location_id, NEW.tenant_id, NEW.environment, NEW.dps_id, NEW.snapshot_cipher, NEW.created_at)
     IS DISTINCT FROM
     (OLD.invoice_id, OLD.location_id, OLD.tenant_id, OLD.environment, OLD.dps_id, OLD.snapshot_cipher, OLD.created_at)
     OR (OLD.signed_dps_cipher IS NOT NULL AND NEW.signed_dps_cipher IS DISTINCT FROM OLD.signed_dps_cipher)
     OR (OLD.access_key IS NOT NULL AND NEW.access_key IS DISTINCT FROM OLD.access_key)
     OR (OLD.nfse_cipher IS NOT NULL AND NEW.nfse_cipher IS DISTINCT FROM OLD.nfse_cipher)
     OR (OLD.pdf_cipher IS NOT NULL AND NEW.pdf_cipher IS DISTINCT FROM OLD.pdf_cipher)
     OR (OLD.cancel_request_cipher IS NOT NULL AND OLD.cancel_error_code IS NULL
         AND NEW.cancel_request_cipher IS DISTINCT FROM OLD.cancel_request_cipher)
     OR (OLD.cancel_event_cipher IS NOT NULL AND NEW.cancel_event_cipher IS DISTINCT FROM OLD.cancel_event_cipher)
  THEN RAISE EXCEPTION 'Documento fiscal persistido e imutavel'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_native_document_immutable BEFORE UPDATE ON fiscal_native_documents
FOR EACH ROW EXECUTE FUNCTION fiscal_native_document_immutable();
REVOKE ALL ON FUNCTION fiscal_native_document_immutable() FROM PUBLIC;

DO $$ DECLARE nome text; BEGIN
  FOREACH nome IN ARRAY ARRAY['fiscal_native_settings', 'fiscal_certificates', 'fiscal_dps_counters', 'fiscal_native_documents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', nome);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', nome);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', nome);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO barbearia_app', nome);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT DELETE ON fiscal_certificates TO barbearia_app;
  END IF;
END $$;
