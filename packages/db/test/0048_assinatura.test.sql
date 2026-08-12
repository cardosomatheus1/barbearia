-- ============================================================================
-- Invariantes do clube de assinatura (bloco 45).
--
-- O que se prova aqui é o que separa um clube de uma máquina de dar corte: uma
-- assinatura viva por pessoa, uso que não se reescreve, e o cooldown com teto.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('48484848-0000-0000-0000-000000000001', 'Domari'),
  ('48484848-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('48484848-1111-0000-0000-000000000001',
   '48484848-0000-0000-0000-000000000001', 'Centro', 'America/Bahia');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('48484848-3333-0000-0000-000000000001',
   '48484848-0000-0000-0000-000000000001', 'Carlos', '+5571988887777');

INSERT INTO services (id, tenant_id, name, duration_minutes, price_cents) VALUES
  ('48484848-2222-0000-0000-000000000001',
   '48484848-0000-0000-0000-000000000001', 'Corte', 30, 6000);

INSERT INTO club_plans (id, tenant_id, name, price_cents) VALUES
  ('48484848-4444-0000-0000-000000000001',
   '48484848-0000-0000-0000-000000000001', 'Premium', 14900);

INSERT INTO club_subscriptions (id, tenant_id, customer_id, plan_id, price_cents, status)
VALUES ('48484848-5555-0000-0000-000000000001',
        '48484848-0000-0000-0000-000000000001',
        '48484848-3333-0000-0000-000000000001',
        '48484848-4444-0000-0000-000000000001', 14900, 'ativa');

-- ----------------------------------------------------------------------------
-- 1 — uma assinatura viva por cliente
--
-- Duas fariam a cota de cada uma ser contada em separado e a grade oferecer o
-- dobro — e no balcão ninguém saberia qual está sendo usada.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO club_subscriptions (tenant_id, customer_id, plan_id, price_cents, status)
    VALUES ('48484848-0000-0000-0000-000000000001',
            '48484848-3333-0000-0000-000000000001',
            '48484848-4444-0000-0000-000000000001', 14900, 'ativa');
    RAISE EXCEPTION 'aceitou duas assinaturas vivas para o mesmo cliente';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 1 — uma assinatura viva por cliente';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — cancelada libera, e exige a data
--
-- Estado e data andam juntos: `cancelada` sem data é "cancelei, não sei quando",
-- e data sem o estado é uma assinatura fantasma que continua contando no MRR.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE club_subscriptions SET status = 'cancelada'
     WHERE id = '48484848-5555-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou cancelamento sem data';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2a — cancelamento exige data';
  END;

  UPDATE club_subscriptions SET status = 'cancelada', cancelled_at = now()
   WHERE id = '48484848-5555-0000-0000-000000000001';

  INSERT INTO club_subscriptions (tenant_id, customer_id, plan_id, price_cents, status)
  VALUES ('48484848-0000-0000-0000-000000000001',
          '48484848-3333-0000-0000-000000000001',
          '48484848-4444-0000-0000-000000000001', 14900, 'ativa');
  RAISE NOTICE 'OK 2b — cancelar libera para assinar de novo';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — o cooldown tem teto, e o benefício ilimitado é nulo
--
-- Noventa dias é mais que qualquer ciclo de corte; acima disso o "benefício"
-- não é um benefício. E `quantity = 0` seria um plano que não dá nada.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO club_plan_benefits (plan_id, service_id, tenant_id, quantity, cooldown_days)
    VALUES ('48484848-4444-0000-0000-000000000001',
            '48484848-2222-0000-0000-000000000001',
            '48484848-0000-0000-0000-000000000001', 2, 200);
    RAISE EXCEPTION 'aceitou cooldown de duzentos dias';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3a — o cooldown tem teto';
  END;

  BEGIN
    INSERT INTO club_plan_benefits (plan_id, service_id, tenant_id, quantity, cooldown_days)
    VALUES ('48484848-4444-0000-0000-000000000001',
            '48484848-2222-0000-0000-000000000001',
            '48484848-0000-0000-0000-000000000001', 0, 0);
    RAISE EXCEPTION 'aceitou benefício de quantidade zero';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3b — quantidade zero não é benefício';
  END;

  -- Nulo é ilimitado, e passa.
  INSERT INTO club_plan_benefits (plan_id, service_id, tenant_id, quantity, cooldown_days)
  VALUES ('48484848-4444-0000-0000-000000000001',
          '48484848-2222-0000-0000-000000000001',
          '48484848-0000-0000-0000-000000000001', NULL, 7);
  RAISE NOTICE 'OK 3c — ilimitado é nulo';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — o uso é append-only
--
-- "Por que sumiu um corte do meu plano?" é a pergunta, e o registro é a resposta.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  pode_apagar boolean;
  pode_editar boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    RAISE NOTICE 'PULADO 4 — sem role da aplicação neste banco';
    RETURN;
  END IF;

  SELECT has_table_privilege('barbearia_app', 'club_uses', 'DELETE'),
         has_table_privilege('barbearia_app', 'club_uses', 'UPDATE')
    INTO pode_apagar, pode_editar;

  IF pode_apagar OR pode_editar THEN
    RAISE EXCEPTION 'a aplicação pode reescrever o uso da assinatura';
  END IF;
  RAISE NOTICE 'OK 4 — uso append-only';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — o desconto em produto é alíquota com teto
--
-- Cinquenta por cento é a casa pagando para vender, e costuma ser um zero a mais.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO club_plans (tenant_id, name, price_cents, product_discount_bps)
    VALUES ('48484848-0000-0000-0000-000000000001', 'Absurdo', 9900, 9000);
    RAISE EXCEPTION 'aceitou noventa por cento de desconto em produto';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 5 — o desconto em produto tem teto';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — a vizinha não lê nem grava o clube desta casa
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  visiveis integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    RAISE NOTICE 'PULADO 6 — sem role da aplicação neste banco';
    RETURN;
  END IF;

  SET LOCAL ROLE barbearia_app;
  PERFORM set_config('app.tenant_id', '48484848-0000-0000-0000-000000000002', true);

  SELECT count(*) INTO visiveis FROM club_subscriptions;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'a vizinha enxergou % assinaturas desta casa', visiveis;
  END IF;

  BEGIN
    INSERT INTO club_plans (tenant_id, name, price_cents)
    VALUES ('48484848-0000-0000-0000-000000000001', 'Invadido', 100);
    RAISE EXCEPTION 'a vizinha gravou plano na casa alheia';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 6 — WITH CHECK recusa gravar em tenant alheio';
  END;

  RESET ROLE;
END $$;

-- ----------------------------------------------------------------------------
-- 7 — a assinatura da plataforma e a do clube são coisas diferentes
--
-- A SPEC §8 chama as duas de MRR: `subscriptions` é o que a barbearia paga a
-- nós, `club_subscriptions` é o que o cliente paga a ela. Confundi-las no
-- schema seria confundi-las em toda consulta daqui para a frente.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'subscriptions')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'club_subscriptions')
  THEN
    RAISE EXCEPTION 'as duas assinaturas deixaram de existir separadas';
  END IF;
  RAISE NOTICE 'OK 7 — as duas assinaturas são tabelas diferentes';
END $$;

ROLLBACK;
