-- ============================================================================
-- 0116 — Recheck final: plano e motivo de bloqueio são da plataforma.
-- ============================================================================
\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;
BEGIN;

INSERT INTO tenants (id, name)
VALUES ('11600000-0000-0000-0000-000000000001', 'Audit 0116');

INSERT INTO plans (id, code, name, price_cents, max_chairs)
VALUES
  ('11600000-1000-0000-0000-000000000001', 'audit_0116_a', 'Audit A', 1000, 2),
  ('11600000-1000-0000-0000-000000000002', 'audit_0116_b', 'Audit B', 2000, 4);

-- A plataforma, sem tenant no GUC, continua podendo manter os próprios termos.
SELECT set_config('app.tenant_id', '', true);
UPDATE tenant_platform
   SET plan_id = '11600000-1000-0000-0000-000000000001',
       blocked_at = now(), blocked_reason = 'auditoria'
 WHERE tenant_id = '11600000-0000-0000-0000-000000000001';

-- Em contexto de barbearia, trocar o próprio plano não pode contornar o fluxo
-- de assinatura/rateio.
SELECT set_config('app.tenant_id', '11600000-0000-0000-0000-000000000001', true);
DO $$
BEGIN
  BEGIN
    UPDATE tenant_platform
       SET plan_id = '11600000-1000-0000-0000-000000000002'
     WHERE tenant_id = '11600000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'FALHOU: tenant alterou o próprio plan_id';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 1 — tenant não altera plan_id';
  END;
END $$;

DO $$
BEGIN
  BEGIN
    UPDATE tenant_platform
       SET blocked_reason = 'motivo reescrito pelo tenant'
     WHERE tenant_id = '11600000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'FALHOU: tenant alterou o motivo do próprio bloqueio';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 2 — tenant não altera blocked_reason';
  END;
END $$;

ROLLBACK;
