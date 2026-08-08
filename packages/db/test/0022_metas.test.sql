-- ============================================================================
-- Invariantes da meta do profissional.
--
-- O que se prova aqui: que a meta é do mês (não da pessoa), que ela não repete
-- dentro do mesmo mês, e que a meta de uma barbearia não existe para a outra.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('22222222-0000-0000-0000-000000000001', 'Domari'),
  ('22222222-0000-0000-0000-000000000002', 'Rival');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('a2222222-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia');

INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
  ('b2222222-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', 'a2222222-0000-0000-0000-000000000001', 'Ruan', 'professional');

INSERT INTO professional_goals (tenant_id, professional_id, month, revenue_cents)
VALUES ('22222222-0000-0000-0000-000000000001', 'b2222222-0000-0000-0000-000000000001',
        '2026-09-01', 1500000);

DO $$
BEGIN
  -- Meta que se repete no mesmo mês significaria dois números para a mesma
  -- pergunta, e a tela escolheria um deles sem dizer qual.
  INSERT INTO professional_goals (tenant_id, professional_id, month, revenue_cents)
  VALUES ('22222222-0000-0000-0000-000000000001', 'b2222222-0000-0000-0000-000000000001',
          '2026-09-01', 2000000);
  RAISE EXCEPTION 'aceitou duas metas para o mesmo mês';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'OK 1 — uma meta por profissional e por mês';
END $$;

DO $$
BEGIN
  -- O mês é sempre o dia 1. Sem isto, '2026-09-15' e '2026-09-01' seriam metas
  -- diferentes do mesmo setembro, e o índice único não veria.
  INSERT INTO professional_goals (tenant_id, professional_id, month, revenue_cents)
  VALUES ('22222222-0000-0000-0000-000000000001', 'b2222222-0000-0000-0000-000000000001',
          '2026-10-15', 1500000);
  RAISE EXCEPTION 'aceitou meta ancorada no meio do mês';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 2 — o mês da meta é sempre o dia 1; o resto é o mesmo mês duas vezes';
END $$;

DO $$
BEGIN
  INSERT INTO professional_goals (tenant_id, professional_id, month, revenue_cents)
  VALUES ('22222222-0000-0000-0000-000000000001', 'b2222222-0000-0000-0000-000000000001',
          '2026-10-01', 0);
  RAISE EXCEPTION 'aceitou meta de zero';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 3 — meta zero é "sem meta", e sem meta é não ter linha';
END $$;

DO $$
DECLARE quantas integer;
BEGIN
  -- Meses diferentes convivem: é o histórico que dá sentido ao número.
  INSERT INTO professional_goals (tenant_id, professional_id, month, revenue_cents)
  VALUES ('22222222-0000-0000-0000-000000000001', 'b2222222-0000-0000-0000-000000000001',
          '2026-10-01', 1800000);
  SELECT count(*) INTO quantas FROM professional_goals
   WHERE professional_id = 'b2222222-0000-0000-0000-000000000001';
  IF quantas <> 2 THEN RAISE EXCEPTION 'o histórico de metas não acumulou'; END IF;
  RAISE NOTICE 'OK 4 — meses convivem; "bateu em 4 dos últimos 6" é uma frase, "a meta é X" não é';
END $$;

DO $$
DECLARE sobrou integer;
BEGIN
  -- Tirar o profissional do cadastro leva as metas dele junto: meta de cadeira
  -- que não existe mais não responde pergunta nenhuma.
  DELETE FROM professionals WHERE id = 'b2222222-0000-0000-0000-000000000001';
  SELECT count(*) INTO sobrou FROM professional_goals;
  IF sobrou <> 0 THEN RAISE EXCEPTION 'sobraram % meta(s) órfã(s)', sobrou; END IF;
  RAISE NOTICE 'OK 5 — apagar a cadeira apaga as metas dela';
END $$;

-- ----------------------------------------------------------------------------
-- A parede entre barbearias
-- ----------------------------------------------------------------------------

INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
  ('b2222222-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000001', 'a2222222-0000-0000-0000-000000000001', 'Gleidson', 'professional');
INSERT INTO professional_goals (tenant_id, professional_id, month, revenue_cents)
VALUES ('22222222-0000-0000-0000-000000000001', 'b2222222-0000-0000-0000-000000000002',
        '2026-09-01', 1200000);

SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '22222222-0000-0000-0000-000000000002', true);

DO $$
DECLARE quantas integer;
BEGIN
  SELECT count(*) INTO quantas FROM professional_goals;
  IF quantas <> 0 THEN
    RAISE EXCEPTION 'a rival leu % meta(s) da casa', quantas;
  END IF;
  RAISE NOTICE 'OK 6 — quanto o barbeiro da casa precisa faturar não é da conta da rival';
END $$;

DO $$
BEGIN
  /**
   * A chave estrangeira não protege: checagem de integridade referencial ignora
   * row security. Quem recusa é o `WITH CHECK` da política.
   */
  INSERT INTO professional_goals (tenant_id, professional_id, month, revenue_cents)
  VALUES ('22222222-0000-0000-0000-000000000001', 'b2222222-0000-0000-0000-000000000002',
          '2026-11-01', 1);
  RAISE EXCEPTION 'a rival gravou meta para um profissional da casa';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'OK 7 — WITH CHECK recusa a escrita com tenant alheio';
END $$;

RESET ROLE;

DO $$ BEGIN RAISE NOTICE '--- invariantes da meta do profissional passaram ---'; END $$;

ROLLBACK;
