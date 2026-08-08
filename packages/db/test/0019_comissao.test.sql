-- ============================================================================
-- Invariantes da comissão e do fechamento.
--
-- O que se prova aqui é do banco: a imutabilidade do que já foi fechado não
-- pode depender de a aplicação lembrar de conferir. É a comissão que o barbeiro
-- já recebeu — se ela puder mudar por um `UPDATE` distraído, a discussão de fim
-- de mês deixa de ter fonte.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

-- Ids próprios: as provas anteriores fazem commit e deixam as delas no banco.
INSERT INTO tenants (id, name) VALUES
  ('99999999-9999-9999-9999-999999999991', 'Domari'),
  ('99999999-9999-9999-9999-999999999992', 'Rival');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('aaaaaaaa-9999-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991', 'Matriz', 'America/Bahia'),
  ('aaaaaaaa-9999-0000-0000-000000000002', '99999999-9999-9999-9999-999999999992', 'Rival', 'America/Bahia');

INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
  ('bbbbbbbb-9999-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991', 'aaaaaaaa-9999-0000-0000-000000000001', 'Ruan', 'professional'),
  ('bbbbbbbb-9999-0000-0000-000000000002', '99999999-9999-9999-9999-999999999992', 'aaaaaaaa-9999-0000-0000-000000000002', 'Rival Pro', 'professional');

INSERT INTO service_categories (id, tenant_id, name) VALUES
  ('caca9999-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991', 'Cabelo');

INSERT INTO services (id, tenant_id, category_id, name, price_cents, duration_minutes) VALUES
  ('5e199999-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991',
   'caca9999-0000-0000-0000-000000000001', 'Corte', 5000, 30);

INSERT INTO orders (id, tenant_id, location_id) VALUES
  ('04de9999-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991',
   'aaaaaaaa-9999-0000-0000-000000000001');

INSERT INTO order_items (id, tenant_id, order_id, kind, description, unit_price_cents, professional_id) VALUES
  ('17e59999-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991',
   '04de9999-0000-0000-0000-000000000001', 'service', 'Corte', 5000,
   'bbbbbbbb-9999-0000-0000-000000000001');

-- ----------------------------------------------------------------------------
-- Regras
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  INSERT INTO commission_rules (tenant_id, mode, value)
  VALUES ('99999999-9999-9999-9999-999999999991', 'percent', 12000);
  RAISE EXCEPTION 'aceitou alíquota de 120%%';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 1 — alíquota acima de 100%% é recusada';
END $$;

DO $$
BEGIN
  INSERT INTO commission_rules (tenant_id, mode, value, tiers)
  VALUES ('99999999-9999-9999-9999-999999999991', 'tiers', 0, '[]'::jsonb);
  RAISE EXCEPTION 'aceitou faixas vazias';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 2 — modo por faixas exige pelo menos uma faixa';
END $$;

INSERT INTO commission_rules (id, tenant_id, mode, value)
VALUES ('4e6a9999-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991', 'percent', 4000);

DO $$
BEGIN
  -- A mesma combinação (geral, geral, geral) duas vezes: "a mais específica"
  -- empataria e o resultado dependeria da ordem da consulta.
  INSERT INTO commission_rules (tenant_id, mode, value)
  VALUES ('99999999-9999-9999-9999-999999999991', 'percent', 5000);
  RAISE EXCEPTION 'aceitou duas regras para a mesma combinação';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'OK 3 — nulo é valor de negócio: duas regras gerais não convivem';
END $$;

-- Combinação diferente convive sem problema.
INSERT INTO commission_rules (tenant_id, service_id, mode, value)
VALUES ('99999999-9999-9999-9999-999999999991', '5e199999-0000-0000-0000-000000000001', 'percent', 5000);
DO $$ BEGIN RAISE NOTICE 'OK 4 — regra por serviço convive com a geral'; END $$;

-- ----------------------------------------------------------------------------
-- Lançamentos
-- ----------------------------------------------------------------------------

INSERT INTO commission_entries
  (id, tenant_id, professional_id, order_id, order_item_id, earned_on, rule_id, mode, value, base_cents)
VALUES
  ('e17a9999-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991',
   'bbbbbbbb-9999-0000-0000-000000000001', '04de9999-0000-0000-0000-000000000001',
   '17e59999-0000-0000-0000-000000000001', DATE '2026-09-10',
   '4e6a9999-0000-0000-0000-000000000001', 'percent', 4000, 5000);

DO $$
BEGIN
  -- Fechar a mesma comanda duas vezes não pode pagar o corte duas vezes.
  INSERT INTO commission_entries
    (tenant_id, professional_id, order_item_id, earned_on, mode, value, base_cents)
  VALUES ('99999999-9999-9999-9999-999999999991', 'bbbbbbbb-9999-0000-0000-000000000001',
          '17e59999-0000-0000-0000-000000000001', DATE '2026-09-10', 'percent', 4000, 5000);
  RAISE EXCEPTION 'aceitou dois lançamentos positivos para o mesmo item';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'OK 5 — um lançamento positivo por item vendido';
END $$;

-- O estorno do mesmo item é outro lançamento, e é permitido.
INSERT INTO commission_entries
  (tenant_id, professional_id, order_item_id, earned_on, mode, value, base_cents, sign)
VALUES ('99999999-9999-9999-9999-999999999991', 'bbbbbbbb-9999-0000-0000-000000000001',
        '17e59999-0000-0000-0000-000000000001', DATE '2026-10-02', 'percent', 4000, 5000, -1);
DO $$ BEGIN RAISE NOTICE 'OK 6 — estorno é lançamento novo, com sinal negativo'; END $$;

DO $$
BEGIN
  INSERT INTO commission_entries
    (tenant_id, professional_id, order_item_id, earned_on, mode, value, base_cents, sign)
  VALUES ('99999999-9999-9999-9999-999999999991', 'bbbbbbbb-9999-0000-0000-000000000001',
          '17e59999-0000-0000-0000-000000000001', DATE '2026-10-03', 'percent', 4000, 5000, -1);
  RAISE EXCEPTION 'aceitou dois estornos do mesmo item';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'OK 7 — um estorno por item';
END $$;

DO $$
BEGIN
  INSERT INTO commission_entries
    (tenant_id, professional_id, earned_on, mode, value, base_cents, sign)
  VALUES ('99999999-9999-9999-9999-999999999991', 'bbbbbbbb-9999-0000-0000-000000000001',
          DATE '2026-09-10', 'percent', 4000, 5000, 0);
  RAISE EXCEPTION 'aceitou sinal zero';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 8 — sinal é 1 ou -1, nunca zero';
END $$;

DO $$
BEGIN
  INSERT INTO commission_entries
    (tenant_id, professional_id, earned_on, mode, value, base_cents)
  VALUES ('99999999-9999-9999-9999-999999999991', 'bbbbbbbb-9999-0000-0000-000000000001',
          DATE '2026-09-10', 'percent', 4000, -100);
  RAISE EXCEPTION 'aceitou base negativa';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 9 — base negativa não existe; o que inverte é o sinal';
END $$;

-- ----------------------------------------------------------------------------
-- Fechamento
-- ----------------------------------------------------------------------------

INSERT INTO commission_closures (id, tenant_id, starts_on, ends_on, closed_by_name)
VALUES ('c105e999-0000-0000-0000-000000000001', '99999999-9999-9999-9999-999999999991',
        DATE '2026-09-01', DATE '2026-09-30', 'Matheus');

DO $$
BEGIN
  INSERT INTO commission_closures (tenant_id, starts_on, ends_on, closed_by_name)
  VALUES ('99999999-9999-9999-9999-999999999991', DATE '2026-09-01', DATE '2026-09-30', 'Matheus');
  RAISE EXCEPTION 'aceitou fechar o mesmo período duas vezes';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'OK 10 — dois fechamentos do mesmo período pagariam o mês duas vezes';
END $$;

DO $$
BEGIN
  INSERT INTO commission_closures (tenant_id, starts_on, ends_on, closed_by_name)
  VALUES ('99999999-9999-9999-9999-999999999991', DATE '2026-09-30', DATE '2026-09-01', 'Matheus');
  RAISE EXCEPTION 'aceitou período invertido';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 11 — período com fim antes do início é recusado';
END $$;

INSERT INTO commission_closure_lines
  (tenant_id, closure_id, professional_id, professional_name, base_cents, amount_cents)
VALUES ('99999999-9999-9999-9999-999999999991', 'c105e999-0000-0000-0000-000000000001',
        'bbbbbbbb-9999-0000-0000-000000000001', 'Ruan', 5000, 2000);

DO $$
BEGIN
  INSERT INTO commission_closure_lines
    (tenant_id, closure_id, professional_id, professional_name, base_cents, amount_cents)
  VALUES ('99999999-9999-9999-9999-999999999991', 'c105e999-0000-0000-0000-000000000001',
          'bbbbbbbb-9999-0000-0000-000000000001', 'Ruan', 1, 1);
  RAISE EXCEPTION 'aceitou duas linhas para o mesmo profissional no mesmo fechamento';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'OK 12 — uma linha por profissional em cada fechamento';
END $$;

-- Carimba o lançamento como fechado.
UPDATE commission_entries
   SET closure_id = 'c105e999-0000-0000-0000-000000000001'
 WHERE id = 'e17a9999-0000-0000-0000-000000000001';
DO $$ BEGIN RAISE NOTICE 'OK 13 — o fechamento carimba o lançamento'; END $$;

DO $$
BEGIN
  -- A invariante central deste bloco: comissão fechada é comissão paga.
  UPDATE commission_entries SET base_cents = 999999
   WHERE id = 'e17a9999-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'deixou alterar lançamento já fechado';
EXCEPTION WHEN restrict_violation THEN
  RAISE NOTICE 'OK 14 — lançamento fechado não muda mais';
END $$;

DO $$
BEGIN
  -- Nem para descarimbar: reabrir por `UPDATE` seria o mesmo que alterar.
  UPDATE commission_entries SET closure_id = NULL
   WHERE id = 'e17a9999-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'deixou reabrir o lançamento';
EXCEPTION WHEN restrict_violation THEN
  RAISE NOTICE 'OK 15 — nem descarimbar é permitido';
END $$;

-- ----------------------------------------------------------------------------
-- A parede entre barbearias
-- ----------------------------------------------------------------------------

SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '99999999-9999-9999-9999-999999999992', true);

DO $$
DECLARE quantas integer;
BEGIN
  SELECT count(*) INTO quantas FROM commission_entries;
  IF quantas <> 0 THEN
    RAISE EXCEPTION 'a rival enxergou % lançamento(s) da casa', quantas;
  END IF;
  RAISE NOTICE 'OK 16 — lançamento de comissão de uma barbearia não existe para a outra';
END $$;

DO $$
DECLARE quantas integer;
BEGIN
  SELECT count(*) INTO quantas FROM commission_rules;
  IF quantas <> 0 THEN
    RAISE EXCEPTION 'a rival enxergou % regra(s) da casa', quantas;
  END IF;
  RAISE NOTICE 'OK 17 — regra de comissão também não atravessa';
END $$;

DO $$
BEGIN
  -- A chave estrangeira ignora RLS: sem conferir antes, a rival lançaria
  -- comissão apontando para o profissional da casa.
  INSERT INTO commission_entries
    (tenant_id, professional_id, earned_on, mode, value, base_cents)
  VALUES ('99999999-9999-9999-9999-999999999991', 'bbbbbbbb-9999-0000-0000-000000000001',
          DATE '2026-09-10', 'percent', 4000, 5000);
  RAISE EXCEPTION 'a rival gravou lançamento no tenant da casa';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'OK 18 — WITH CHECK impede gravar no tenant do vizinho';
END $$;

DO $$
BEGIN
  DELETE FROM commission_entries;
  RAISE EXCEPTION 'a aplicação conseguiu apagar lançamento de comissão';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'OK 19 — a aplicação não apaga lançamento: estorno é linha nova';
END $$;

RESET ROLE;

DO $$ BEGIN RAISE NOTICE '--- invariantes da comissão passaram ---'; END $$;

ROLLBACK;
