-- ============================================================================
-- Invariantes da comissão sobre assinatura (bloco 48).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('51515151-0000-0000-0000-000000000001', 'Domari');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('51515151-1111-0000-0000-000000000001',
   '51515151-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('51515151-3333-0000-0000-000000000001',
   '51515151-0000-0000-0000-000000000001', 'Carlos', '+5571988887777');

INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
  ('51515151-2222-0000-0000-000000000001',
   '51515151-0000-0000-0000-000000000001',
   '51515151-1111-0000-0000-000000000001', 'Ruan');

INSERT INTO club_plans (id, tenant_id, name, price_cents) VALUES
  ('51515151-4444-0000-0000-000000000001',
   '51515151-0000-0000-0000-000000000001', 'Premium', 14900);

INSERT INTO club_subscriptions (id, tenant_id, customer_id, plan_id, price_cents, status)
VALUES ('51515151-5555-0000-0000-000000000001',
        '51515151-0000-0000-0000-000000000001',
        '51515151-3333-0000-0000-000000000001',
        '51515151-4444-0000-0000-000000000001', 14900, 'ativa');

INSERT INTO commission_rules (id, tenant_id, mode, value) VALUES
  ('51515151-6666-0000-0000-000000000001',
   '51515151-0000-0000-0000-000000000001', 'percent', 4000);

-- ----------------------------------------------------------------------------
-- 1 — o padrão é `por_uso`, que é o comportamento anterior
--
-- Um padrão `rateio` faria toda barbearia já instalada ver a comissão da equipe
-- cair no dia da migração, sem ninguém ter decidido nada. É o mesmo raciocínio
-- de `fee_treatment` nascer `absorvida` no bloco 36 — padrão de configuração que
-- mexe em dinheiro é sempre o comportamento de antes.
-- ----------------------------------------------------------------------------
DO $$
DECLARE modo text;
BEGIN
  SELECT subscription_commission_mode::text INTO modo
    FROM tenants WHERE id = '51515151-0000-0000-0000-000000000001';
  IF modo <> 'por_uso' THEN
    RAISE EXCEPTION 'barbearia nova nasceu com modelo %, não com o anterior', modo;
  END IF;
  RAISE NOTICE 'OK 1 — o modelo nasce no comportamento anterior';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — a assinatura e a mensalidade andam juntas no lançamento
--
-- Uma sem a outra é um lançamento que diz "veio do plano" e não sabe de quanto
-- era a mensalidade — e o rateio dividiria por zero, literalmente.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO commission_entries
      (tenant_id, professional_id, earned_on, rule_id, mode, value, base_cents, sign,
       club_subscription_id)
    VALUES ('51515151-0000-0000-0000-000000000001',
            '51515151-2222-0000-0000-000000000001', current_date,
            '51515151-6666-0000-0000-000000000001', 'percent', 4000, 6000, 1,
            '51515151-5555-0000-0000-000000000001');
    RAISE EXCEPTION 'aceitou assinatura sem a mensalidade congelada';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2a — assinatura sem mensalidade é recusada';
  END;

  BEGIN
    INSERT INTO commission_entries
      (tenant_id, professional_id, earned_on, rule_id, mode, value, base_cents, sign,
       subscription_fee_cents)
    VALUES ('51515151-0000-0000-0000-000000000001',
            '51515151-2222-0000-0000-000000000001', current_date,
            '51515151-6666-0000-0000-000000000001', 'percent', 4000, 6000, 1, 14900);
    RAISE EXCEPTION 'aceitou mensalidade sem a assinatura';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2b — mensalidade sem assinatura é recusada';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — mensalidade zero não existe
--
-- Ela dividiria a base por zero no rateio, e o barbeiro receberia zero por um
-- mês inteiro de atendimentos sem nada dizendo por quê.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO commission_entries
      (tenant_id, professional_id, earned_on, rule_id, mode, value, base_cents, sign,
       club_subscription_id, subscription_fee_cents)
    VALUES ('51515151-0000-0000-0000-000000000001',
            '51515151-2222-0000-0000-000000000001', current_date,
            '51515151-6666-0000-0000-000000000001', 'percent', 4000, 6000, 1,
            '51515151-5555-0000-0000-000000000001', 0);
    RAISE EXCEPTION 'aceitou mensalidade zerada';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3 — mensalidade congelada é sempre positiva';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — o teto do híbrido é uma alíquota, em pontos-base inteiros
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE tenants SET subscription_commission_cap_bps = 20000
     WHERE id = '51515151-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou teto acima de 100%%';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4 — o teto vai de 0 a 100%%';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — apagar a assinatura não apaga a comissão
--
-- `commission_entries` é append-only por `REVOKE` desde o bloco 19, e ação
-- referencial **não passa** pela revogação: um `CASCADE` aqui seria o caminho de
-- destruição que a revogação existia para fechar, levando junto a comissão de um
-- período possivelmente já fechado e pago.
-- ----------------------------------------------------------------------------
DO $$
DECLARE acao text;
BEGIN
  SELECT CASE confdeltype WHEN 'n' THEN 'SET NULL' WHEN 'c' THEN 'CASCADE'
                          WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                          ELSE confdeltype::text END
    INTO acao
    FROM pg_constraint
   WHERE conrelid = 'commission_entries'::regclass
     AND confrelid = 'club_subscriptions'::regclass
     AND contype = 'f';

  IF acao IS DISTINCT FROM 'SET NULL' THEN
    RAISE EXCEPTION 'a comissão aponta para a assinatura com % em vez de SET NULL', acao;
  END IF;
  RAISE NOTICE 'OK 5 — apagar a assinatura desata a comissão, não a destrói';
END $$;

ROLLBACK;
