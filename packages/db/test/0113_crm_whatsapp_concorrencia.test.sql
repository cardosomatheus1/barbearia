-- ============================================================================
-- 0113 — CRM/WhatsApp: cota promocional, WABA e claim de template.
-- ============================================================================
\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

DO $$
DECLARE faltam int;
BEGIN
  SELECT count(*) INTO faltam
    FROM (VALUES ('customer_id'), ('quota_at'), ('quota_date'), ('notification_id'), ('wamid')) v(col)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name='notification_send_intents'
        AND c.column_name=v.col
   );
  IF faltam <> 0 THEN RAISE EXCEPTION 'FALHOU: faltam colunas de cota no ledger'; END IF;
  RAISE NOTICE 'OK 1 — intenção de notificação carrega reserva de cota';
END $$;

DO $$
DECLARE faltam int;
BEGIN
  SELECT count(*) INTO faltam
    FROM (VALUES ('submission_state'), ('submission_claim'), ('submission_updated_at')) v(col)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name='whatsapp_templates'
        AND c.column_name=v.col
   );
  IF faltam <> 0 THEN RAISE EXCEPTION 'FALHOU: faltam colunas do claim de template'; END IF;
  RAISE NOTICE 'OK 2 — template possui claim persistente de submissão';
END $$;

DO $$
DECLARE r record;
BEGIN
  SELECT relrowsecurity, relforcerowsecurity INTO r
    FROM pg_class WHERE oid='whatsapp_wabas'::regclass;
  IF NOT r.relrowsecurity OR NOT r.relforcerowsecurity THEN
    RAISE EXCEPTION 'FALHOU: whatsapp_wabas sem RLS/FORCE';
  END IF;
  SELECT relrowsecurity, relforcerowsecurity INTO r
    FROM pg_class WHERE oid='whatsapp_waba_owners'::regclass;
  IF NOT r.relrowsecurity OR NOT r.relforcerowsecurity THEN
    RAISE EXCEPTION 'FALHOU: whatsapp_waba_owners sem RLS/FORCE';
  END IF;
  RAISE NOTICE 'OK 3 — roteamento WABA tem RLS forçada';
END $$;

INSERT INTO tenants (id, name) VALUES
  ('11300000-0000-0000-0000-000000000001', 'Audit 0113 A'),
  ('11300000-0000-0000-0000-000000000002', 'Audit 0113 B');
INSERT INTO locations (id, tenant_id, name) VALUES
  ('11300000-1000-0000-0000-000000000001', '11300000-0000-0000-0000-000000000001', 'A'),
  ('11300000-1000-0000-0000-000000000002', '11300000-0000-0000-0000-000000000002', 'B');
INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('11300000-2000-0000-0000-000000000001', '11300000-0000-0000-0000-000000000001', 'Cliente A', '+5511999990001');

INSERT INTO whatsapp_waba_owners (waba_id, tenant_id)
VALUES ('waba-audit-0113', '11300000-0000-0000-0000-000000000001');
INSERT INTO whatsapp_wabas (waba_id, tenant_id, location_id)
VALUES ('waba-audit-0113', '11300000-0000-0000-0000-000000000001',
        '11300000-1000-0000-0000-000000000001');

DO $$
BEGIN
  BEGIN
    INSERT INTO whatsapp_waba_owners (waba_id, tenant_id)
    VALUES ('waba-audit-0113', '11300000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'FALHOU: mesma WABA aceitou dois tenants';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 4 — uma WABA pertence a exatamente um tenant';
  END;
END $$;

-- A identidade herdada da 0106 é composta: a mesma intent_key pode existir em
-- tenants diferentes, mas nunca duas vezes no mesmo tenant.
INSERT INTO notification_send_intents (tenant_id, intent_key, status)
VALUES
  ('11300000-0000-0000-0000-000000000001', 'audit:0113:shared', 'sending'),
  ('11300000-0000-0000-0000-000000000002', 'audit:0113:shared', 'sending');
DO $$
BEGIN
  BEGIN
    INSERT INTO notification_send_intents (tenant_id, intent_key, status)
    VALUES ('11300000-0000-0000-0000-000000000001', 'audit:0113:shared', 'sending');
    RAISE EXCEPTION 'FALHOU: intent_key duplicada foi aceita no mesmo tenant';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 5 — intent_key mantém cardinalidade por tenant da migração 0106';
  END;
END $$;

INSERT INTO notification_send_intents
  (tenant_id, intent_key, status, customer_id, quota_at, quota_date)
VALUES
  ('11300000-0000-0000-0000-000000000001', 'audit:0113:a', 'sending',
   '11300000-2000-0000-0000-000000000001', now(), current_date);
DO $$
BEGIN
  BEGIN
    INSERT INTO notification_send_intents
      (tenant_id, intent_key, status, customer_id, quota_at, quota_date)
    VALUES
      ('11300000-0000-0000-0000-000000000001', 'audit:0113:b', 'sending',
       '11300000-2000-0000-0000-000000000001', now(), current_date);
    RAISE EXCEPTION 'FALHOU: segunda reserva promocional do dia foi aceita';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 6 — índice fecha segunda reserva promocional do mesmo dia';
  END;
END $$;

SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '11300000-0000-0000-0000-000000000002', true);
DO $$
DECLARE rotas int;
BEGIN
  -- Leitura pré-tenant é pública de propósito e contém somente ids opacos.
  SELECT count(*) INTO rotas FROM whatsapp_wabas WHERE waba_id='waba-audit-0113';
  IF rotas <> 1 THEN RAISE EXCEPTION 'FALHOU: roteamento WABA não é legível'; END IF;

  BEGIN
    INSERT INTO whatsapp_wabas (waba_id, tenant_id, location_id)
    VALUES ('waba-audit-0113', '11300000-0000-0000-0000-000000000002',
            '11300000-1000-0000-0000-000000000002');
    RAISE EXCEPTION 'FALHOU: tenant rival anexou unidade à WABA alheia';
  EXCEPTION WHEN foreign_key_violation OR insufficient_privilege OR check_violation THEN
    RAISE NOTICE 'OK 7 — escrita rival não consegue anexar localização à WABA alheia';
  END;
END $$;

ROLLBACK;
