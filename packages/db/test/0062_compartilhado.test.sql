-- ============================================================================
-- Invariantes do que é da rede e do que é da loja (bloco 59).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('62626262-0000-0000-0000-000000000001', 'Domari');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('62626262-1111-0000-0000-000000000001',
   '62626262-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('62626262-2222-0000-0000-000000000001',
   '62626262-0000-0000-0000-000000000001', 'Carlos Souza', '+5571988887777');

-- ----------------------------------------------------------------------------
-- 1 — os três interruptores nascem `empresa`
--
-- É a regra deste projeto para configuração que mexe em dinheiro: o padrão é o
-- comportamento **anterior**. Um padrão `unidade` faria toda barbearia já
-- instalada ver o saldo do cliente ser recortado no dia da migração, sem
-- ninguém ter decidido nada.
-- ----------------------------------------------------------------------------
DO $$
DECLARE errado text;
BEGIN
  SELECT string_agg(t.tabela || '.' || t.coluna, ', ') INTO errado
    FROM (VALUES
      ('loyalty_programs', 'scope'),
      ('club_plans', 'scope'),
      ('tenants', 'credit_scope')
    ) AS t(tabela, coluna)
    JOIN information_schema.columns c
      ON c.table_name = t.tabela AND c.column_name = t.coluna
   WHERE c.column_default IS DISTINCT FROM '''empresa''::escopo_multiunidade';

  IF errado IS NOT NULL THEN
    RAISE EXCEPTION 'interruptor de escopo com padrão diferente do anterior: %', errado;
  END IF;
  RAISE NOTICE 'OK 1 — os três escopos nascem empresa';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — lançamento de escopo `unidade` sem unidade não existe
--
-- Ele seria uma linha sem bolso: não entraria em saldo nenhum, e o cliente veria
-- pontos sumirem sem nenhuma explicação no extrato.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO loyalty_entries (tenant_id, customer_id, kind, mode, amount, scope)
    VALUES ('62626262-0000-0000-0000-000000000001',
            '62626262-2222-0000-0000-000000000001', 'acumulo', 'pontos', 10, 'unidade');
    RAISE EXCEPTION 'lançamento de unidade sem unidade foi aceito';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2a — escopo unidade exige unidade';
  END;

  -- O contrário é legítimo: escopo `empresa` **com** unidade guarda onde a
  -- pessoa estava, e isso informa a ficha sem recortar o saldo.
  INSERT INTO loyalty_entries (tenant_id, customer_id, kind, mode, amount, scope, location_id)
  VALUES ('62626262-0000-0000-0000-000000000001',
          '62626262-2222-0000-0000-000000000001', 'acumulo', 'pontos', 10,
          'empresa', '62626262-1111-0000-0000-000000000001');
  RAISE NOTICE 'OK 2b — escopo empresa com unidade é aceito e não recorta';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — a unidade não some com a loja em tabela append-only
--
-- `loyalty_entries` e `customer_ledger` não se apagam. Numa tabela assim toda
-- chave estrangeira é `SET NULL` — `ON DELETE CASCADE` roda com os direitos do
-- dono e **não** passa pelo `REVOKE DELETE`, então seria o caminho de destruição
-- que a revogação existe para fechar.
-- ----------------------------------------------------------------------------
DO $$
DECLARE ruins text;
BEGIN
  SELECT string_agg(t.relname || '.' || a.attname, ', ') INTO ruins
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE t.relname IN ('loyalty_entries', 'customer_ledger')
     AND c.contype = 'f'
     AND a.attname = 'location_id'
     AND c.confdeltype <> 'n';

  IF ruins IS NOT NULL THEN
    RAISE EXCEPTION 'unidade em tabela append-only sem SET NULL: %', ruins;
  END IF;
  RAISE NOTICE 'OK 3 — apagar a loja não destrói o extrato';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — o extrato do fiado continua sem `DELETE` para a aplicação
--
-- O bolso por unidade é derivado dele. Se a aplicação pudesse apagar uma linha,
-- apagar a dívida da loja seria mais fácil do que pagá-la.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    IF has_table_privilege('barbearia_app', 'customer_ledger', 'DELETE')
       OR has_table_privilege('barbearia_app', 'loyalty_entries', 'DELETE') THEN
      RAISE EXCEPTION 'a aplicação pode apagar linha de extrato';
    END IF;
    RAISE NOTICE 'OK 4 — os dois extratos continuam append-only';
  ELSE
    RAISE NOTICE 'OK 4 — pulado: role da aplicação não existe neste banco';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — o escopo é um tipo só para os três
--
-- Três enums iguais é como um ganha um valor que os outros não têm, e a tela
-- passa a precisar saber qual é qual.
-- ----------------------------------------------------------------------------
DO $$
DECLARE valores text;
BEGIN
  SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) INTO valores
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'escopo_multiunidade';

  IF valores IS DISTINCT FROM 'empresa,unidade' THEN
    RAISE EXCEPTION 'o enum do escopo mudou: %', valores;
  END IF;
  RAISE NOTICE 'OK 5 — um tipo só, com dois valores';
END $$;

ROLLBACK;
