-- ============================================================================
-- Invariantes da amarração da cobrança (bloco 34).
--
-- Uma coisa só, e ela custou um achado de revisão de segurança: string vazia
-- em `invoices.psp_charge_id` não é "sem cobrança", é uma amarração para nada
-- que **nenhuma tentativa posterior consegue desfazer** — o `UPDATE` que amarra
-- exige `psp_charge_id IS NULL`. A fatura seguiria sendo cobrada, o webhook da
-- cobrança que desse certo procuraria a fatura por um id que ninguém guardou, e
-- a barbearia seria suspensa por uma fatura que pagou.
--
-- O código já não escreve mais vazio. Isto é a outra metade: garantia do banco
-- em vez de convenção de revisão.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES ('36363636-0000-0000-0000-000000000001', 'Domari');

INSERT INTO invoices
  (id, tenant_id, kind, status, plan_code, amount_cents, due_at, period_start, period_end)
VALUES
  ('36363636-1111-0000-0000-000000000001', '36363636-0000-0000-0000-000000000001',
   'subscription', 'open', 'pro', 9900,
   now(), now(), now() + interval '30 days');

-- ----------------------------------------------------------------------------
-- 1 — `psp_charge_id` vazio é recusado
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE invoices SET psp_charge_id = ''
     WHERE id = '36363636-1111-0000-0000-000000000001';
    RAISE EXCEPTION 'a fatura aceitou id de cobrança vazio';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1 — id de cobrança vazio recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — só espaço também é vazio
--
-- `btrim` no `CHECK` porque " " passaria por `length > 0` e produziria
-- exatamente o mesmo travamento, com a vantagem de ser invisível na tela.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE invoices SET psp_charge_id = '   '
     WHERE id = '36363636-1111-0000-0000-000000000001';
    RAISE EXCEPTION 'a fatura aceitou id de cobrança só com espaço';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2 — id só com espaço recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — nulo continua sendo o estado legítimo de "ainda não amarrada"
--
-- A constraint não pode transformar "sem cobrança em curso" em erro: é esse o
-- estado de toda fatura recém-emitida, e é ele que a régua lê para decidir
-- retentar.
-- ----------------------------------------------------------------------------
DO $$
DECLARE amarradas integer;
BEGIN
  UPDATE invoices SET psp_charge_id = NULL
   WHERE id = '36363636-1111-0000-0000-000000000001';

  SELECT count(*) INTO amarradas FROM invoices
   WHERE id = '36363636-1111-0000-0000-000000000001' AND psp_charge_id IS NULL;

  IF amarradas <> 1 THEN
    RAISE EXCEPTION 'nulo deixou de ser aceito em psp_charge_id';
  END IF;
  RAISE NOTICE 'OK 3 — nulo continua sendo "ainda não amarrada"';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — o mesmo para o estorno
--
-- `psp_refund_id` vazio seria um estorno marcado como confirmado sem nada a que
-- se referir — dinheiro dado como devolvido sem prova do outro lado.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO refunds (id, tenant_id, amount_cents, reason)
  VALUES ('36363636-2222-0000-0000-000000000001',
          '36363636-0000-0000-0000-000000000001', 5000, 'devolução');

  BEGIN
    UPDATE refunds SET psp_refund_id = ''
     WHERE id = '36363636-2222-0000-0000-000000000001';
    RAISE EXCEPTION 'o estorno aceitou id vazio';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4 — id de estorno vazio recusado';
  END;
END $$;

ROLLBACK;
