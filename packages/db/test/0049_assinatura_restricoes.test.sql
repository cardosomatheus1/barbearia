-- ============================================================================
-- Invariantes das restrições da assinatura (bloco 46).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('49494949-0000-0000-0000-000000000001', 'Domari');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('49494949-3333-0000-0000-000000000001',
   '49494949-0000-0000-0000-000000000001', 'Carlos', '+5571988887777'),
  ('49494949-3333-0000-0000-000000000002',
   '49494949-0000-0000-0000-000000000001', 'Bruno', '+5571977776666');

INSERT INTO club_plans (id, tenant_id, name, price_cents) VALUES
  ('49494949-4444-0000-0000-000000000001',
   '49494949-0000-0000-0000-000000000001', 'Premium', 14900);

INSERT INTO club_subscriptions (id, tenant_id, customer_id, plan_id, price_cents, status)
VALUES ('49494949-5555-0000-0000-000000000001',
        '49494949-0000-0000-0000-000000000001',
        '49494949-3333-0000-0000-000000000001',
        '49494949-4444-0000-0000-000000000001', 14900, 'ativa');

-- ----------------------------------------------------------------------------
-- 1 — a janela bloqueada é um intervalo de verdade
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO club_plan_blackouts (tenant_id, plan_id, weekday, start_minute, end_minute)
    VALUES ('49494949-0000-0000-0000-000000000001',
            '49494949-4444-0000-0000-000000000001', 6, 780, 540);
    RAISE EXCEPTION 'aceitou janela que termina antes de começar';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1a — a janela tem começo antes do fim';
  END;

  BEGIN
    INSERT INTO club_plan_blackouts (tenant_id, plan_id, weekday, start_minute, end_minute)
    VALUES ('49494949-0000-0000-0000-000000000001',
            '49494949-4444-0000-0000-000000000001', 9, 540, 780);
    RAISE EXCEPTION 'aceitou dia da semana fora de 0 a 6';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1b — o dia da semana vai de 0 a 6';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — o titular não é dependente de si mesmo
--
-- Ele apareceria duas vezes na lista de quem usa a cota, e a tela mostraria
-- "Carlos (titular)" e "Carlos (dependente)" lado a lado.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO club_dependents (subscription_id, customer_id, tenant_id)
    VALUES ('49494949-5555-0000-0000-000000000001',
            '49494949-3333-0000-0000-000000000001',
            '49494949-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'aceitou o titular como dependente de si mesmo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2 — o titular não é dependente dele mesmo';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — uma pessoa é dependente de uma assinatura só
--
-- Duas fariam a mesma cota ser descontada de dois lugares.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  outra uuid;
BEGIN
  INSERT INTO club_dependents (subscription_id, customer_id, tenant_id)
  VALUES ('49494949-5555-0000-0000-000000000001',
          '49494949-3333-0000-0000-000000000002',
          '49494949-0000-0000-0000-000000000001');

  INSERT INTO customers (id, tenant_id, name, phone_e164)
  VALUES ('49494949-3333-0000-0000-000000000003',
          '49494949-0000-0000-0000-000000000001', 'Ana', '+5571955554444');

  INSERT INTO club_subscriptions (tenant_id, customer_id, plan_id, price_cents, status)
  VALUES ('49494949-0000-0000-0000-000000000001',
          '49494949-3333-0000-0000-000000000003',
          '49494949-4444-0000-0000-000000000001', 14900, 'ativa')
  RETURNING id INTO outra;

  BEGIN
    INSERT INTO club_dependents (subscription_id, customer_id, tenant_id)
    VALUES (outra, '49494949-3333-0000-0000-000000000002',
            '49494949-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'aceitou a mesma pessoa em duas assinaturas';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 3 — uma pessoa, uma assinatura';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — a janela de antecedência tem teto
--
-- Cento e oitenta dias já é meio ano; acima disso a grade vira especulação.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE club_plans SET booking_window_days = 400
     WHERE id = '49494949-4444-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou antecedência de mais de um ano';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4 — a antecedência tem teto';
  END;
END $$;

ROLLBACK;
