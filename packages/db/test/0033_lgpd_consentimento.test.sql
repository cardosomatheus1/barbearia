-- ============================================================================
-- Invariantes do consentimento (bloco 31).
--
-- O que se prova aqui é o que separa consentimento de checkbox: que a decisão
-- vira histórico e não sobrescrita, que o espelho segue a última decisão e não
-- a última escrita, e que ninguém apaga uma concessão.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('33333333-0000-0000-0000-000000000001', 'Domari');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('c3333333-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
   'Carlos Souza', '+5571988887777');

-- ----------------------------------------------------------------------------
-- 1 — consentir e revogar são duas linhas, não uma sobrescrita
--
-- "Quando ele consentiu" e "quando revogou" são perguntas diferentes, e é o par
-- que responde a uma contestação. Com uma linha por finalidade, a segunda some.
-- ----------------------------------------------------------------------------
INSERT INTO customer_consents (customer_id, tenant_id, purpose, granted, text_version, decided_at)
VALUES
  ('c3333333-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
   'marketing', true, 'v1', '2026-01-10T12:00:00Z'),
  ('c3333333-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
   'marketing', false, 'v1', '2026-03-05T09:00:00Z');

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM customer_consents
   WHERE customer_id = 'c3333333-0000-0000-0000-000000000001' AND purpose = 'marketing';
  IF n <> 2 THEN
    RAISE EXCEPTION 'a revogação sobrescreveu a concessão: % linha(s)', n;
  END IF;
  RAISE NOTICE 'OK 1 — consentir e revogar convivem no histórico';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — o espelho que o disparo de campanha lê acompanha a última decisão
-- ----------------------------------------------------------------------------
DO $$
DECLARE aceita boolean; versao text;
BEGIN
  SELECT accepts_marketing, marketing_consent_version INTO aceita, versao
    FROM customers WHERE id = 'c3333333-0000-0000-0000-000000000001';

  IF aceita THEN
    RAISE EXCEPTION 'o cliente revogou e o espelho continua dizendo que aceita';
  END IF;
  IF versao <> 'v1' THEN
    RAISE EXCEPTION 'a versão do texto não acompanhou: %', versao;
  END IF;
  RAISE NOTICE 'OK 2 — o espelho segue a decisão mais recente';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — decisão antiga inserida depois não ressuscita o aceite
--
-- Importação e correção manual inserem fora de ordem. Sem a guarda, o registro
-- de janeiro sobrescreveria a revogação de março e a campanha sairia para quem
-- pediu para parar.
-- ----------------------------------------------------------------------------
INSERT INTO customer_consents (customer_id, tenant_id, purpose, granted, text_version, decided_at)
VALUES ('c3333333-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
        'marketing', true, 'v0', '2025-06-01T12:00:00Z');

DO $$
DECLARE aceita boolean;
BEGIN
  SELECT accepts_marketing INTO aceita FROM customers
   WHERE id = 'c3333333-0000-0000-0000-000000000001';
  IF aceita THEN
    RAISE EXCEPTION 'uma decisão de 2025 desfez a revogação de 2026';
  END IF;
  RAISE NOTICE 'OK 3 — decisão fora de ordem não move o espelho';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — finalidade que não é marketing não mexe no espelho
--
-- Consentir foto não pode ligar campanha. São aceites distintos, e a SPEC §1.8
-- é explícita sobre isso.
-- ----------------------------------------------------------------------------
INSERT INTO customer_consents (customer_id, tenant_id, purpose, granted, text_version, decided_at)
VALUES ('c3333333-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
        'photos', true, 'v1', '2026-04-01T12:00:00Z');

DO $$
DECLARE aceita boolean;
BEGIN
  SELECT accepts_marketing INTO aceita FROM customers
   WHERE id = 'c3333333-0000-0000-0000-000000000001';
  IF aceita THEN
    RAISE EXCEPTION 'consentir foto ligou o marketing';
  END IF;
  RAISE NOTICE 'OK 4 — consentimento de foto não liga campanha';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — a aplicação não apaga nem reescreve consentimento
--
-- Prova que a própria aplicação pode reescrever não é prova.
-- ----------------------------------------------------------------------------
SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '33333333-0000-0000-0000-000000000001', true);

DO $$
BEGIN
  BEGIN
    UPDATE customer_consents SET granted = true
     WHERE customer_id = 'c3333333-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'a aplicação reescreveu um consentimento';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 5 — consentimento não é reescrito';
  END;

  BEGIN
    DELETE FROM customer_consents
     WHERE customer_id = 'c3333333-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'a aplicação apagou um consentimento';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 5b — nem apagado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — o pedido do titular tem prazo, e a recusa tem motivo
-- ----------------------------------------------------------------------------
DO $$
DECLARE pedido uuid;
BEGIN
  INSERT INTO data_requests (tenant_id, customer_id, kind, due_at)
  VALUES ('33333333-0000-0000-0000-000000000001', 'c3333333-0000-0000-0000-000000000001',
          'export', now() + interval '15 days')
  RETURNING id INTO pedido;

  BEGIN
    UPDATE data_requests SET status = 'refused', settled_at = now() WHERE id = pedido;
    RAISE EXCEPTION 'recusou um pedido sem motivo escrito';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6 — recusa de pedido exige motivo';
  END;

  BEGIN
    UPDATE data_requests SET status = 'done' WHERE id = pedido;
    RAISE EXCEPTION 'encerrou um pedido sem data';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6b — pedido encerrado sem data é recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 6c — o mesmo direito não abre dois pedidos ao mesmo tempo
--
-- O titular pede pelo aplicativo e a recepção registra o mesmo pedido pela
-- ficha. Duas linhas fariam o mesmo prazo ter duas respostas — e a segunda
-- reiniciaria a contagem, que **atrasa** a obrigação em vez de duplicá-la.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO data_requests (tenant_id, customer_id, kind, due_at)
  VALUES ('33333333-0000-0000-0000-000000000001', 'c3333333-0000-0000-0000-000000000001',
          'deletion', now() + interval '15 days');

  BEGIN
    INSERT INTO data_requests (tenant_id, customer_id, kind, due_at)
    VALUES ('33333333-0000-0000-0000-000000000001', 'c3333333-0000-0000-0000-000000000001',
            'deletion', now() + interval '15 days');
    RAISE EXCEPTION 'o mesmo pedido foi aberto duas vezes';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 6c — um pedido aberto por pessoa e por tipo';
  END;

  -- Encerrado, pedir de novo é direito: a pessoa pode querer outra cópia no
  -- ano seguinte. Por isso o índice é parcial em `open`.
  UPDATE data_requests SET status = 'done', settled_at = now()
   WHERE customer_id = 'c3333333-0000-0000-0000-000000000001' AND kind = 'deletion';

  INSERT INTO data_requests (tenant_id, customer_id, kind, due_at)
  VALUES ('33333333-0000-0000-0000-000000000001', 'c3333333-0000-0000-0000-000000000001',
          'deletion', now() + interval '15 days');
  RAISE NOTICE 'OK 6d — pedido novo depois de atendido é aceito';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — o consentimento de uma barbearia não é lido pela outra
-- ----------------------------------------------------------------------------
RESET ROLE;
INSERT INTO tenants (id, name) VALUES
  ('33333333-0000-0000-0000-000000000002', 'Vizinha');
INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('c3333333-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000002',
   'Outro', '+5571977776666');
INSERT INTO customer_consents (customer_id, tenant_id, purpose, granted, text_version)
VALUES ('c3333333-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000002',
        'marketing', true, 'v1');

SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '33333333-0000-0000-0000-000000000001', true);

DO $$
DECLARE visiveis int; alheios int;
BEGIN
  SELECT count(*) INTO visiveis FROM customer_consents;
  SELECT count(*) INTO alheios FROM customer_consents
   WHERE customer_id = 'c3333333-0000-0000-0000-000000000002';

  IF alheios <> 0 THEN
    RAISE EXCEPTION 'a barbearia enxerga o consentimento da vizinha';
  END IF;
  IF visiveis < 1 THEN
    RAISE EXCEPTION 'a barbearia não enxerga o próprio consentimento';
  END IF;
  RAISE NOTICE 'OK 7 — consentimento é da barbearia que o coletou';
END $$;

-- ----------------------------------------------------------------------------
-- 8 — o encarregado é da barbearia, e o e-mail é conferido
-- ----------------------------------------------------------------------------
RESET ROLE;

DO $$
BEGIN
  BEGIN
    UPDATE tenants SET dpo_email = 'nao-e-email'
     WHERE id = '33333333-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou e-mail de encarregado sem formato';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 8 — o e-mail do encarregado é conferido';
  END;
END $$;

ROLLBACK;
