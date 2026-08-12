-- ============================================================================
-- Invariantes da multiunidade (bloco 58).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('61616161-0000-0000-0000-000000000001', 'Domari'),
  ('61616161-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('61616161-1111-0000-0000-000000000001',
   '61616161-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia'),
  ('61616161-1111-0000-0000-000000000002',
   '61616161-0000-0000-0000-000000000001', 'Filial', 'America/Bahia'),
  ('61616161-1111-0000-0000-000000000009',
   '61616161-0000-0000-0000-000000000002', 'Deles', 'America/Bahia');

INSERT INTO products (id, tenant_id, name, kind, cost_cents, price_cents, unit)
VALUES ('61616161-2222-0000-0000-000000000001',
        '61616161-0000-0000-0000-000000000001', 'Pomada', 'resale', 1200, 3900, 'un');

-- ----------------------------------------------------------------------------
-- 1 — da loja para ela mesma não é transferência
--
-- Aceitar produziria dois movimentos que se anulam e um caminho para "acertar"
-- saldo sem passar pelo `ajuste`, que exige motivo escrito desde o bloco 47.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO stock_transfers
      (tenant_id, product_id, from_location_id, to_location_id, quantity,
       unit_cost_cents, created_by_name)
    VALUES ('61616161-0000-0000-0000-000000000001',
            '61616161-2222-0000-0000-000000000001',
            '61616161-1111-0000-0000-000000000001',
            '61616161-1111-0000-0000-000000000001', 3, 1200, 'Ruan');
    RAISE EXCEPTION 'transferência da loja para ela mesma foi aceita';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1 — origem igual ao destino é recusada';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — quantidade tem que ser positiva
--
-- Quantidade negativa inverteria o sentido sem inverter as pontas: a linha diria
-- "da matriz para a filial" e o estoque andaria ao contrário.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO stock_transfers
      (tenant_id, product_id, from_location_id, to_location_id, quantity,
       unit_cost_cents, created_by_name)
    VALUES ('61616161-0000-0000-0000-000000000001',
            '61616161-2222-0000-0000-000000000001',
            '61616161-1111-0000-0000-000000000001',
            '61616161-1111-0000-0000-000000000002', 0, 1200, 'Ruan');
    RAISE EXCEPTION 'transferência de zero foi aceita';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2 — quantidade não positiva é recusada';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — a transferência não se desfaz
--
-- `REVOKE DELETE` pela mesma razão do movimento de estoque, que ela cria dois:
-- uma transferência apagada deixaria os dois movimentos órfãos e o saldo das
-- duas lojas sem explicação. Corrigir é lançar `ajuste` com motivo escrito.
-- ----------------------------------------------------------------------------
DO $$
DECLARE pode boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    SELECT has_table_privilege('barbearia_app', 'stock_transfers', 'DELETE') INTO pode;
    IF pode THEN
      RAISE EXCEPTION 'a aplicação pode apagar transferência de estoque';
    END IF;
    RAISE NOTICE 'OK 3 — transferência é append-only para a aplicação';
  ELSE
    RAISE NOTICE 'OK 3 — pulado: role da aplicação não existe neste banco';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — nenhuma chave estrangeira de `stock_transfers` apaga em cascata
--
-- `ON DELETE CASCADE` roda com os direitos do dono da tabela e **não passa**
-- pelo `REVOKE DELETE`: numa tabela append-only, apagar a linha vizinha viraria
-- o caminho de destruição que a revogação existia para fechar. `tenant_id` é a
-- única exceção legítima, e é a mesma de todo o schema.
-- ----------------------------------------------------------------------------
DO $$
DECLARE ruins text;
BEGIN
  SELECT string_agg(c.conname, ', ') INTO ruins
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE t.relname = 'stock_transfers'
     AND c.contype = 'f'
     AND c.confdeltype = 'c'
     AND a.attname <> 'tenant_id';

  IF ruins IS NOT NULL THEN
    RAISE EXCEPTION 'transferência de estoque tem chave estrangeira em cascata: %', ruins;
  END IF;
  RAISE NOTICE 'OK 4 — nenhuma cascata destrói o registro da transferência';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — a RLS separa as barbearias em `staff_locations` e em `stock_transfers`
--
-- É a garantia de que o vínculo de unidade de uma barbearia não é legível nem
-- gravável pela outra. Sem `FORCE`, o dono da tabela ignoraria a política — e as
-- migrações rodam como dono.
-- ----------------------------------------------------------------------------
DO $$
DECLARE faltando text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO faltando
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('staff_locations', 'stock_transfers')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF faltando IS NOT NULL THEN
    RAISE EXCEPTION 'tabela nova sem RLS FORCE: %', faltando;
  END IF;

  SELECT string_agg(p.tablename, ', ') INTO faltando
    FROM pg_policies p
   WHERE p.tablename IN ('staff_locations', 'stock_transfers')
     AND (p.qual IS NULL OR p.with_check IS NULL);

  IF faltando IS NOT NULL THEN
    RAISE EXCEPTION 'política sem USING **e** WITH CHECK: %', faltando;
  END IF;
  RAISE NOTICE 'OK 5 — RLS FORCE com USING e WITH CHECK nas duas tabelas novas';
END $$;

-- ----------------------------------------------------------------------------
-- 6 — a unidade da sessão desaparece com a loja, e a sessão fica
--
-- `SET NULL` e não `CASCADE`: fechar uma loja não pode derrubar a sessão de
-- ninguém no meio de um atendimento. A pessoa volta a "ainda não escolheu", que
-- é o estado que cai na primeira aberta.
-- ----------------------------------------------------------------------------
DO $$
DECLARE acao "char";
BEGIN
  SELECT c.confdeltype INTO acao
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE t.relname = 'staff_sessions' AND c.contype = 'f' AND a.attname = 'location_id';

  IF acao IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION 'a unidade da sessão não é SET NULL: %', acao;
  END IF;
  RAISE NOTICE 'OK 6 — fechar a loja não derruba a sessão';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — a unidade da mensalidade do clube é `RESTRICT`
--
-- É linha de dinheiro: apagar a unidade levaria junto o registro do que a
-- assinatura faturou por ela, e a ação referencial roda com os direitos do dono
-- da tabela — não passa por `REVOKE` nenhum.
-- ----------------------------------------------------------------------------
DO $$
DECLARE acao "char";
BEGIN
  SELECT c.confdeltype INTO acao
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE t.relname = 'club_subscriptions' AND c.contype = 'f' AND a.attname = 'location_id';

  IF acao IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION 'a unidade da assinatura do clube não é RESTRICT: %', acao;
  END IF;
  RAISE NOTICE 'OK 7 — a unidade da assinatura não some com a loja';
END $$;

-- ----------------------------------------------------------------------------
-- 8 — a chave estrangeira aceita a unidade da barbearia vizinha
--
-- Não é um defeito a consertar no banco: a checagem de integridade referencial
-- do Postgres **ignora row security**, e é assim em todo o schema. Este teste
-- existe para que a verdade fique escrita — quem grava id vindo do corpo confere
-- sob RLS **antes**, com a contagem batendo, e é isso que
-- `definirUnidadesDoOperador` e `escolherUnidadeDaSessao` fazem.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO stock_transfers
    (tenant_id, product_id, from_location_id, to_location_id, quantity,
     unit_cost_cents, created_by_name)
  VALUES ('61616161-0000-0000-0000-000000000001',
          '61616161-2222-0000-0000-000000000001',
          '61616161-1111-0000-0000-000000000001',
          '61616161-1111-0000-0000-000000000009', 3, 1200, 'Ruan');
  RAISE NOTICE 'OK 8 — a FK aceita unidade alheia; quem recusa é a aplicação, sob RLS';
END $$;

ROLLBACK;
