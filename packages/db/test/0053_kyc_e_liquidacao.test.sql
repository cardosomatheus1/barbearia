-- ============================================================================
-- Invariantes do KYC e da liquidação (bloco 50).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('53535353-0000-0000-0000-000000000001', 'Domari');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('53535353-1111-0000-0000-000000000001',
   '53535353-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia');

INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
  ('53535353-2222-0000-0000-000000000001',
   '53535353-0000-0000-0000-000000000001',
   '53535353-1111-0000-0000-000000000001', 'Ruan');

INSERT INTO orders (id, tenant_id, location_id, status, business_day, closed_at)
VALUES ('53535353-7777-0000-0000-000000000001',
        '53535353-0000-0000-0000-000000000001',
        '53535353-1111-0000-0000-000000000001', 'paid', current_date, now());

INSERT INTO order_charges
  (id, tenant_id, location_id, order_id, method, amount_cents, status,
   created_by_name, paid_at, psp_payment_id)
VALUES ('53535353-8888-0000-0000-000000000001',
        '53535353-0000-0000-0000-000000000001',
        '53535353-1111-0000-0000-000000000001',
        '53535353-7777-0000-0000-000000000001', 'pix', 10000, 'pago',
        'Matheus', now(), 'pay_teste_53');

INSERT INTO payment_splits
  (id, tenant_id, order_id, charge_id, party, professional_id, amount_cents, status)
VALUES ('53535353-9999-0000-0000-000000000001',
        '53535353-0000-0000-0000-000000000001',
        '53535353-7777-0000-0000-000000000001',
        '53535353-8888-0000-0000-000000000001', 'profissional',
        '53535353-2222-0000-0000-000000000001', 4000, 'pendente');

-- ----------------------------------------------------------------------------
-- 1 — o profissional nasce sem cadastro no adquirente
--
-- E isso não é falha: é o estado da esmagadora maioria. *"Enquanto pendente, o
-- pagamento cai integralmente na barbearia e a comissão é paga fora, **sem
-- bloquear a venda**."* O KYC muda por onde ele recebe, nunca se a venda
-- acontece.
-- ----------------------------------------------------------------------------
DO $$
DECLARE estado text;
BEGIN
  SELECT psp_kyc_status::text INTO estado
    FROM professionals WHERE id = '53535353-2222-0000-0000-000000000001';
  IF estado <> 'ausente' THEN
    RAISE EXCEPTION 'profissional novo nasceu com KYC %', estado;
  END IF;
  RAISE NOTICE 'OK 1 — o profissional nasce sem cadastro, e isso é normal';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — aprovado exige recebedor
--
-- "Aprovado" sem id é um profissional que a régua escolheria para repassar e
-- para o qual não há para onde mandar — e a falha apareceria na chamada ao
-- adquirente, longe de onde a causa está.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE professionals SET psp_kyc_status = 'aprovado'
     WHERE id = '53535353-2222-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou aprovado sem recebedor';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2 — aprovado tem recebedor';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — não existe coluna para dado bancário do profissional
--
-- Documento, agência e conta atravessam para o adquirente, que é quem tem
-- obrigação regulatória de guardá-los. Aqui fica a referência opaca, pela mesma
-- razão do token do cartão — e coluna que não existe não é preenchida por
-- engano.
-- ----------------------------------------------------------------------------
DO $$
DECLARE suspeitas text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO suspeitas
    FROM information_schema.columns
   WHERE table_name = 'professionals'
     AND column_name IN ('cpf', 'cnpj', 'documento', 'document', 'bank_account',
                         'agencia', 'agency', 'conta', 'account_number', 'iban', 'pix_key');

  IF suspeitas IS NOT NULL THEN
    RAISE EXCEPTION 'o profissional ganhou coluna de dado bancário: %', suspeitas;
  END IF;
  RAISE NOTICE 'OK 3 — só a referência opaca do adquirente';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — a tentativa de repasse tem desfecho coerente
--
-- Um repasse "ok" sem id é uma transferência que ninguém rastreia no extrato do
-- adquirente — e é justamente o extrato que o barbeiro traz quando diz que não
-- recebeu.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO split_transfers (tenant_id, split_id, amount_cents, ok)
    VALUES ('53535353-0000-0000-0000-000000000001',
            '53535353-9999-0000-0000-000000000001', 4000, true);
    RAISE EXCEPTION 'aceitou repasse aceito sem id no adquirente';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4a — repasse aceito tem id';
  END;

  BEGIN
    INSERT INTO split_transfers (tenant_id, split_id, amount_cents, ok)
    VALUES ('53535353-0000-0000-0000-000000000001',
            '53535353-9999-0000-0000-000000000001', 4000, false);
    RAISE EXCEPTION 'aceitou repasse recusado sem motivo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4b — repasse recusado tem motivo';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — a tentativa de repasse é append-only, e não é editável
--
-- Ela é o que se mostra quando o barbeiro pergunta por que não recebeu. Uma
-- linha reescrita responderia a pergunta de hoje e apagaria a de ontem.
-- ----------------------------------------------------------------------------
DO $$
DECLARE pode_apagar boolean; pode_editar boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    SELECT has_table_privilege('barbearia_app', 'split_transfers', 'DELETE'),
           has_table_privilege('barbearia_app', 'split_transfers', 'UPDATE')
      INTO pode_apagar, pode_editar;
    IF pode_apagar OR pode_editar THEN
      RAISE EXCEPTION 'a aplicação pode mexer numa tentativa de repasse';
    END IF;
    RAISE NOTICE 'OK 5 — a tentativa de repasse é append-only';
  ELSE
    RAISE NOTICE 'PULADO 5 — sem o role da aplicação neste banco';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — nenhuma chave da tentativa destrói a linha em cascata
--
-- Mesma razão do bloco 49, e a varredura é de catálogo: a chave nova que alguém
-- adicionar amanhã nasce coberta. `tenant_id` é a exceção de sempre.
-- ----------------------------------------------------------------------------
DO $$
DECLARE ruins text;
BEGIN
  SELECT string_agg(conname, ', ') INTO ruins
    FROM pg_constraint
   WHERE conrelid = 'split_transfers'::regclass
     AND contype = 'f' AND confdeltype = 'c'
     AND conname <> 'split_transfers_tenant_id_fkey';

  IF ruins IS NOT NULL THEN
    RAISE EXCEPTION 'a tentativa de repasse tem chave com CASCADE: %', ruins;
  END IF;
  RAISE NOTICE 'OK 6 — nenhuma chave da tentativa destrói a linha em cascata';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — RLS forçada
-- ----------------------------------------------------------------------------
DO $$
DECLARE forcada boolean;
BEGIN
  SELECT relrowsecurity AND relforcerowsecurity INTO forcada
    FROM pg_class WHERE relname = 'split_transfers';
  IF NOT coalesce(forcada, false) THEN
    RAISE EXCEPTION 'split_transfers sem RLS forçada';
  END IF;
  RAISE NOTICE 'OK 7 — split_transfers com RLS forçada';
END $$;

ROLLBACK;
