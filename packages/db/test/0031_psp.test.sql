-- ============================================================================
-- Invariantes do adquirente (bloco 29).
--
-- Duas famílias, e a segunda é a que o bloco existe para garantir: **entrega
-- duplicada não move dinheiro duas vezes**.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('31313131-0000-0000-0000-000000000001', 'Domari'),
  ('31313131-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO billing_customers (tenant_id, psp_customer_id, psp_method_id, brand, last4,
                               exp_month, exp_year)
VALUES
  ('31313131-0000-0000-0000-000000000001', 'cus_1', 'pm_1', 'visa', '4242', 12, 2030),
  ('31313131-0000-0000-0000-000000000002', 'cus_2', 'pm_2', 'elo', '1881', 6, 2029);

INSERT INTO invoices (id, tenant_id, plan_code, amount_cents, period_start, period_end,
                      due_at, psp_charge_id)
VALUES ('f1313131-0000-0000-0000-000000000001', '31313131-0000-0000-0000-000000000001',
        'pro', 9900, '2026-03-01T00:00:00Z', '2026-03-31T00:00:00Z',
        '2026-03-05T00:00:00Z', 'ch_1');

-- ----------------------------------------------------------------------------
-- 1 — não existe onde guardar número de cartão
--
-- A garantia não é uma regra, é a ausência de coluna. Este teste falha no dia
-- em que alguém acrescentar uma.
-- ----------------------------------------------------------------------------
DO $$
DECLARE proibidas text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO proibidas
    FROM information_schema.columns
   WHERE table_name = 'billing_customers'
     AND column_name IN ('pan', 'card_number', 'number', 'cvv', 'cvc', 'security_code');

  IF proibidas IS NOT NULL THEN
    RAISE EXCEPTION 'billing_customers ganhou coluna de cartão em claro: %', proibidas;
  END IF;
  RAISE NOTICE 'OK 1 — não há onde guardar número de cartão';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — e o final é conferido no formato
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE billing_customers SET last4 = '4111111111111111'
     WHERE tenant_id = '31313131-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou dezesseis dígitos no campo dos quatro últimos';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2 — só quatro dígitos entram em last4';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — o evento do adquirente entra uma vez só
--
-- É a trava contra reentrega, que o provedor faz por desenho. Sem ela, o mesmo
-- webhook quitaria a fatura duas vezes.
-- ----------------------------------------------------------------------------
INSERT INTO psp_events (event_id, type, payload)
VALUES ('evt_1', 'charge.paid', '{"chargeId":"ch_1"}'::jsonb);

DO $$
DECLARE gravadas int;
BEGIN
  INSERT INTO psp_events (event_id, type, payload)
  VALUES ('evt_1', 'charge.paid', '{"chargeId":"ch_1"}'::jsonb)
  ON CONFLICT (event_id) DO NOTHING;
  GET DIAGNOSTICS gravadas = ROW_COUNT;

  IF gravadas <> 0 THEN
    RAISE EXCEPTION 'a reentrega do mesmo evento foi gravada de novo';
  END IF;
  RAISE NOTICE 'OK 3 — entrega duplicada não vira segundo evento';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — duas faturas não apontam para a mesma cobrança
--
-- Se apontassem, um pagamento quitaria as duas.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO invoices (tenant_id, plan_code, amount_cents, period_start, period_end,
                          due_at, psp_charge_id)
    VALUES ('31313131-0000-0000-0000-000000000002', 'pro', 9900,
            '2026-03-01T00:00:00Z', '2026-03-31T00:00:00Z', '2026-03-05T00:00:00Z', 'ch_1');
    RAISE EXCEPTION 'duas faturas ficaram com a mesma cobrança';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 4 — uma cobrança pertence a uma fatura só';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — estorno exige motivo escrito e valor positivo
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO refunds (tenant_id, amount_cents, reason)
    VALUES ('31313131-0000-0000-0000-000000000001', 5000, '  ');
    RAISE EXCEPTION 'estornou sem motivo escrito';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 5 — estorno sem motivo é recusado';
  END;

  BEGIN
    INSERT INTO refunds (tenant_id, amount_cents, reason)
    VALUES ('31313131-0000-0000-0000-000000000001', 0, 'devolução acordada');
    RAISE EXCEPTION 'estornou zero';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 5b — estorno de valor não positivo é recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — estorno confirmado tem data
-- ----------------------------------------------------------------------------
INSERT INTO refunds (id, tenant_id, amount_cents, reason)
VALUES ('e1313131-0000-0000-0000-000000000001', '31313131-0000-0000-0000-000000000001',
        7500, 'desceu de plano e pediu de volta');

DO $$
BEGIN
  BEGIN
    UPDATE refunds SET status = 'done'
     WHERE id = 'e1313131-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'confirmou estorno sem data';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6 — estorno confirmado sem data é recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 7 — a aplicação escreve o desfecho do estorno e mais nada
--
-- `GRANT` por coluna: valor, motivo, barbearia e autor são imutáveis pela
-- aplicação; só as três colunas do desfecho aceitam escrita.
-- ----------------------------------------------------------------------------
SET LOCAL ROLE barbearia_app;

DO $$
BEGIN
  UPDATE refunds SET psp_refund_id = 're_1', status = 'done', settled_at = now()
   WHERE id = 'e1313131-0000-0000-0000-000000000001';
  RAISE NOTICE 'OK 7 — a aplicação grava o desfecho do estorno';

  BEGIN
    UPDATE refunds SET amount_cents = 999999
     WHERE id = 'e1313131-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'a aplicação reescreveu o valor de um estorno';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 7b — e não reescreve o valor';
  END;

  BEGIN
    DELETE FROM refunds WHERE id = 'e1313131-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'a aplicação apagou um estorno';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 7c — nem apaga';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 8 — a barbearia lê o próprio cartão e o próprio estorno, nunca o da vizinha
-- ----------------------------------------------------------------------------
SELECT set_config('app.tenant_id', '31313131-0000-0000-0000-000000000001', true);

DO $$
DECLARE cartoes int; estornos int;
BEGIN
  SELECT count(*) INTO cartoes FROM billing_customers;
  SELECT count(*) INTO estornos FROM refunds;

  IF cartoes <> 1 THEN
    RAISE EXCEPTION 'a barbearia enxerga % cartões', cartoes;
  END IF;
  IF estornos <> 1 THEN
    RAISE EXCEPTION 'a barbearia enxerga % estornos', estornos;
  END IF;
  RAISE NOTICE 'OK 8 — cartão e estorno são lidos só por quem é dono';
END $$;

-- ----------------------------------------------------------------------------
-- 9 — e não troca o próprio cartão por conta própria
--
-- Quem decide o meio de pagamento da cobrança é a plataforma. A recusa no
-- UPDATE é silenciosa, como toda RLS cujo `USING` não casa.
-- ----------------------------------------------------------------------------
DO $$
DECLARE alteradas int; final_ text;
BEGIN
  UPDATE billing_customers SET last4 = '0000'
   WHERE tenant_id = '31313131-0000-0000-0000-000000000001';
  GET DIAGNOSTICS alteradas = ROW_COUNT;

  SELECT last4 INTO final_ FROM billing_customers
   WHERE tenant_id = '31313131-0000-0000-0000-000000000001';

  IF alteradas <> 0 OR final_ <> '4242' THEN
    RAISE EXCEPTION 'a barbearia trocou o próprio cartão (% linha[s], final %)',
      alteradas, final_;
  END IF;
  RAISE NOTICE 'OK 9 — a barbearia lê o cartão e não o troca';
END $$;

-- ----------------------------------------------------------------------------
-- 10 — o evento bruto do adquirente é invisível para a barbearia
--
-- Mais fechado que a fatura de propósito: o extrato é dela, o identificador do
-- provedor é nosso.
-- ----------------------------------------------------------------------------
DO $$
DECLARE eventos int;
BEGIN
  SELECT count(*) INTO eventos FROM psp_events;
  IF eventos <> 0 THEN
    RAISE EXCEPTION 'a barbearia enxerga % eventos do adquirente', eventos;
  END IF;
  RAISE NOTICE 'OK 10 — o evento do adquirente não é lido pela barbearia';
END $$;

ROLLBACK;
