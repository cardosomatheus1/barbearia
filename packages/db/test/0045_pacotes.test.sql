-- ============================================================================
-- Invariantes dos pacotes (bloco 42).
--
-- O que se prova aqui é o que separa um pacote de um crédito infinito: o mesmo
-- corte não consome duas unidades, o consumo não se reescreve, a soma das
-- unidades nunca passa do que foi pago, e o reembolso não fica pela metade.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('42424242-0000-0000-0000-000000000001', 'Domari'),
  ('42424242-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('42424242-1111-0000-0000-000000000001',
   '42424242-0000-0000-0000-000000000001', 'Centro', 'America/Bahia');

INSERT INTO services (id, tenant_id, name, duration_minutes, price_cents) VALUES
  ('42424242-2222-0000-0000-000000000001',
   '42424242-0000-0000-0000-000000000001', 'Corte', 30, 5000);

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('42424242-3333-0000-0000-000000000001',
   '42424242-0000-0000-0000-000000000001', 'Carlos', '+5571988887777');

INSERT INTO orders (id, tenant_id, location_id, customer_id, status, total_cents)
VALUES ('42424242-7777-0000-0000-000000000001',
        '42424242-0000-0000-0000-000000000001',
        '42424242-1111-0000-0000-000000000001',
        '42424242-3333-0000-0000-000000000001', 'open', 25000);

INSERT INTO packages
  (id, tenant_id, service_id, name, quantity, price_cents, validity_days)
VALUES ('42424242-4444-0000-0000-000000000001',
        '42424242-0000-0000-0000-000000000001',
        '42424242-2222-0000-0000-000000000001',
        '5 cortes', 5, 25000, 180);

INSERT INTO customer_packages
  (id, tenant_id, customer_id, package_id, order_id, service_id,
   quantity, price_cents, unit_value_cents)
VALUES ('42424242-5555-0000-0000-000000000001',
        '42424242-0000-0000-0000-000000000001',
        '42424242-3333-0000-0000-000000000001',
        '42424242-4444-0000-0000-000000000001',
        '42424242-7777-0000-0000-000000000001',
        '42424242-2222-0000-0000-000000000001',
        5, 25000, 5000);

-- ----------------------------------------------------------------------------
-- 1 — a mesma comanda não consome duas unidades do mesmo pacote
--
-- O fechamento é idempotente por chave, mas a cadeia do webhook do Pix reentra
-- por outro caminho. Sem este índice, a reentrega tiraria do cliente um corte
-- que ele não recebeu — e o produto não teria como saber.
-- ----------------------------------------------------------------------------
INSERT INTO package_uses
  (tenant_id, customer_package_id, order_id, value_cents, business_day)
VALUES ('42424242-0000-0000-0000-000000000001',
        '42424242-5555-0000-0000-000000000001',
        '42424242-7777-0000-0000-000000000001', 5000, '2026-11-01');

DO $$
BEGIN
  BEGIN
    INSERT INTO package_uses
      (tenant_id, customer_package_id, order_id, value_cents, business_day)
    VALUES ('42424242-0000-0000-0000-000000000001',
            '42424242-5555-0000-0000-000000000001',
            '42424242-7777-0000-0000-000000000001', 5000, '2026-11-01');
    RAISE EXCEPTION 'consumiu duas unidades pela mesma comanda';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 1 — uma unidade por comanda e por pacote';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — o consumo é append-only para a aplicação
--
-- "Por que sumiu um corte do meu pacote?" é a pergunta, e o registro é a
-- resposta. Registro que pode ser reescrito não responde nada.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  pode_apagar boolean;
  pode_editar boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    RAISE NOTICE 'PULADO 2 — sem role da aplicação neste banco';
    RETURN;
  END IF;

  SELECT has_table_privilege('barbearia_app', 'package_uses', 'DELETE'),
         has_table_privilege('barbearia_app', 'package_uses', 'UPDATE')
    INTO pode_apagar, pode_editar;

  IF pode_apagar OR pode_editar THEN
    RAISE EXCEPTION 'a aplicação pode reescrever o consumo do pacote';
  END IF;
  RAISE NOTICE 'OK 2 — consumo append-only';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — a soma das unidades nunca passa do que foi pago
--
-- Uma unidade de R$ 60 num pacote de R$ 250 por cinco cortes reconheceria
-- R$ 300 de receita sobre R$ 250 recebidos: o diferido ficaria negativo e o DRE
-- passaria a mostrar dinheiro que ninguém pagou.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO customer_packages
      (tenant_id, customer_id, service_id, quantity, price_cents, unit_value_cents)
    VALUES ('42424242-0000-0000-0000-000000000001',
            '42424242-3333-0000-0000-000000000001',
            '42424242-2222-0000-0000-000000000001', 5, 25000, 6000);
    RAISE EXCEPTION 'aceitou unidade que soma mais que o preço pago';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3 — a unidade cabe no que foi pago';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — reembolso pela metade é recusado
--
-- Data sem valor é "devolvi, não sei quanto"; valor sem data é um número que
-- nunca saiu do caixa. As duas colunas são a mesma decisão, e o schema é que
-- garante que elas andem juntas.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE customer_packages SET refunded_at = now()
     WHERE id = '42424242-5555-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou reembolso sem valor';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4 — reembolso é data e valor juntos';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — o pacote de outra barbearia não é visto nem escrito
--
-- A checagem de chave estrangeira do Postgres ignora row security: a referência
-- ao serviço de outra casa passaria. Quem recusa é a política, e é ela que está
-- sendo provada aqui.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  visiveis integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    RAISE NOTICE 'PULADO 5 — sem role da aplicação neste banco';
    RETURN;
  END IF;

  SET LOCAL ROLE barbearia_app;
  PERFORM set_config('app.tenant_id', '42424242-0000-0000-0000-000000000002', true);

  -- Sem filtro nenhum no WHERE: quem filtra é a política, e é isso que se prova.
  SELECT count(*) INTO visiveis FROM customer_packages;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'a vizinha enxergou % pacotes desta casa', visiveis;
  END IF;

  BEGIN
    INSERT INTO customer_packages
      (tenant_id, customer_id, service_id, quantity, price_cents, unit_value_cents)
    VALUES ('42424242-0000-0000-0000-000000000001',
            '42424242-3333-0000-0000-000000000001',
            '42424242-2222-0000-0000-000000000001', 5, 25000, 5000);
    RAISE EXCEPTION 'a vizinha gravou pacote na casa alheia';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 5 — WITH CHECK recusa gravar em tenant alheio';
  END;

  RESET ROLE;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — pacote de uma unidade não existe no catálogo
--
-- "1 corte por R$ 50" é um corte, não um pacote: ele passaria a existir como
-- item de catálogo paralelo ao serviço, com preço próprio e sem aparecer na
-- agenda. O piso de dois está no schema porque é regra do produto.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO packages (tenant_id, service_id, name, quantity, price_cents)
    VALUES ('42424242-0000-0000-0000-000000000001',
            '42424242-2222-0000-0000-000000000001', '1 corte', 1, 5000);
    RAISE EXCEPTION 'aceitou pacote de uma unidade';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6 — pacote começa em duas unidades';
  END;
END $$;

ROLLBACK;
