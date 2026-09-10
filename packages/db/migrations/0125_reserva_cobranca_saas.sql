-- A tentativa existe antes da rede. Timeout conserva identidade, valor e cartão.
-- Dados da plataforma: nenhum tenant pode ler ou escrever esta reserva.
ALTER TABLE invoices ADD CONSTRAINT invoices_id_tenant UNIQUE (id, tenant_id);
CREATE TABLE invoice_charge_attempts (
  invoice_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  psp_customer_id text NOT NULL CHECK (length(psp_customer_id) > 0),
  psp_method_id text NOT NULL CHECK (length(psp_method_id) > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'paid', 'refused')),
  charge_id text CHECK (length(charge_id) > 0),
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invoice_id, attempt),
  FOREIGN KEY (invoice_id, tenant_id) REFERENCES invoices(id, tenant_id) ON DELETE RESTRICT,
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (state <> 'paid' OR charge_id IS NOT NULL)
);
CREATE UNIQUE INDEX invoice_charge_attempts_active ON invoice_charge_attempts(invoice_id)
  WHERE state <> 'refused';
CREATE INDEX invoice_charge_attempts_tenant ON invoice_charge_attempts(tenant_id);
ALTER TABLE invoice_charge_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_charge_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_charge_attempts_platform ON invoice_charge_attempts FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON invoice_charge_attempts TO barbearia_app;
  END IF;
END $$;
