-- ============================================================================
-- 0114 — prova estrutural do vínculo estável de combos.
-- ============================================================================
\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public'
       AND indexname='service_combos_um_por_servico_vendido'
  ) THEN
    RAISE EXCEPTION 'FALHOU: índice único do serviço vendido não existe';
  END IF;
  RAISE NOTICE 'OK 1 — combo vendável tem unicidade por serviço';
END $$;

INSERT INTO tenants (id, name)
VALUES ('11400000-0000-0000-0000-000000000001', 'Audit 0114');
INSERT INTO services
  (id, tenant_id, name, price_cents, duration_minutes)
VALUES
  ('11400000-1000-0000-0000-000000000001', '11400000-0000-0000-0000-000000000001', 'Combo Audit', 5000, 30),
  ('11400000-1000-0000-0000-000000000002', '11400000-0000-0000-0000-000000000001', 'Parte A', 3000, 15),
  ('11400000-1000-0000-0000-000000000003', '11400000-0000-0000-0000-000000000001', 'Parte B', 3000, 15);

INSERT INTO service_combos
  (id, tenant_id, name, declared_duration_minutes, sold_as_service_id)
VALUES
  ('11400000-2000-0000-0000-000000000001', '11400000-0000-0000-0000-000000000001',
   'Nome pode mudar', 30, '11400000-1000-0000-0000-000000000001');

DO $$
BEGIN
  BEGIN
    INSERT INTO service_combos
      (tenant_id, name, declared_duration_minutes, sold_as_service_id)
    VALUES
      ('11400000-0000-0000-0000-000000000001', 'Outro nome', 30,
       '11400000-1000-0000-0000-000000000001');
    RAISE EXCEPTION 'FALHOU: segundo combo foi ligado ao mesmo serviço vendido';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 2 — serviço vendido não aceita dois combos concorrentes';
  END;
END $$;

UPDATE services SET name='Combo Renomeado'
 WHERE id='11400000-1000-0000-0000-000000000001';
DO $$
DECLARE vinculo uuid;
BEGIN
  SELECT sold_as_service_id INTO vinculo
    FROM service_combos
   WHERE id='11400000-2000-0000-0000-000000000001';
  IF vinculo <> '11400000-1000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FALHOU: renomear serviço perdeu identidade do combo';
  END IF;
  RAISE NOTICE 'OK 3 — vínculo sobrevive a renomeação';
END $$;

ROLLBACK;
