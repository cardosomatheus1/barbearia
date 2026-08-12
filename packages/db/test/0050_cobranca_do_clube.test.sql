-- ============================================================================
-- Invariantes da cobrança do clube (bloco 47).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('50505050-0000-0000-0000-000000000001', 'Domari');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('50505050-3333-0000-0000-000000000001',
   '50505050-0000-0000-0000-000000000001', 'Carlos', '+5571988887777');

INSERT INTO club_plans (id, tenant_id, name, price_cents) VALUES
  ('50505050-4444-0000-0000-000000000001',
   '50505050-0000-0000-0000-000000000001', 'Premium', 14900);

INSERT INTO club_subscriptions (id, tenant_id, customer_id, plan_id, price_cents, status)
VALUES ('50505050-5555-0000-0000-000000000001',
        '50505050-0000-0000-0000-000000000001',
        '50505050-3333-0000-0000-000000000001',
        '50505050-4444-0000-0000-000000000001', 14900, 'ativa');

INSERT INTO club_invoices (
  id, tenant_id, subscription_id, period_start, period_end, amount_cents, due_at
) VALUES (
  '50505050-6666-0000-0000-000000000001',
  '50505050-0000-0000-0000-000000000001',
  '50505050-5555-0000-0000-000000000001',
  '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 14900, '2026-08-01T00:00:00Z'
);

-- ----------------------------------------------------------------------------
-- 1 — uma fatura por ciclo
--
-- Sem isto o worker emitiria uma fatura por volta do laço e o assinante seria
-- cobrado dezenas de vezes pelo mesmo mês. A recusa é do banco e não de um
-- `SELECT` antes do `INSERT`, que tem janela de corrida.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO club_invoices (
      tenant_id, subscription_id, period_start, period_end, amount_cents, due_at
    ) VALUES (
      '50505050-0000-0000-0000-000000000001',
      '50505050-5555-0000-0000-000000000001',
      '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 14900, '2026-08-01T00:00:00Z'
    );
    RAISE EXCEPTION 'aceitou duas faturas para o mesmo ciclo';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 1 — uma fatura por ciclo';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — fatura paga tem data de pagamento, e o contrário também
--
-- `status = 'paga'` sem `paid_at` é a linha que responde "sim" para "eu paguei?"
-- e nada para "quando?". A recíproca é pior: `paid_at` preenchido numa fatura
-- aberta faria a régua cobrar de novo quem já pagou.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE club_invoices SET status = 'paga'
     WHERE id = '50505050-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou fatura paga sem data de pagamento';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2a — fatura paga tem data';
  END;

  BEGIN
    UPDATE club_invoices SET paid_at = now()
     WHERE id = '50505050-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou data de pagamento em fatura aberta';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2b — data de pagamento só em fatura paga';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — id de cobrança vazio não existe
--
-- String vazia não é nulo: ela amarraria a fatura a nada para sempre, e a
-- retentativa nunca encontraria a cobrança para conferir. É a lição da 0036.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE club_invoices SET psp_charge_id = '   '
     WHERE id = '50505050-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou id de cobrança vazio';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3 — id de cobrança vazio é recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — não existe coluna para número de cartão nem para código de segurança
--
-- A validade entra por decisão escrita (o aviso de 15 dias da SPEC §4.6); o
-- número e o CVV não têm coluna, e é por isso que ninguém os preenche por
-- engano. Mesmo teste de `billing_customers` e de `order_charges`.
-- ----------------------------------------------------------------------------
DO $$
DECLARE suspeitas text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO suspeitas
    FROM information_schema.columns
   WHERE table_name IN ('club_subscriptions', 'club_invoices')
     AND column_name IN ('pan', 'card_number', 'number', 'cvv', 'cvc', 'security_code');

  IF suspeitas IS NOT NULL THEN
    RAISE EXCEPTION 'a assinatura ganhou coluna de cartão: %', suspeitas;
  END IF;
  RAISE NOTICE 'OK 4 — só token, bandeira, quatro últimos e validade';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — a suspensão é coerente com o estado
--
-- `suspensa` sem `suspended_at` seria um benefício cortado sem data, e a tela
-- não teria como dizer "desde quando". O inverso — data com estado ativo —
-- faria a tela do cliente mostrar suspensão para quem está em dia.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE club_subscriptions SET status = 'suspensa'
     WHERE id = '50505050-5555-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou suspensão sem data';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 5 — suspensão tem data';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — o cancelamento agendado tem as duas pontas
--
-- Pedido sem data de efeito é o cliente que pediu para sair e não sabe até
-- quando corta; data sem pedido é uma assinatura que expira sem ninguém ter
-- pedido nada.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE club_subscriptions SET cancel_requested_at = now()
     WHERE id = '50505050-5555-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou pedido de cancelamento sem data de efeito';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6 — o cancelamento agendado tem as duas pontas';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 7 — a fatura não é apagável
--
-- "Por que vocês me cobraram em março?" é a pergunta, e a linha é a resposta.
-- Cancelar é estado, com valor e data intactos.
-- ----------------------------------------------------------------------------
DO $$
DECLARE pode boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    SELECT has_table_privilege('barbearia_app', 'club_invoices', 'DELETE') INTO pode;
    IF pode THEN
      RAISE EXCEPTION 'a aplicação pode apagar fatura do clube';
    END IF;
    RAISE NOTICE 'OK 7 — a fatura do clube é append-only para a aplicação';
  ELSE
    RAISE NOTICE 'PULADO 7 — sem o role da aplicação neste banco';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 8 — a fatura tem RLS forçada
-- ----------------------------------------------------------------------------
DO $$
DECLARE forcada boolean;
BEGIN
  SELECT relrowsecurity AND relforcerowsecurity INTO forcada
    FROM pg_class WHERE relname = 'club_invoices';
  IF NOT coalesce(forcada, false) THEN
    RAISE EXCEPTION 'club_invoices sem RLS forçada';
  END IF;
  RAISE NOTICE 'OK 8 — club_invoices com RLS forçada';
END $$;

-- ----------------------------------------------------------------------------
-- 9 — toda coluna de cartão da assinatura é apagada pela anonimização
--
-- Varredura de catálogo, e é a ferramenta certa **aqui** pelo mesmo motivo da
-- varredura de `customers` do bloco 37: o que se quer pegar é a coluna que
-- ninguém pensou. Credencial de pagamento é como token de sessão — some com a
-- pessoa —, e a coluna nova que alguém adicionar daqui a dez blocos nasce
-- coberta sem ninguém lembrar.
--
-- Achado da `/security-review` deste bloco: as colunas entraram e a função de
-- anonimização não foi atualizada, deixando um token cobrável amarrado a um
-- cadastro que a pessoa pediu para apagar.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  faltando text;
  corpo text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO corpo
    FROM pg_proc p WHERE p.proname = 'anonimizar_cliente';

  SELECT string_agg(column_name, ', ') INTO faltando
    FROM information_schema.columns
   WHERE table_name = 'club_subscriptions'
     AND (column_name LIKE 'card\_%' OR column_name = 'payment_token')
     AND position(column_name || ' = NULL' in corpo) = 0;

  IF faltando IS NOT NULL THEN
    RAISE EXCEPTION 'anonimizar_cliente não apaga: %', faltando;
  END IF;
  RAISE NOTICE 'OK 9 — a anonimização leva todo dado de cartão junto';
END $$;

ROLLBACK;
