-- ============================================================================
-- Invariantes do preço por faixa de horário (bloco 68, SPEC §4.20).
--
-- O que o banco garante e a aplicação não pode desfazer: que a variação nasce
-- desligada, que duas faixas nunca valem no mesmo minuto, e que não existe
-- coluna onde um algoritmo escreva preço.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('68686868-0000-0000-0000-000000000001', 'Domari');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('68686868-1111-0000-0000-000000000001',
   '68686868-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia');

-- ----------------------------------------------------------------------------
-- 1 — a variação de preço nasce desligada, e o teto nasce no ±15% da SPEC
--
-- Regra que muda o que o cliente paga é a segunda coisa mais cara que este
-- produto faz, depois de recusar um cliente. Ligada por padrão, a barbearia
-- descobriria pelo cliente que reclamou do preço de sábado.
-- ----------------------------------------------------------------------------
DO $$
DECLARE ligado boolean; teto integer;
BEGIN
  SELECT dynamic_pricing_enabled INTO ligado
    FROM locations WHERE id = '68686868-1111-0000-0000-000000000001';
  SELECT max_price_variation_bps INTO teto
    FROM tenants WHERE id = '68686868-0000-0000-0000-000000000001';

  IF ligado THEN
    RAISE EXCEPTION 'a variação de preço nasceu ligada';
  END IF;
  IF teto IS DISTINCT FROM 1500 THEN
    RAISE EXCEPTION 'o teto padrão não é o ±15%% da SPEC: %', teto;
  END IF;
  RAISE NOTICE 'OK 1 — variação nasce desligada, teto nasce em 15%%';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — duas faixas não valem no mesmo minuto
--
-- Sem a constraint seria preciso inventar precedência entre regras de preço, e
-- regra de desempate sobre preço é como o cliente vê um valor na tela e outro
-- na hora de pagar.
-- ----------------------------------------------------------------------------
INSERT INTO pricing_rules (tenant_id, location_id, weekday, start_minute, end_minute, delta_bps)
VALUES ('68686868-0000-0000-0000-000000000001', '68686868-1111-0000-0000-000000000001',
        2, 780, 960, -1000);

DO $$
BEGIN
  BEGIN
    INSERT INTO pricing_rules (tenant_id, location_id, weekday, start_minute, end_minute, delta_bps)
    VALUES ('68686868-0000-0000-0000-000000000001', '68686868-1111-0000-0000-000000000001',
            2, 900, 1020, 500);
    RAISE EXCEPTION 'duas faixas se sobrepuseram no mesmo dia';
  EXCEPTION WHEN exclusion_violation THEN
    RAISE NOTICE 'OK 2 — faixa sobreposta recusada pelo banco';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — encostar não é sobrepor
--
-- `[início, fim)` semiaberto, como todo intervalo deste produto: uma faixa que
-- termina às 16h e outra que começa às 16h convivem.
-- ----------------------------------------------------------------------------
INSERT INTO pricing_rules (tenant_id, location_id, weekday, start_minute, end_minute, delta_bps)
VALUES ('68686868-0000-0000-0000-000000000001', '68686868-1111-0000-0000-000000000001',
        2, 960, 1140, 500);
DO $$ BEGIN RAISE NOTICE 'OK 3 — faixas encostadas convivem'; END $$;

-- ----------------------------------------------------------------------------
-- 4 — faixa sem efeito não entra
--
-- Uma regra de 0% é uma linha na tela que não faz nada, e o dono passa a
-- procurar por que o preço não mudou.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO pricing_rules (tenant_id, location_id, weekday, start_minute, end_minute, delta_bps)
    VALUES ('68686868-0000-0000-0000-000000000001', '68686868-1111-0000-0000-000000000001',
            4, 600, 720, 0);
    RAISE EXCEPTION 'faixa de 0%% foi aceita';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4 — faixa sem efeito recusada';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — não existe coluna onde um algoritmo escreva preço
--
-- *"A IA recomenda, o administrador aprova."* A recomendação é derivada da
-- ocupação medida e some quando deixa de ser verdade; uma tabela de sugestões
-- aprovadas sozinhas seria a autorização automática que a SPEC proíbe.
-- ----------------------------------------------------------------------------
DO $$
DECLARE achada text;
BEGIN
  SELECT c.table_name || '.' || c.column_name INTO achada
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND (c.column_name ~* '(sugerid|recomendad)'
          OR (c.table_name = 'pricing_rules' AND c.column_name ~* 'auto'))
   LIMIT 1;

  IF achada IS NOT NULL THEN
    RAISE EXCEPTION 'coluna de preço sugerido por algoritmo: %', achada;
  END IF;
  RAISE NOTICE 'OK 5 — nenhuma coluna guarda preço decidido por algoritmo';
END $$;

-- ----------------------------------------------------------------------------
-- 6 — RLS FORCE, com USING e WITH CHECK
-- ----------------------------------------------------------------------------
DO $$
DECLARE forcada boolean; usando integer; checando integer;
BEGIN
  SELECT relrowsecurity AND relforcerowsecurity INTO forcada
    FROM pg_class WHERE relname = 'pricing_rules';
  SELECT count(*) INTO usando FROM pg_policies
   WHERE tablename = 'pricing_rules' AND qual IS NOT NULL;
  SELECT count(*) INTO checando FROM pg_policies
   WHERE tablename = 'pricing_rules' AND with_check IS NOT NULL;

  IF NOT forcada THEN RAISE EXCEPTION 'pricing_rules sem RLS FORCE'; END IF;
  IF usando = 0 OR checando = 0 THEN
    RAISE EXCEPTION 'política sem USING ou sem WITH CHECK';
  END IF;
  RAISE NOTICE 'OK 6 — RLS FORCE com USING e WITH CHECK';
END $$;

ROLLBACK;
