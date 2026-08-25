-- Barberdock — Bloco 6: Platform / Jobs / Integrações (2026-08-25)
--
-- Invariantes de infraestrutura que precisam existir também no banco:
-- 1) uma entrega de webhook e seu endpoint pertencem ao mesmo tenant;
-- 2) resíduos históricos de jobs que já consumiram o teto não voltam a rodar;
-- 3) o desfecho persistido do PSP usa vocabulário fechado.

-- ---------------------------------------------------------------------------
-- Webhook de saída: tenant da entrega = tenant do endpoint.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_endpoints_tenant_id_id_key'
  ) THEN
    ALTER TABLE webhook_endpoints
      ADD CONSTRAINT webhook_endpoints_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM webhook_deliveries d
      JOIN webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.tenant_id <> e.tenant_id
  ) THEN
    RAISE EXCEPTION 'webhook_deliveries contém endpoint de outro tenant';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_deliveries_endpoint_do_tenant_fk'
  ) THEN
    ALTER TABLE webhook_deliveries
      ADD CONSTRAINT webhook_deliveries_endpoint_do_tenant_fk
  FOREIGN KEY (tenant_id, endpoint_id)
  REFERENCES webhook_endpoints (tenant_id, id)
  ON DELETE RESTRICT;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Fila: saneia o estado impossível que a versão antiga do reaper podia deixar.
-- ---------------------------------------------------------------------------
UPDATE jobs
   SET status = 'failed',
       last_error = COALESCE(last_error, 'max_attempts_exhausted'),
       finished_at = COALESCE(finished_at, now()),
       locked_at = NULL,
       locked_by = NULL,
       claim_token = NULL
 WHERE status IN ('pending', 'running')
   AND attempts >= max_attempts;

-- ---------------------------------------------------------------------------
-- PSP: o outcome é uma máquina de estados pequena, não texto livre.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'psp_events_outcome_valido'
  ) THEN
    ALTER TABLE psp_events
      ADD CONSTRAINT psp_events_outcome_valido
  CHECK (outcome IS NULL OR outcome IN ('paid', 'failed', 'ignored'));
  END IF;
END $$;
