-- ============================================================================
-- Invariantes da fatura (bloco 28).
--
-- Duas famílias: o que o banco recusa a gravar (fatura incoerente) e o que ele
-- recusa a mostrar (extrato da barbearia vizinha).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('30303030-0000-0000-0000-000000000001', 'Domari'),
  ('30303030-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO invoices (tenant_id, plan_code, amount_cents, period_start, period_end, due_at)
VALUES
  ('30303030-0000-0000-0000-000000000001', 'pro', 9900,
   '2026-03-01T00:00:00Z', '2026-03-31T00:00:00Z', '2026-03-05T00:00:00Z'),
  ('30303030-0000-0000-0000-000000000002', 'pro', 9900,
   '2026-03-01T00:00:00Z', '2026-03-31T00:00:00Z', '2026-03-05T00:00:00Z');

-- ----------------------------------------------------------------------------
-- 1 — uma mensalidade por período, garantido pelo índice
--
-- A régua roda todo dia e pode rodar duas vezes no mesmo dia. A segunda volta
-- não pode emitir a segunda fatura do mesmo mês.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO invoices (tenant_id, plan_code, amount_cents, period_start, period_end, due_at)
    VALUES ('30303030-0000-0000-0000-000000000001', 'pro', 9900,
            '2026-03-01T00:00:00Z', '2026-03-31T00:00:00Z', '2026-03-05T00:00:00Z');
    RAISE EXCEPTION 'a barbearia foi cobrada duas vezes pelo mesmo mês';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 1 — uma mensalidade por período';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — o acerto de rateio não cai no mesmo índice
--
-- Trocar de plano duas vezes no mesmo período gera duas linhas legítimas, e
-- barrá-las faria a segunda troca sair sem cobrança nenhuma.
-- ----------------------------------------------------------------------------
INSERT INTO invoices (tenant_id, kind, plan_code, amount_cents, period_start, period_end, due_at)
VALUES
  ('30303030-0000-0000-0000-000000000001', 'proration', 'business', 7500,
   '2026-03-01T00:00:00Z', '2026-03-31T00:00:00Z', '2026-03-16T00:00:00Z'),
  ('30303030-0000-0000-0000-000000000001', 'proration', 'pro', 2500,
   '2026-03-01T00:00:00Z', '2026-03-31T00:00:00Z', '2026-03-20T00:00:00Z');

DO $$
BEGIN
  RAISE NOTICE 'OK 2 — dois acertos de rateio cabem no mesmo período';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — fatura paga sem data, e data de pagamento sem baixa, são recusadas
--
-- A segunda é a pior: `paid_at` preenchido com status `open` deixaria a régua
-- cobrando de novo algo que já foi pago.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE invoices SET status = 'paid'
     WHERE tenant_id = '30303030-0000-0000-0000-000000000001' AND kind = 'subscription';
    RAISE EXCEPTION 'aceitou fatura paga sem data';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3 — fatura paga sem data é recusada';
  END;

  BEGIN
    UPDATE invoices SET paid_at = now()
     WHERE tenant_id = '30303030-0000-0000-0000-000000000001' AND kind = 'subscription';
    RAISE EXCEPTION 'aceitou data de pagamento numa fatura em cobrança';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3b — data de pagamento sem baixa é recusada';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — cancelar exige motivo escrito
--
-- Mesma decisão do bloqueio (bloco 24): é o que o suporte lê quando o dono
-- liga, e uma fatura perdoada sem motivo vira discussão sem registro.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE invoices SET status = 'void', voided_at = now()
     WHERE tenant_id = '30303030-0000-0000-0000-000000000001' AND kind = 'subscription';
    RAISE EXCEPTION 'cancelou fatura sem motivo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4 — cancelamento de fatura exige motivo';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — fatura não nasce vencida por erro de digitação
--
-- Vencimento antes do período que ele cobra levaria a régua ao bloqueio na
-- primeira volta: a barbearia sairia do ar por um erro de quem emitiu.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO invoices (tenant_id, plan_code, amount_cents, period_start, period_end, due_at)
    VALUES ('30303030-0000-0000-0000-000000000002', 'pro', 9900,
            '2026-04-01T00:00:00Z', '2026-04-30T00:00:00Z', '2026-01-01T00:00:00Z');
    RAISE EXCEPTION 'aceitou fatura que nasce vencida';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 5 — vencimento anterior ao período é recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — o crédito da descida de plano não fica negativo
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE subscriptions SET credit_cents = -1
     WHERE tenant_id = '30303030-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou crédito negativo, que é dívida com outro nome';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6 — crédito da assinatura não fica negativo';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 7 — plano com fatura emitida não some do catálogo
--
-- Apagar reescreveria o histórico de quanto a barbearia pagou. Desativar é a
-- operação desenhada para isso desde o bloco 24.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    DELETE FROM plans WHERE code = 'business';
    RAISE EXCEPTION 'apagou plano com fatura emitida';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'OK 7 — plano com fatura dentro não é apagado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 8 — a barbearia lê o próprio extrato e não o da vizinha
--
-- Mais estrito que `subscriptions`, que abriu leitura geral por não guardar
-- nada além de plano e preço de tabela. Aqui há histórico de pagamento.
-- ----------------------------------------------------------------------------
SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '30303030-0000-0000-0000-000000000001', true);

DO $$
DECLARE minhas int; total int;
BEGIN
  SELECT count(*) INTO minhas FROM invoices
   WHERE tenant_id = '30303030-0000-0000-0000-000000000001';
  SELECT count(*) INTO total FROM invoices;

  IF minhas < 1 THEN
    RAISE EXCEPTION 'a barbearia não enxerga o próprio extrato';
  END IF;
  IF total <> minhas THEN
    RAISE EXCEPTION 'a barbearia enxerga % faturas e só % são dela', total, minhas;
  END IF;
  RAISE NOTICE 'OK 8 — o extrato de uma barbearia não é lido pela outra';
END $$;

-- ----------------------------------------------------------------------------
-- 9 — e não se dá baixa sozinha
--
-- A recusa é silenciosa, como todo UPDATE cujo `USING` não casa: a linha não é
-- vista e o comando altera zero. O que importa é que a fatura continue aberta.
-- ----------------------------------------------------------------------------
DO $$
DECLARE alteradas int; estado invoice_status;
BEGIN
  UPDATE invoices SET status = 'paid', paid_at = now(), paid_method = 'confia'
   WHERE tenant_id = '30303030-0000-0000-0000-000000000001';
  GET DIAGNOSTICS alteradas = ROW_COUNT;

  SELECT status INTO estado FROM invoices
   WHERE tenant_id = '30303030-0000-0000-0000-000000000001' AND kind = 'subscription';

  IF alteradas <> 0 OR estado <> 'open' THEN
    RAISE EXCEPTION 'a barbearia deu baixa na própria fatura (% linha[s], estado %)',
      alteradas, estado;
  END IF;
  RAISE NOTICE 'OK 9 — a barbearia lê a fatura e não se dá baixa';
END $$;

-- ----------------------------------------------------------------------------
-- 10 — nem emite uma para si mesma com o valor que quiser
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO invoices (tenant_id, plan_code, amount_cents, period_start, period_end, due_at)
    VALUES ('30303030-0000-0000-0000-000000000001', 'starter', 0,
            '2026-05-01T00:00:00Z', '2026-05-31T00:00:00Z', '2026-05-05T00:00:00Z');
    RAISE EXCEPTION 'a barbearia emitiu a própria fatura';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 10 — a barbearia não emite fatura';
  END;
END $$;

ROLLBACK;
