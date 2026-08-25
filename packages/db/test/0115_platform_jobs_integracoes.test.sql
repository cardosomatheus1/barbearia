-- ============================================================================
-- 0115 — Platform / Jobs / Integrações: webhook tenant, fila e PSP.
-- ============================================================================
\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'webhook_deliveries_endpoint_do_tenant_fk'
       AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'FALHOU: entrega de webhook não amarra tenant ao endpoint';
  END IF;
  RAISE NOTICE 'OK 1 — entrega e endpoint compartilham o mesmo tenant por FK';
END $$;

INSERT INTO tenants (id, name) VALUES
  ('11500000-0000-0000-0000-000000000001', 'Audit 0115 A'),
  ('11500000-0000-0000-0000-000000000002', 'Audit 0115 B');

-- O segredo é só material opaco de teste; a migration 0076 não exige formato
-- criptográfico no banco.
INSERT INTO webhook_endpoints (id, tenant_id, name, url, secret_cipher, events)
VALUES
  ('11500000-1000-0000-0000-000000000001', '11500000-0000-0000-0000-000000000001',
   'Audit endpoint', 'https://example.invalid/webhook', 'cipher', ARRAY['appointment.created']::webhook_event[]);

DO $$
BEGIN
  BEGIN
    INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event, payload)
    VALUES (
      '11500000-0000-0000-0000-000000000002',
      '11500000-1000-0000-0000-000000000001',
      'appointment.created', '{}'::jsonb
    );
    RAISE EXCEPTION 'FALHOU: entrega cross-tenant foi aceita';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'OK 2 — FK rejeita endpoint de outro tenant';
  END;
END $$;

INSERT INTO jobs (id, tenant_id, kind, status, attempts, max_attempts)
VALUES (
  '11500000-2000-0000-0000-000000000001',
  '11500000-0000-0000-0000-000000000001',
  'audit.exhausted', 'pending', 5, 5
);
-- A migration já saneou o legado anterior; esta linha posterior prova apenas
-- que o schema continua permitindo o estado transitório necessário ao teste do
-- reaper em código. O bloqueio do claim além do teto vive no domínio.

DO $$
BEGIN
  BEGIN
    INSERT INTO psp_events (event_id, type, payload, outcome)
    VALUES ('audit:0115:bad', 'charge.pending', '{}'::jsonb, 'inventado');
    RAISE EXCEPTION 'FALHOU: PSP aceitou outcome fora da máquina de estados';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3 — outcome do PSP é fechado';
  END;
END $$;

ROLLBACK;
