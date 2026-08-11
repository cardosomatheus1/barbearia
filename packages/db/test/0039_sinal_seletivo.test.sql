-- ============================================================================
-- Invariantes do sinal seletivo (bloco 37).
--
-- O que se prova aqui é o que o teste de integração não alcança: que o banco
-- recusa a política incoerente em vez de deixá-la virar um QR Code de R$ 0,00,
-- que o carimbo de cancelamento não aparece em agendamento vivo, e que o
-- override do score não entra sem motivo escrito.
--
-- O padrão também é invariante, e é o mais importante deles: **nenhuma
-- barbearia já instalada passa a cobrar sinal por causa de uma migração.**
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('39393939-0000-0000-0000-000000000001', 'Domari');

INSERT INTO locations (id, tenant_id, name, timezone)
VALUES ('39393939-1111-0000-0000-000000000001',
        '39393939-0000-0000-0000-000000000001', 'Centro', 'America/Bahia');

-- ----------------------------------------------------------------------------
-- 1 — o padrão é não cobrar
--
-- Configuração que mexe em dinheiro nasce com o comportamento anterior. Um
-- padrão diferente faria toda barbearia instalada começar a pedir sinal do
-- cliente no dia da migração, sem ninguém ter decidido nada.
-- ----------------------------------------------------------------------------
DO $$
DECLARE modo text; prazo smallint; limiar smallint;
BEGIN
  SELECT deposit_mode, deposit_refund_hours, deposit_score_threshold
    INTO modo, prazo, limiar
    FROM locations WHERE id = '39393939-1111-0000-0000-000000000001';

  IF modo <> 'nenhum' THEN
    RAISE EXCEPTION 'padrão do sinal deveria ser nenhum, veio %', modo;
  END IF;
  IF prazo <> 24 THEN
    RAISE EXCEPTION 'prazo de reembolso padrão deveria ser 24h, veio %', prazo;
  END IF;
  IF limiar <> 60 THEN
    RAISE EXCEPTION 'limiar padrão deveria ser 60 (SPEC §2.13), veio %', limiar;
  END IF;
  RAISE NOTICE 'OK 1 — o padrão é não cobrar sinal';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — modalidade sem valor é recusada
--
-- Sinal "fixo" de zero real produziria um agendamento que a tela diz exigir
-- pagamento e uma cobrança de nada. O banco recusa a combinação.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE locations SET deposit_mode = 'fixo'
     WHERE id = '39393939-1111-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou sinal fixo sem valor';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2a — fixo sem valor recusado';
  END;

  BEGIN
    UPDATE locations SET deposit_mode = 'percentual'
     WHERE id = '39393939-1111-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou percentual sem alíquota';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2b — percentual sem alíquota recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — a política aceita valores sãos e recusa os absurdos
-- ----------------------------------------------------------------------------
UPDATE locations
   SET deposit_mode = 'percentual', deposit_percent_bps = 3000,
       deposit_ticket_over_cents = 20000
 WHERE id = '39393939-1111-0000-0000-000000000001';

DO $$
BEGIN
  BEGIN
    -- 150% de sinal: o cliente pagaria adiantado mais do que o serviço custa.
    UPDATE locations SET deposit_percent_bps = 15000
     WHERE id = '39393939-1111-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou percentual acima de 100%%';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3a — percentual acima de 100%% recusado';
  END;

  BEGIN
    UPDATE locations SET deposit_score_threshold = 120
     WHERE id = '39393939-1111-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou limiar fora de 0..100';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3b — limiar fora da escala recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — o carimbo de cancelamento só existe em agendamento cancelado
--
-- Sem isto, um `UPDATE status` que esquecesse a coluna produziria cancelamento
-- sem antecedência conhecida em cima de dado novo — e o buraco passaria por
-- "agendamento antigo" para sempre.
-- ----------------------------------------------------------------------------
INSERT INTO professionals (id, tenant_id, location_id, name)
VALUES ('39393939-2222-0000-0000-000000000001',
        '39393939-0000-0000-0000-000000000001',
        '39393939-1111-0000-0000-000000000001', 'Ruan');

INSERT INTO appointments
  (id, tenant_id, location_id, professional_id,
   starts_at, ends_at, service_starts_at, service_ends_at)
VALUES ('39393939-3333-0000-0000-000000000001',
        '39393939-0000-0000-0000-000000000001',
        '39393939-1111-0000-0000-000000000001',
        '39393939-2222-0000-0000-000000000001',
        now(), now() + interval '30 min', now(), now() + interval '30 min');

DO $$
BEGIN
  BEGIN
    UPDATE appointments SET cancelled_at = now()
     WHERE id = '39393939-3333-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou carimbo de cancelamento em agendamento vivo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4a — carimbo recusado em agendamento não cancelado';
  END;

  UPDATE appointments
     SET status = 'cancelled_customer', cancelled_at = now()
   WHERE id = '39393939-3333-0000-0000-000000000001';
  RAISE NOTICE 'OK 4b — cancelado com carimbo aceito';
END $$;

-- ----------------------------------------------------------------------------
-- 4c — sinal com valor e sem motivo é recusado, e vice-versa
--
-- Valor sem motivo é uma cobrança que ninguém sabe defender no balcão; motivo
-- sem valor é a explicação de uma cobrança que não existe. Os dois andam juntos
-- ou nenhum existe.
-- ----------------------------------------------------------------------------
INSERT INTO appointments
  (id, tenant_id, location_id, professional_id,
   starts_at, ends_at, service_starts_at, service_ends_at)
VALUES ('39393939-3333-0000-0000-000000000002',
        '39393939-0000-0000-0000-000000000001',
        '39393939-1111-0000-0000-000000000001',
        '39393939-2222-0000-0000-000000000001',
        now(), now() + interval '30 min', now(), now() + interval '30 min');

DO $$
BEGIN
  BEGIN
    UPDATE appointments SET deposit_required_cents = 2000
     WHERE id = '39393939-3333-0000-0000-000000000002';
    RAISE EXCEPTION 'aceitou sinal sem motivo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4c — sinal sem motivo recusado';
  END;

  BEGIN
    UPDATE appointments SET deposit_reason = 'score'
     WHERE id = '39393939-3333-0000-0000-000000000002';
    RAISE EXCEPTION 'aceitou motivo sem sinal';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4d — motivo sem sinal recusado';
  END;

  BEGIN
    UPDATE appointments SET deposit_required_cents = 2000, deposit_reason = 'porque sim'
     WHERE id = '39393939-3333-0000-0000-000000000002';
    RAISE EXCEPTION 'aceitou motivo fora do vocabulário';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4e — motivo desconhecido recusado';
  END;

  UPDATE appointments SET deposit_required_cents = 2000, deposit_reason = 'score'
   WHERE id = '39393939-3333-0000-0000-000000000002';
  RAISE NOTICE 'OK 4f — sinal com motivo conhecido aceito';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — override do score exige motivo escrito
--
-- A SPEC pede justificativa auditada, não só auditoria. Um número sem motivo é
-- algo que ninguém consegue defender seis meses depois — e o gerente que o pôs
-- pode nem trabalhar mais ali.
-- ----------------------------------------------------------------------------
INSERT INTO customers (id, tenant_id, name, phone_e164)
VALUES ('39393939-4444-0000-0000-000000000001',
        '39393939-0000-0000-0000-000000000001', 'Carlos', '+5571988887777');

DO $$
BEGIN
  BEGIN
    UPDATE customers SET reliability_override = 100
     WHERE id = '39393939-4444-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou override sem motivo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 5a — override sem motivo recusado';
  END;

  BEGIN
    UPDATE customers
       SET reliability_override = 100, reliability_override_reason = 'ok',
           reliability_override_at = now()
     WHERE id = '39393939-4444-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou motivo de duas letras';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 5b — motivo curto demais recusado';
  END;

  BEGIN
    UPDATE customers SET reliability_override = 200,
           reliability_override_reason = 'ficou preso no trânsito, foi engano nosso',
           reliability_override_at = now()
     WHERE id = '39393939-4444-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou score fora de 0..100';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 5c — override fora da escala recusado';
  END;

  UPDATE customers
     SET reliability_override = 100,
         reliability_override_reason = 'faltou por internação, comprovada na recepção',
         reliability_override_at = now()
   WHERE id = '39393939-4444-0000-0000-000000000001';
  RAISE NOTICE 'OK 5d — override com motivo escrito aceito';
END $$;

-- ----------------------------------------------------------------------------
-- 6 — o índice do histórico existe
--
-- O score é consultado **na marcação**, com o cliente esperando a grade. Sem o
-- índice a consulta varre a tabela inteira da barbearia (CLAUDE.md §3: índice
-- junto com a query que o exige).
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'appointments'
       AND indexname = 'appointments_historico_do_cliente_idx'
  ) THEN
    RAISE EXCEPTION 'falta o índice do histórico do cliente';
  END IF;
  RAISE NOTICE 'OK 6 — índice do histórico presente';
END $$;

ROLLBACK;
