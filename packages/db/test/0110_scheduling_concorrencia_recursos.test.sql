-- ============================================================================
-- 0110 — fingerprint idempotente + recursos congelados em holds.
-- ============================================================================
\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

DO $$
DECLARE existe boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'appointments'
       AND column_name = 'idempotency_fingerprint'
  ) INTO existe;
  IF NOT existe THEN RAISE EXCEPTION 'FALHOU: appointments sem idempotency_fingerprint'; END IF;
  RAISE NOTICE 'OK 1 — fingerprint de idempotência existe no schema';
END $$;

INSERT INTO tenants (id, name) VALUES
  ('11000000-0000-0000-0000-000000000001', 'Audit 0110 A'),
  ('11000000-0000-0000-0000-000000000002', 'Audit 0110 B');
INSERT INTO locations (id, tenant_id, name) VALUES
  ('11000000-1000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'A'),
  ('11000000-1000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000002', 'B');
INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
  ('11000000-2000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '11000000-1000-0000-0000-000000000001', 'A'),
  ('11000000-2000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000002', '11000000-1000-0000-0000-000000000002', 'B');
INSERT INTO slot_holds (id, tenant_id, professional_id, starts_at, ends_at, expires_at) VALUES
  ('11000000-3000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '11000000-2000-0000-0000-000000000001', now(), now()+interval '30 min', now()+interval '10 min'),
  ('11000000-3000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000002', '11000000-2000-0000-0000-000000000002', now(), now()+interval '30 min', now()+interval '10 min');
INSERT INTO slot_hold_resources (hold_id, tenant_id, resource_type, quantity) VALUES
  ('11000000-3000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'maca', 2),
  ('11000000-3000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000002', 'maca', 1);

DO $$
BEGIN
  BEGIN
    INSERT INTO slot_hold_resources (hold_id, tenant_id, resource_type, quantity)
    VALUES ('11000000-3000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'invalido', 0);
    RAISE EXCEPTION 'FALHOU: quantity=0 foi aceita';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2 — hold exige quantity positiva';
  END;
END $$;

DO $$
DECLARE r record;
BEGIN
  SELECT relrowsecurity, relforcerowsecurity INTO r
    FROM pg_class WHERE oid = 'slot_hold_resources'::regclass;
  IF NOT r.relrowsecurity OR NOT r.relforcerowsecurity THEN
    RAISE EXCEPTION 'FALHOU: RLS/FORCE ausente em slot_hold_resources';
  END IF;
  RAISE NOTICE 'OK 3 — recursos do hold têm RLS forçada';
END $$;

SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '11000000-0000-0000-0000-000000000001', true);
DO $$
DECLARE meus int; rival int;
BEGIN
  SELECT count(*) INTO meus FROM slot_hold_resources;
  SELECT count(*) INTO rival FROM slot_hold_resources
   WHERE tenant_id = '11000000-0000-0000-0000-000000000002';
  IF meus <> 1 OR rival <> 0 THEN
    RAISE EXCEPTION 'FALHOU: isolamento do hold vazou (meus %, rival %)', meus, rival;
  END IF;
  RAISE NOTICE 'OK 4 — RLS isola recursos de hold por tenant';
END $$;

ROLLBACK;
