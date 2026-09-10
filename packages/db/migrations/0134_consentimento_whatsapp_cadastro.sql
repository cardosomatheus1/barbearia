-- O agendamento público não prova posse do telefone: registra intenção, nunca ativa marketing.
ALTER TABLE customer_consents ADD COLUMN text_snapshot text,
  ADD COLUMN verification_method text,
  ADD COLUMN requested_at timestamptz,
  ADD COLUMN requested_ip inet;
CREATE TABLE customer_marketing_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  appointment_id uuid NOT NULL REFERENCES appointments(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  text_version text NOT NULL,
  text_snapshot text NOT NULL,
  requested_ip inet,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX customer_marketing_requests_expiry ON customer_marketing_requests(tenant_id, expires_at);
CREATE INDEX customer_marketing_requests_customer ON customer_marketing_requests(customer_id);
ALTER TABLE customer_marketing_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_marketing_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_marketing_requests
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_marketing_requests TO barbearia_app;

-- FKs independentes aceitariam cliente e horário de pessoas diferentes.
CREATE FUNCTION customer_marketing_request_integridade() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.customer_id, NEW.appointment_id,
    NEW.token_hash, NEW.text_version, NEW.text_snapshot, NEW.requested_ip)
    IS DISTINCT FROM (OLD.tenant_id, OLD.customer_id, OLD.appointment_id,
    OLD.token_hash, OLD.text_version, OLD.text_snapshot, OLD.requested_ip)
  THEN RAISE EXCEPTION 'Origem e texto da intencao de aceite sao imutaveis'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.appointments a
    JOIN public.customers c ON c.id = a.customer_id AND c.tenant_id = a.tenant_id
    WHERE a.id = NEW.appointment_id AND a.customer_id = NEW.customer_id AND a.tenant_id = NEW.tenant_id)
  THEN RAISE EXCEPTION 'Intencao de aceite divergente do cliente ou da barbearia'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_marketing_request_integridade BEFORE INSERT OR UPDATE ON customer_marketing_requests
FOR EACH ROW EXECUTE FUNCTION customer_marketing_request_integridade();
REVOKE ALL ON FUNCTION customer_marketing_request_integridade() FROM PUBLIC;

CREATE FUNCTION customer_marketing_request_anonimizar() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.anonymized_at IS NOT NULL AND OLD.anonymized_at IS NULL THEN
    DELETE FROM public.customer_marketing_requests WHERE customer_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_marketing_request_anonimizar AFTER UPDATE OF anonymized_at ON customers
FOR EACH ROW EXECUTE FUNCTION customer_marketing_request_anonimizar();
REVOKE ALL ON FUNCTION customer_marketing_request_anonimizar() FROM PUBLIC;
