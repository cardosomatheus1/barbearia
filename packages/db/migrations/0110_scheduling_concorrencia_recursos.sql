-- ============================================================================
-- 0110 — Concorrência e recursos no motor de agenda
--
-- 1) a mesma Idempotency-Key precisa representar a mesma intenção;
-- 2) um hold temporário consome também recursos compartilhados;
-- 3) quantity > 1 precisa sobreviver congelado no hold.
-- ============================================================================

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;

COMMENT ON COLUMN appointments.idempotency_fingerprint IS
  'SHA-256 da intenção associada à Idempotency-Key; impede reuso da chave com outro horário/serviço.';

CREATE TABLE IF NOT EXISTS slot_hold_resources (
  hold_id        uuid NOT NULL REFERENCES slot_holds(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource_type  text NOT NULL,
  quantity       smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (hold_id, resource_type),
  CONSTRAINT slot_hold_resources_quantity_positive CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS slot_hold_resources_type_idx
  ON slot_hold_resources (tenant_id, resource_type);

ALTER TABLE slot_hold_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE slot_hold_resources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON slot_hold_resources;
CREATE POLICY tenant_isolation ON slot_hold_resources
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON slot_hold_resources TO barbearia_app;
  END IF;
END $$;
