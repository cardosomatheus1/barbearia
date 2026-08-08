-- ============================================================================
-- Invariantes da comanda, do caixa e do fiado.
--
-- Aqui é dinheiro: o que se prova é do banco, porque é o banco que continua de
-- pé quando a aplicação tem um bug.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

-- Ids próprios: as provas anteriores fazem commit e deixam as delas no banco.
INSERT INTO tenants (id, name) VALUES
  ('88888888-8888-8888-8888-888888888881', 'Domari'),
  ('88888888-8888-8888-8888-888888888882', 'Rival');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('aaaaaaaa-8888-0000-0000-000000000001', '88888888-8888-8888-8888-888888888881', 'Matriz', 'America/Bahia'),
  ('aaaaaaaa-8888-0000-0000-000000000002', '88888888-8888-8888-8888-888888888882', 'Rival', 'America/Bahia');

INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
  ('bbbbbbbb-8888-0000-0000-000000000001', '88888888-8888-8888-8888-888888888881', 'aaaaaaaa-8888-0000-0000-000000000001', 'Ruan', 'professional');

INSERT INTO customers (id, tenant_id, name, phone_e164, credit_limit_cents) VALUES
  ('cccccccc-8888-0000-0000-000000000001', '88888888-8888-8888-8888-888888888881', 'Carlos', '+5571900008881', 10000);

INSERT INTO cash_sessions (id, tenant_id, location_id, opened_by_name, opening_cents) VALUES
  ('dddddddd-8888-0000-0000-000000000001', '88888888-8888-8888-8888-888888888881',
   'aaaaaaaa-8888-0000-0000-000000000001', 'Maria', 20000);

INSERT INTO orders (id, tenant_id, location_id, customer_id, session_id) VALUES
  ('eeeeeeee-8888-0000-0000-000000000001', '88888888-8888-8888-8888-888888888881',
   'aaaaaaaa-8888-0000-0000-000000000001', 'cccccccc-8888-0000-0000-000000000001',
   'dddddddd-8888-0000-0000-000000000001');

-- ----------------------------------------------------------------------------
-- Caixa
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  INSERT INTO cash_sessions (tenant_id, location_id, opened_by_name, opening_cents)
  VALUES ('88888888-8888-8888-8888-888888888881', 'aaaaaaaa-8888-0000-0000-000000000001', 'Outro', 5000);
  RAISE EXCEPTION 'FALHOU: dois caixas abertos na mesma unidade';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'OK 1 — só um caixa aberto por unidade; a venda sempre tem gaveta definida';
END $$;

DO $$
BEGIN
  UPDATE cash_sessions SET status = 'closed', closed_at = now()
   WHERE id = 'dddddddd-8888-0000-0000-000000000001';
  RAISE EXCEPTION 'FALHOU: caixa fechado sem contagem e sem divergência';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 2 — fechar exige o contado, o esperado e a divergência';
END $$;

DO $$
BEGIN
  INSERT INTO cash_movements (tenant_id, session_id, kind, amount_cents, created_by_name)
  VALUES ('88888888-8888-8888-8888-888888888881', 'dddddddd-8888-0000-0000-000000000001',
          'withdrawal', 5000, 'Maria');
  RAISE EXCEPTION 'FALHOU: sangria com sinal positivo aumentaria a gaveta';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 3 — sangria sai, suprimento entra; o sinal não é livre';
END $$;

-- ----------------------------------------------------------------------------
-- Comanda
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  INSERT INTO order_items (tenant_id, order_id, kind, description, unit_price_cents)
  VALUES ('88888888-8888-8888-8888-888888888881', 'eeeeeeee-8888-0000-0000-000000000001',
          'product', 'Desconto disfarçado', -1000);
  RAISE EXCEPTION 'FALHOU: item com preço negativo esconde desconto da receita';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 4 — preço de item nunca é negativo; desconto tem campo próprio';
END $$;

DO $$
BEGIN
  INSERT INTO order_items (tenant_id, order_id, kind, description, unit_price_cents, quantity)
  VALUES ('88888888-8888-8888-8888-888888888881', 'eeeeeeee-8888-0000-0000-000000000001',
          'product', 'Pomada', 4500, 0);
  RAISE EXCEPTION 'FALHOU: item com quantidade zero';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 5 — quantidade de item é pelo menos 1';
END $$;

DO $$
BEGIN
  UPDATE orders SET subtotal_cents = 7000, discount_cents = 9000
   WHERE id = 'eeeeeeee-8888-0000-0000-000000000001';
  RAISE EXCEPTION 'FALHOU: desconto maior que o subtotal vira crédito não autorizado';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 6 — desconto nunca passa do subtotal';
END $$;

DO $$
BEGIN
  UPDATE orders SET status = 'paid' WHERE id = 'eeeeeeee-8888-0000-0000-000000000001';
  RAISE EXCEPTION 'FALHOU: comanda paga sem hora de fechamento';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 7 — comanda paga tem hora; sem ela não há faturamento por período';
END $$;

DO $$
BEGIN
  INSERT INTO order_payments (tenant_id, order_id, method, amount_cents)
  VALUES ('88888888-8888-8888-8888-888888888881', 'eeeeeeee-8888-0000-0000-000000000001',
          'cash', 0);
  RAISE EXCEPTION 'FALHOU: pagamento de valor zero';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 8 — pagamento tem valor positivo';
END $$;

-- Uma comanda aberta por agendamento: duas seriam duas cobranças do mesmo corte.
DO $$
DECLARE agendamento uuid;
BEGIN
  INSERT INTO appointments (tenant_id, location_id, professional_id,
                            starts_at, ends_at, service_starts_at, service_ends_at)
  VALUES ('88888888-8888-8888-8888-888888888881', 'aaaaaaaa-8888-0000-0000-000000000001',
          'bbbbbbbb-8888-0000-0000-000000000001',
          '2030-01-01T12:00:00Z', '2030-01-01T12:30:00Z',
          '2030-01-01T12:00:00Z', '2030-01-01T12:30:00Z')
  RETURNING id INTO agendamento;

  INSERT INTO orders (tenant_id, location_id, appointment_id)
  VALUES ('88888888-8888-8888-8888-888888888881', 'aaaaaaaa-8888-0000-0000-000000000001', agendamento);

  INSERT INTO orders (tenant_id, location_id, appointment_id)
  VALUES ('88888888-8888-8888-8888-888888888881', 'aaaaaaaa-8888-0000-0000-000000000001', agendamento);

  RAISE EXCEPTION 'FALHOU: duas comandas abertas para o mesmo agendamento';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'OK 9 — uma comanda aberta por agendamento; duas seriam cobrança dobrada';
END $$;

-- ----------------------------------------------------------------------------
-- Fiado
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  UPDATE customers SET credit_limit_cents = -100
   WHERE id = 'cccccccc-8888-0000-0000-000000000001';
  RAISE EXCEPTION 'FALHOU: limite de fiado negativo';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 10 — limite de fiado nunca é negativo';
END $$;

DO $$
DECLARE padrao int;
BEGIN
  INSERT INTO customers (tenant_id, name, phone_e164)
  VALUES ('88888888-8888-8888-8888-888888888881', 'Novo', '+5571900008889');

  SELECT credit_limit_cents INTO padrao FROM customers WHERE phone_e164 = '+5571900008889';
  IF padrao <> 0 THEN
    RAISE EXCEPTION 'FALHOU: cliente novo nasce fiando % centavos', padrao;
  END IF;
  RAISE NOTICE 'OK 11 — cliente novo não fia por padrão; fiar é decisão, não default';
END $$;

-- ----------------------------------------------------------------------------
-- O extrato é prova
-- ----------------------------------------------------------------------------

SET ROLE barbearia_app;

DO $$
BEGIN
  PERFORM set_config('app.tenant_id', '88888888-8888-8888-8888-888888888881', true);
  INSERT INTO customer_ledger (tenant_id, customer_id, kind, amount_cents,
                               balance_after_cents, created_by_name)
  VALUES ('88888888-8888-8888-8888-888888888881', 'cccccccc-8888-0000-0000-000000000001',
          'fiado', -7000, -7000, 'Maria');

  UPDATE customer_ledger SET amount_cents = 0;
  RAISE EXCEPTION 'FALHOU: a aplicação reescreveu o extrato do cliente';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'OK 12 — extrato é append-only; prova que se reescreve não prova nada';
END $$;

DO $$
BEGIN
  PERFORM set_config('app.tenant_id', '88888888-8888-8888-8888-888888888881', true);
  DELETE FROM customer_ledger;
  RAISE EXCEPTION 'FALHOU: a aplicação apagou o extrato do cliente';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'OK 13 — extrato não se apaga';
END $$;

-- ----------------------------------------------------------------------------
-- Isolamento entre barbearias
-- ----------------------------------------------------------------------------

DO $$
DECLARE visiveis int;
BEGIN
  PERFORM set_config('app.tenant_id', '88888888-8888-8888-8888-888888888882', true);
  SELECT count(*) INTO visiveis FROM orders;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'FALHOU: rival enxergou % comandas alheias', visiveis;
  END IF;

  SELECT count(*) INTO visiveis FROM cash_sessions;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'FALHOU: rival enxergou % caixas alheios', visiveis;
  END IF;

  SELECT count(*) INTO visiveis FROM customer_ledger;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'FALHOU: rival enxergou % linhas do extrato alheio', visiveis;
  END IF;

  RAISE NOTICE 'OK 14 — comanda, caixa e extrato de uma barbearia não existem para a outra';
END $$;

DO $$
BEGIN
  PERFORM set_config('app.tenant_id', '88888888-8888-8888-8888-888888888882', true);
  INSERT INTO orders (tenant_id, location_id)
  VALUES ('88888888-8888-8888-8888-888888888881', 'aaaaaaaa-8888-0000-0000-000000000001');
  RAISE EXCEPTION 'FALHOU: gravou comanda em nome de outra barbearia';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'OK 15 — não se abre comanda na barbearia do vizinho';
END $$;

DO $$
DECLARE afetadas int;
BEGIN
  PERFORM set_config('app.tenant_id', '88888888-8888-8888-8888-888888888882', true);
  UPDATE customers SET credit_limit_cents = 999999;
  GET DIAGNOSTICS afetadas = ROW_COUNT;
  IF afetadas <> 0 THEN
    RAISE EXCEPTION 'FALHOU: rival mexeu no limite de fiado de % clientes alheios', afetadas;
  END IF;
  RAISE NOTICE 'OK 16 — o rival não mexe no limite de fiado da casa';
END $$;

RESET ROLE;

ROLLBACK;

DO $$ BEGIN RAISE NOTICE '--- invariantes da comanda e do caixa passaram ---'; END $$;
