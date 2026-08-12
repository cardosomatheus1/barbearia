-- ============================================================================
-- Invariantes do estoque (bloco 44).
--
-- O que se prova aqui é a frase da SPEC §3.7 em código: *"Toda movimentação é
-- imutável e auditada. Estoque é saldo derivado do movimento, nunca campo
-- editado direto."*
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('47474747-0000-0000-0000-000000000001', 'Domari'),
  ('47474747-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('47474747-1111-0000-0000-000000000001',
   '47474747-0000-0000-0000-000000000001', 'Centro', 'America/Bahia');

INSERT INTO services (id, tenant_id, name, duration_minutes, price_cents) VALUES
  ('47474747-2222-0000-0000-000000000001',
   '47474747-0000-0000-0000-000000000001', 'Corte', 30, 6000);

INSERT INTO products (id, tenant_id, name, kind, cost_cents, price_cents, min_stock)
VALUES ('47474747-3333-0000-0000-000000000001',
        '47474747-0000-0000-0000-000000000001', 'Pomada', 'resale', 1200, 3500, 3);

INSERT INTO stock_movements
  (tenant_id, product_id, kind, quantity, unit_cost_cents, business_day)
VALUES ('47474747-0000-0000-0000-000000000001',
        '47474747-3333-0000-0000-000000000001', 'entrada', 10, 1200, '2026-11-01');

-- ----------------------------------------------------------------------------
-- 1 — não existe coluna de estoque
--
-- É a decisão que dá nome ao bloco. Um contador responde "quantos tem" e nada
-- mais; a pergunta que chega no balcão é "por que só tem 12 se eu comprei 20?".
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'products' AND column_name IN ('stock', 'quantity', 'saldo')
  ) THEN
    RAISE EXCEPTION 'alguém criou coluna de saldo em products';
  END IF;
  RAISE NOTICE 'OK 1 — o saldo é derivado, não guardado';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — o saldo nunca fica negativo
--
-- A aplicação confere sob a trava; este gatilho é a segunda camada. Uma
-- cláusula de trava é perdível numa reescrita, e um estoque em −3 contamina o
-- CMV do mês inteiro.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO stock_movements
      (tenant_id, product_id, kind, quantity, unit_cost_cents, business_day)
    VALUES ('47474747-0000-0000-0000-000000000001',
            '47474747-3333-0000-0000-000000000001', 'venda', -50, 1200, '2026-11-01');
    RAISE EXCEPTION 'aceitou deixar o estoque negativo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2 — o saldo não fica negativo';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — cada movimento anda no sentido dele
--
-- Uma "perda de +3" seria uma perda que aumenta o estoque, e a única leitura
-- possível disso é erro de digitação.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO stock_movements
      (tenant_id, product_id, kind, quantity, unit_cost_cents, business_day)
    VALUES ('47474747-0000-0000-0000-000000000001',
            '47474747-3333-0000-0000-000000000001', 'perda', 3, 1200, '2026-11-01');
    RAISE EXCEPTION 'aceitou perda que aumenta o estoque';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3a — perda só subtrai';
  END;

  BEGIN
    INSERT INTO stock_movements
      (tenant_id, product_id, kind, quantity, unit_cost_cents, business_day)
    VALUES ('47474747-0000-0000-0000-000000000001',
            '47474747-3333-0000-0000-000000000001', 'entrada', -3, 1200, '2026-11-01');
    RAISE EXCEPTION 'aceitou entrada que diminui o estoque';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3b — entrada só soma';
  END;

  -- E o ajuste anda nos dois sentidos, que é o que ele existe para fazer.
  INSERT INTO stock_movements
    (tenant_id, product_id, kind, quantity, unit_cost_cents, business_day, reason)
  VALUES ('47474747-0000-0000-0000-000000000001',
          '47474747-3333-0000-0000-000000000001', 'ajuste', -2, 1200, '2026-11-01',
          'contagem da segunda-feira');
  RAISE NOTICE 'OK 3c — ajuste anda nos dois sentidos';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — perda e ajuste exigem motivo escrito
--
-- São os dois em que o número muda sem nota fiscal nem venda, e "sumiu" não é
-- registro de nada.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO stock_movements
      (tenant_id, product_id, kind, quantity, unit_cost_cents, business_day)
    VALUES ('47474747-0000-0000-0000-000000000001',
            '47474747-3333-0000-0000-000000000001', 'perda', -1, 1200, '2026-11-01');
    RAISE EXCEPTION 'aceitou perda sem motivo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4 — perda e ajuste exigem motivo';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — o movimento é imutável para a aplicação
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  pode_apagar boolean;
  pode_editar boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    RAISE NOTICE 'PULADO 5 — sem role da aplicação neste banco';
    RETURN;
  END IF;

  SELECT has_table_privilege('barbearia_app', 'stock_movements', 'DELETE'),
         has_table_privilege('barbearia_app', 'stock_movements', 'UPDATE')
    INTO pode_apagar, pode_editar;

  IF pode_apagar OR pode_editar THEN
    RAISE EXCEPTION 'a aplicação pode reescrever o movimento de estoque';
  END IF;
  RAISE NOTICE 'OK 5 — movimento append-only';
END $$;

-- ----------------------------------------------------------------------------
-- 6 — revenda tem preço; uso interno não
--
-- Revenda sem preço aparece na busca da comanda e entra por zero. Interno com
-- preço é um número que ninguém cobra.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO products (tenant_id, name, kind, cost_cents)
    VALUES ('47474747-0000-0000-0000-000000000001', 'Pomada sem preço', 'resale', 100);
    RAISE EXCEPTION 'aceitou produto de revenda sem preço';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6a — revenda exige preço';
  END;

  BEGIN
    INSERT INTO products (tenant_id, name, kind, cost_cents, price_cents)
    VALUES ('47474747-0000-0000-0000-000000000001', 'Shampoo', 'internal', 100, 900);
    RAISE EXCEPTION 'aceitou produto interno com preço';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6b — uso interno não tem preço';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 7 — o código de barras é único por barbearia
--
-- É o que a recepção bipa, e dois produtos com o mesmo código fariam a leitura
-- escolher um ao acaso.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO products (tenant_id, name, kind, cost_cents, price_cents, barcode)
  VALUES ('47474747-0000-0000-0000-000000000001', 'Cera', 'resale', 800, 2500, '7891234567890');

  BEGIN
    INSERT INTO products (tenant_id, name, kind, cost_cents, price_cents, barcode)
    VALUES ('47474747-0000-0000-0000-000000000001', 'Outra cera', 'resale', 800, 2500,
            '7891234567890');
    RAISE EXCEPTION 'aceitou dois produtos com o mesmo código de barras';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 7 — código de barras único por barbearia';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 8 — a vizinha não lê nem grava estoque nesta casa
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  visiveis integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    RAISE NOTICE 'PULADO 8 — sem role da aplicação neste banco';
    RETURN;
  END IF;

  SET LOCAL ROLE barbearia_app;
  PERFORM set_config('app.tenant_id', '47474747-0000-0000-0000-000000000002', true);

  -- Sem filtro nenhum no WHERE: quem filtra é a política.
  SELECT count(*) INTO visiveis FROM products;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'a vizinha enxergou % produtos desta casa', visiveis;
  END IF;

  SELECT count(*) INTO visiveis FROM stock_movements;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'a vizinha enxergou % movimentos desta casa', visiveis;
  END IF;

  BEGIN
    INSERT INTO products (tenant_id, name, kind, cost_cents, price_cents)
    VALUES ('47474747-0000-0000-0000-000000000001', 'Invadida', 'resale', 100, 200);
    RAISE EXCEPTION 'a vizinha gravou produto na casa alheia';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 8 — WITH CHECK recusa gravar em tenant alheio';
  END;

  RESET ROLE;
END $$;

-- ----------------------------------------------------------------------------
-- 9 — a ficha técnica não pendura produto em serviço de outra casa
--
-- A chave estrangeira do Postgres ignora row security; quem recusa é a política.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO service_consumables (service_id, product_id, tenant_id, quantity)
  VALUES ('47474747-2222-0000-0000-000000000001',
          '47474747-3333-0000-0000-000000000001',
          '47474747-0000-0000-0000-000000000001', 5);
  RAISE NOTICE 'OK 9 — a ficha técnica grava';
END $$;

-- ----------------------------------------------------------------------------
-- 10 — item de comanda com produto só existe em produto e consumível
--
-- Um `service` apontando para produto baixaria estoque por um corte.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  comanda uuid;
BEGIN
  INSERT INTO orders (tenant_id, location_id, status, total_cents)
  VALUES ('47474747-0000-0000-0000-000000000001',
          '47474747-1111-0000-0000-000000000001', 'open', 0)
  RETURNING id INTO comanda;

  BEGIN
    INSERT INTO order_items
      (tenant_id, order_id, kind, product_id, description, quantity, unit_price_cents, position)
    VALUES ('47474747-0000-0000-0000-000000000001', comanda, 'service',
            '47474747-3333-0000-0000-000000000001', 'Corte', 1, 6000, 0);
    RAISE EXCEPTION 'aceitou item de serviço apontando para produto';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 10 — produto só em item de produto ou consumível';
  END;
END $$;

ROLLBACK;
