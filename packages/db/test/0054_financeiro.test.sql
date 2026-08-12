-- ============================================================================
-- Invariantes do financeiro (bloco 51).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('54545454-0000-0000-0000-000000000001', 'Domari'),
  ('54545454-0000-0000-0000-000000000002', 'Outra');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('54545454-1111-0000-0000-000000000001',
   '54545454-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia');

INSERT INTO financial_categories (id, tenant_id, name, direction) VALUES
  ('54545454-2222-0000-0000-000000000001',
   '54545454-0000-0000-0000-000000000001', 'Aluguel', 'pagar');

INSERT INTO financial_accounts (id, tenant_id, location_id, name, is_cash) VALUES
  ('54545454-3333-0000-0000-000000000001',
   '54545454-0000-0000-0000-000000000001',
   '54545454-1111-0000-0000-000000000001', 'Gaveta da Matriz', true),
  ('54545454-3333-0000-0000-000000000002',
   '54545454-0000-0000-0000-000000000001', NULL, 'Banco', false);

INSERT INTO bills
  (id, tenant_id, location_id, direction, description, category_id,
   amount_cents, due_on, created_by_name)
VALUES ('54545454-4444-0000-0000-000000000001',
        '54545454-0000-0000-0000-000000000001',
        '54545454-1111-0000-0000-000000000001', 'pagar', 'Aluguel do salão',
        '54545454-2222-0000-0000-000000000001', 250000, current_date, 'Matheus');

-- ----------------------------------------------------------------------------
-- 1 — "paga" sem dia e sem valor não existe
--
-- Uma linha que responde "sim" para "já pagamos?" e nada para "quando?" é
-- inútil justamente na conversa em que ela seria usada: o fornecedor ligando
-- para cobrar de novo.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE bills SET status = 'paga'
     WHERE id = '54545454-4444-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou conta paga sem dia nem valor';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1a — conta paga tem dia e valor';
  END;

  BEGIN
    UPDATE bills SET paid_on = current_date, paid_cents = 250000
     WHERE id = '54545454-4444-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou dia e valor de pagamento numa conta aberta';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1b — conta aberta não tem dia nem valor de pagamento';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — a direção de uma conta é congelada
--
-- Virar uma despesa em receita move o valor de um lado do DRE para o outro sem
-- nenhum registro de que alguém decidiu isso — e o resultado do mês muda pelo
-- dobro do valor da conta.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE bills SET direction = 'receber'
     WHERE id = '54545454-4444-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou trocar a direção da conta';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'OK 2 — a direção de uma conta é congelada';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — conta paga pela gaveta não volta a aberta
--
-- O dinheiro saiu e `cash_movements` registrou, e essa tabela é append-only
-- desde o bloco 18. Deixar a conta voltar faria o extrato do caixa e a lista do
-- financeiro contarem histórias diferentes sobre a mesma nota de cem — e o
-- fechamento do dia acusar falta que ninguém explica.
--
-- Quem pagou por fora da gaveta pode desfazer: ali não há segundo registro para
-- contradizer, e o clique errado numa lista de trinta linhas é o erro mais
-- comum desta tela.
-- ----------------------------------------------------------------------------
INSERT INTO cash_sessions
  (id, tenant_id, location_id, opened_by_name, opening_cents)
VALUES ('54545454-5555-0000-0000-000000000001',
        '54545454-0000-0000-0000-000000000001',
        '54545454-1111-0000-0000-000000000001', 'Matheus', 20000);

INSERT INTO cash_movements
  (id, tenant_id, session_id, kind, amount_cents, created_by_name)
VALUES ('54545454-6666-0000-0000-000000000001',
        '54545454-0000-0000-0000-000000000001',
        '54545454-5555-0000-0000-000000000001', 'bill_payment', -250000, 'Matheus');

DO $$
BEGIN
  UPDATE bills
     SET status = 'paga', paid_on = current_date, paid_cents = 250000,
         cash_movement_id = '54545454-6666-0000-0000-000000000001'
   WHERE id = '54545454-4444-0000-0000-000000000001';

  BEGIN
    UPDATE bills SET status = 'aberta', paid_on = NULL, paid_cents = NULL
     WHERE id = '54545454-4444-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou desfazer pagamento feito pela gaveta';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'OK 3 — conta paga pela gaveta não volta';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — pagamento de conta sai da gaveta com sinal negativo
--
-- Positivo, ele **aumentaria** o esperado do fechamento: o balcão pagaria o
-- fornecedor e o sistema cobraria a diferença de quem estava no caixa.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO cash_movements (tenant_id, session_id, kind, amount_cents, created_by_name)
    VALUES ('54545454-0000-0000-0000-000000000001',
            '54545454-5555-0000-0000-000000000001', 'bill_payment', 5000, 'Matheus');
    RAISE EXCEPTION 'aceitou pagamento de conta entrando na gaveta';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4a — pagamento de conta sai com sinal negativo';
  END;

  BEGIN
    INSERT INTO cash_movements (tenant_id, session_id, kind, amount_cents, created_by_name)
    VALUES ('54545454-0000-0000-0000-000000000001',
            '54545454-5555-0000-0000-000000000001', 'bill_receipt', -5000, 'Matheus');
    RAISE EXCEPTION 'aceitou recebimento de conta saindo da gaveta';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4b — recebimento de conta entra com sinal positivo';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — não se transfere para a mesma conta
--
-- É erro de digitação, e sem a recusa vira uma linha que não move nada e some
-- no extrato — o pior tipo, porque quem procura o dinheiro a lê como se
-- explicasse alguma coisa.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO account_transfers
      (tenant_id, location_id, from_account_id, to_account_id, amount_cents,
       happened_on, created_by_name)
    VALUES ('54545454-0000-0000-0000-000000000001',
            '54545454-1111-0000-0000-000000000001',
            '54545454-3333-0000-0000-000000000001',
            '54545454-3333-0000-0000-000000000001', 10000, current_date, 'Matheus');
    RAISE EXCEPTION 'aceitou transferência para a mesma conta';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 5 — transferência exige duas contas diferentes';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — a conta de origem não pode ser apagada por baixo da transferência
--
-- `SET NULL` deixaria a linha dizendo que o dinheiro andou sem dizer de onde —
-- que é pior que nenhuma linha. Conta que já moveu dinheiro se desativa.
-- ----------------------------------------------------------------------------
INSERT INTO account_transfers
  (id, tenant_id, location_id, from_account_id, to_account_id, amount_cents,
   happened_on, created_by_name)
VALUES ('54545454-7777-0000-0000-000000000001',
        '54545454-0000-0000-0000-000000000001',
        '54545454-1111-0000-0000-000000000001',
        '54545454-3333-0000-0000-000000000001',
        '54545454-3333-0000-0000-000000000002', 10000, current_date, 'Matheus');

DO $$
BEGIN
  BEGIN
    DELETE FROM financial_accounts WHERE id = '54545454-3333-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou apagar a conta de origem de uma transferência';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'OK 6 — conta que moveu dinheiro não se apaga';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 7 — a transferência é append-only e não é editável
--
-- Ela é o que responde "para onde foi o depósito de terça". Uma linha
-- reescrita responde a pergunta de hoje e apaga a de ontem.
-- ----------------------------------------------------------------------------
DO $$
DECLARE pode_apagar boolean; pode_editar boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    SELECT has_table_privilege('barbearia_app', 'account_transfers', 'DELETE'),
           has_table_privilege('barbearia_app', 'account_transfers', 'UPDATE')
      INTO pode_apagar, pode_editar;
    IF pode_apagar OR pode_editar THEN
      RAISE EXCEPTION 'a aplicação pode mexer numa transferência';
    END IF;

    IF has_table_privilege('barbearia_app', 'bills', 'DELETE') THEN
      RAISE EXCEPTION 'a aplicação pode apagar uma conta';
    END IF;
    RAISE NOTICE 'OK 7 — transferência e conta não se apagam';
  ELSE
    RAISE NOTICE 'PULADO 7 — sem o role da aplicação neste banco';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 8 — a gaveta é uma por unidade, e exige unidade
--
-- Duas gavetas na mesma loja fariam o fechamento ter dois donos, que é o que o
-- bloco 18 existe para impedir. E gaveta sem unidade é gaveta de ninguém.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO financial_accounts (tenant_id, location_id, name, is_cash)
    VALUES ('54545454-0000-0000-0000-000000000001',
            '54545454-1111-0000-0000-000000000001', 'Gaveta 2', true);
    RAISE EXCEPTION 'aceitou duas gavetas na mesma unidade';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 8a — uma gaveta por unidade';
  END;

  BEGIN
    INSERT INTO financial_accounts (tenant_id, location_id, name, is_cash)
    VALUES ('54545454-0000-0000-0000-000000000001', NULL, 'Gaveta solta', true);
    RAISE EXCEPTION 'aceitou gaveta sem unidade';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 8b — gaveta tem unidade';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 9 — nenhuma chave destrói uma conta ou uma transferência em cascata
--
-- Varredura de catálogo, como no bloco 49: a chave nova que alguém adicionar
-- amanhã nasce coberta. `tenant_id` é a **única** exceção — apagar a barbearia
-- é apagar tudo dela por definição.
--
-- A primeira versão isentava `location_id` também, e a isenção desligava a
-- varredura justamente para a chave que a violava: a aplicação tem `DELETE` em
-- `locations`, e a cascata roda com os direitos do dono da tabela, passando por
-- cima do `REVOKE DELETE` desta. Achado da revisão de segurança deste bloco, e é
-- por isso que a lista de exceções de uma varredura é o lugar mais perigoso do
-- teste: ela some do olhar.
-- ----------------------------------------------------------------------------
DO $$
DECLARE ruins text;
BEGIN
  SELECT string_agg(conrelid::regclass || '.' || conname, ', ') INTO ruins
    FROM pg_constraint
   WHERE conrelid IN ('bills'::regclass, 'account_transfers'::regclass)
     AND contype = 'f' AND confdeltype = 'c'
     AND conname NOT LIKE '%tenant_id_fkey';

  IF ruins IS NOT NULL THEN
    RAISE EXCEPTION 'chave com CASCADE no financeiro: %', ruins;
  END IF;
  RAISE NOTICE 'OK 9 — nenhuma chave do financeiro destrói a linha em cascata';
END $$;

-- ----------------------------------------------------------------------------
-- 9b — a unidade não é apagável por baixo de uma conta ou transferência
--
-- É o outro lado do item 9: `RESTRICT` só vale se ele de fato recusar. Sem ele,
-- apagar a unidade levaria o registro de tudo o que ela pagou — e a ação
-- referencial roda com os direitos do dono da tabela, sem passar pelo
-- `REVOKE DELETE`.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    DELETE FROM locations WHERE id = '54545454-1111-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou apagar a unidade com conta lançada';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'OK 9b — unidade com financeiro não se apaga';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 10 — RLS forçada nas três tabelas novas
-- ----------------------------------------------------------------------------
DO $$
DECLARE faltando text;
BEGIN
  SELECT string_agg(relname, ', ') INTO faltando
    FROM pg_class
   WHERE relname IN ('bills', 'account_transfers', 'financial_accounts',
                     'financial_categories')
     AND NOT (relrowsecurity AND relforcerowsecurity);

  IF faltando IS NOT NULL THEN
    RAISE EXCEPTION 'sem RLS forçada: %', faltando;
  END IF;
  RAISE NOTICE 'OK 10 — RLS forçada em todo o financeiro';
END $$;

-- ----------------------------------------------------------------------------
-- 11 — movimento de caixa sem pagamento não existe
--
-- Dinheiro que saiu da gaveta por uma conta que continua em aberto é o
-- fornecedor cobrando de novo e o balcão pagando duas vezes.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO bills
      (tenant_id, location_id, direction, description, amount_cents, due_on,
       cash_movement_id, created_by_name)
    VALUES ('54545454-0000-0000-0000-000000000001',
            '54545454-1111-0000-0000-000000000001', 'pagar', 'Motoboy', 3000,
            current_date, '54545454-6666-0000-0000-000000000001', 'Matheus');
    RAISE EXCEPTION 'aceitou movimento de caixa numa conta aberta';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 11 — movimento de caixa só em conta paga';
  END;
END $$;

ROLLBACK;
