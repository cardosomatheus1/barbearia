-- ============================================================================
-- Invariantes do que o score decide (bloco 60).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('63636363-0000-0000-0000-000000000001', 'Domari');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('63636363-1111-0000-0000-000000000001',
   '63636363-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('63636363-2222-0000-0000-000000000001',
   '63636363-0000-0000-0000-000000000001', 'Carlos Souza', '+5571988887777');

-- ----------------------------------------------------------------------------
-- 1 — recusar nasce desligado; beneficiar nasce ligado
--
-- A assimetria é a decisão do bloco. Recusar um cliente é a coisa mais cara que
-- este produto faz: ligado por padrão, a barbearia descobriria a regra pelo
-- cliente que ligou reclamando. Beneficiar ligado não surpreende ninguém mal.
-- ----------------------------------------------------------------------------
DO $$
DECLARE bloqueio smallint; confiavel smallint;
BEGIN
  SELECT online_block_score, waitlist_trusted_score INTO bloqueio, confiavel
    FROM locations WHERE id = '63636363-1111-0000-0000-000000000001';

  IF bloqueio IS NOT NULL THEN
    RAISE EXCEPTION 'a recusa online nasceu ligada, em %', bloqueio;
  END IF;
  IF confiavel IS DISTINCT FROM 85 THEN
    RAISE EXCEPTION 'o limiar de confiança não é o 85 da SPEC: %', confiavel;
  END IF;
  RAISE NOTICE 'OK 1 — recusar nasce desligado, beneficiar nasce no 85';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — os dois limiares vivem na escala do score, e só nela
--
-- Um limiar fora de 0..100 não significa nada: acima de 100 recusa todo mundo
-- inclusive o cliente perfeito, abaixo de 0 não recusa ninguém e parece ligado.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE locations SET online_block_score = 101
     WHERE id = '63636363-1111-0000-0000-000000000001';
    RAISE EXCEPTION 'limiar fora da escala foi aceito';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2a — limiar de recusa fora de 0..100 é recusado';
  END;

  BEGIN
    UPDATE locations SET waitlist_trusted_score = 200
     WHERE id = '63636363-1111-0000-0000-000000000001';
    RAISE EXCEPTION 'limiar de confiança fora da escala foi aceito';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2b — limiar de confiança fora de 0..100 é recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — a recusa registrada guarda o score **e** o limiar que valia
--
-- Sem o limiar, a linha não explica a si mesma: o dono muda o número no mês
-- seguinte e a lista passa a mostrar recusas que, pelo valor de hoje, não teriam
-- acontecido.
-- ----------------------------------------------------------------------------
DO $$
DECLARE colunas int;
BEGIN
  SELECT count(*) INTO colunas FROM information_schema.columns
   WHERE table_name = 'online_blocks' AND column_name IN ('score', 'threshold', 'wanted_at');
  IF colunas <> 3 THEN
    RAISE EXCEPTION 'a recusa não guarda score, limiar e horário pedido';
  END IF;

  BEGIN
    INSERT INTO online_blocks (tenant_id, location_id, customer_id, score, threshold, wanted_at)
    VALUES ('63636363-0000-0000-0000-000000000001',
            '63636363-1111-0000-0000-000000000001',
            '63636363-2222-0000-0000-000000000001', 150, 40, now());
    RAISE EXCEPTION 'score fora da escala foi aceito no registro';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3 — a recusa guarda score e limiar, os dois na escala';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — a unidade da recusa não some, e o cliente pode sumir
--
-- `RESTRICT` na unidade: a lista é o único jeito de medir a regra, e apagar a
-- loja levaria o histórico dela junto. `SET NULL` no cliente porque
-- `anonimizar_cliente` precisa poder passar — o direito do titular vence a
-- estatística, e a linha continua contando sem o nome.
-- ----------------------------------------------------------------------------
DO $$
DECLARE unidade "char"; cliente "char";
BEGIN
  SELECT c.confdeltype INTO unidade FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE t.relname = 'online_blocks' AND c.contype = 'f' AND a.attname = 'location_id';

  SELECT c.confdeltype INTO cliente FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE t.relname = 'online_blocks' AND c.contype = 'f' AND a.attname = 'customer_id';

  IF unidade IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION 'a unidade da recusa não é RESTRICT: %', unidade;
  END IF;
  IF cliente IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION 'o cliente da recusa não é SET NULL: %', cliente;
  END IF;
  RAISE NOTICE 'OK 4 — a loja não some, e o cliente pode ser anonimizado';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — a RLS separa as barbearias também aqui
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.relname = 'online_blocks' AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'online_blocks sem RLS FORCE';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies p
     WHERE p.tablename = 'online_blocks' AND (p.qual IS NULL OR p.with_check IS NULL)
  ) THEN
    RAISE EXCEPTION 'política sem USING e WITH CHECK';
  END IF;
  RAISE NOTICE 'OK 5 — RLS FORCE com USING e WITH CHECK';
END $$;

ROLLBACK;
