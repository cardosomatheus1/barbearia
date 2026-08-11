-- ============================================================================
-- Invariantes da fidelidade (bloco 41).
--
-- O que se prova aqui é o que separa um programa de fidelidade de uma máquina
-- de imprimir dinheiro: o extrato não se reescreve, o mesmo pedido não credita
-- duas vezes, e um lançamento nunca fica sem unidade.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('41414141-0000-0000-0000-000000000001', 'Domari'),
  ('41414141-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('41414141-1111-0000-0000-000000000001',
   '41414141-0000-0000-0000-000000000001', 'Centro', 'America/Bahia');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('41414141-3333-0000-0000-000000000001',
   '41414141-0000-0000-0000-000000000001', 'Carlos', '+5571988887777');

INSERT INTO orders (id, tenant_id, location_id, customer_id, status, total_cents)
VALUES ('41414141-7777-0000-0000-000000000001',
        '41414141-0000-0000-0000-000000000001',
        '41414141-1111-0000-0000-000000000001',
        '41414141-3333-0000-0000-000000000001', 'open', 5000);

-- ----------------------------------------------------------------------------
-- 1 — um modelo por barbearia, e é a chave primária que garante
--
-- "Você tem 340 pontos, 3 visitas e R$ 12 de cashback" é a frase que ninguém
-- entende no balcão. A SPEC §4.8 manda escolher **um**, e aqui isso é fato do
-- schema, não validação de aplicação.
-- ----------------------------------------------------------------------------
INSERT INTO loyalty_programs (tenant_id, mode) VALUES
  ('41414141-0000-0000-0000-000000000001', 'pontos');

DO $$
BEGIN
  BEGIN
    INSERT INTO loyalty_programs (tenant_id, mode) VALUES
      ('41414141-0000-0000-0000-000000000001', 'cashback');
    RAISE EXCEPTION 'aceitou dois programas na mesma barbearia';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 1 — um modelo por barbearia';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — número de programa fora da realidade é recusado
--
-- Cem por cento de cashback é a casa pagando para atender, e costuma ser um zero
-- digitado a mais.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE loyalty_programs SET cashback_bps = 10000
     WHERE tenant_id = '41414141-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou cem por cento de cashback';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2a — cashback acima do teto recusado';
  END;

  BEGIN
    UPDATE loyalty_programs SET point_value_cents = 0
     WHERE tenant_id = '41414141-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou ponto valendo zero';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2b — ponto sem valor recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — lançamento sem unidade não existe
--
-- `mode` congelado é o que impede a troca de programa em maio de reinterpretar
-- as linhas de abril: 300 pontos viram R$ 300 de crédito.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO loyalty_entries (tenant_id, customer_id, kind, mode, amount)
    VALUES ('41414141-0000-0000-0000-000000000001',
            '41414141-3333-0000-0000-000000000001', 'ajuste', 'nenhum', 10);
    RAISE EXCEPTION 'aceitou lançamento sem modalidade';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3a — lançamento com modo "nenhum" recusado';
  END;

  BEGIN
    INSERT INTO loyalty_entries (tenant_id, customer_id, kind, mode, amount)
    VALUES ('41414141-0000-0000-0000-000000000001',
            '41414141-3333-0000-0000-000000000001', 'ajuste', 'pontos', 0);
    RAISE EXCEPTION 'aceitou movimento zero';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3b — movimento zero recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — entrada entra, saída sai — o sinal casa com o tipo
--
-- Sem isto, um "resgate" positivo credita em vez de debitar, e o extrato passa a
-- somar o contrário do que diz.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO loyalty_entries (tenant_id, customer_id, kind, mode, amount)
    VALUES ('41414141-0000-0000-0000-000000000001',
            '41414141-3333-0000-0000-000000000001', 'resgate', 'pontos', 50);
    RAISE EXCEPTION 'aceitou resgate positivo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4a — resgate com sinal invertido recusado';
  END;

  BEGIN
    INSERT INTO loyalty_entries (tenant_id, customer_id, kind, mode, amount)
    VALUES ('41414141-0000-0000-0000-000000000001',
            '41414141-3333-0000-0000-000000000001', 'acumulo', 'pontos', -50);
    RAISE EXCEPTION 'aceitou acúmulo negativo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4b — acúmulo com sinal invertido recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — ajuste sem motivo escrito não entra
--
-- É a única linha que uma pessoa cria à mão, e ela **cria dinheiro**: o saldo
-- vira forma de pagamento no balcão da operação seguinte.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO loyalty_entries (tenant_id, customer_id, kind, mode, amount, note)
    VALUES ('41414141-0000-0000-0000-000000000001',
            '41414141-3333-0000-0000-000000000001', 'ajuste', 'pontos', 100, 'oi');
    RAISE EXCEPTION 'aceitou ajuste sem motivo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 5 — ajuste sem motivo escrito recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — um acúmulo por venda
--
-- A cadeia do webhook do Pix pode reentrar por outro caminho. Sem este índice, a
-- reentrega dobra o saldo do cliente — e saldo dobrado vira dinheiro no balcão.
-- ----------------------------------------------------------------------------
INSERT INTO loyalty_entries (tenant_id, customer_id, order_id, kind, mode, amount)
VALUES ('41414141-0000-0000-0000-000000000001',
        '41414141-3333-0000-0000-000000000001',
        '41414141-7777-0000-0000-000000000001', 'acumulo', 'pontos', 50);

DO $$
BEGIN
  BEGIN
    INSERT INTO loyalty_entries (tenant_id, customer_id, order_id, kind, mode, amount)
    VALUES ('41414141-0000-0000-0000-000000000001',
            '41414141-3333-0000-0000-000000000001',
            '41414141-7777-0000-0000-000000000001', 'acumulo', 'pontos', 50);
    RAISE EXCEPTION 'creditou duas vezes a mesma venda';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 6a — um acúmulo por venda';
  END;

  -- O resgate da **mesma** venda continua entrando: são movimentos diferentes.
  INSERT INTO loyalty_entries (tenant_id, customer_id, order_id, kind, mode, amount)
  VALUES ('41414141-0000-0000-0000-000000000001',
          '41414141-3333-0000-0000-000000000001',
          '41414141-7777-0000-0000-000000000001', 'resgate', 'pontos', -20);
  RAISE NOTICE 'OK 6b — o resgate da mesma venda não é bloqueado pelo índice';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — o extrato é append-only
--
-- "Meus pontos sumiram" é a pergunta; o extrato é a resposta. Resposta que pode
-- ser reescrita não responde nada. Corrigir é **inserir** um ajuste.
-- ----------------------------------------------------------------------------
SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '41414141-0000-0000-0000-000000000001', true);

DO $$
BEGIN
  BEGIN
    UPDATE loyalty_entries SET amount = 9999;
    RAISE EXCEPTION 'a aplicação reescreveu um lançamento';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 7a — a aplicação não tem UPDATE em loyalty_entries';
  END;

  BEGIN
    DELETE FROM loyalty_entries;
    RAISE EXCEPTION 'a aplicação apagou um lançamento';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 7b — a aplicação não tem DELETE em loyalty_entries';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 8 — a barbearia vizinha não lê nem escreve este saldo
-- ----------------------------------------------------------------------------
SELECT set_config('app.tenant_id', '41414141-0000-0000-0000-000000000002', true);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM loyalty_entries;
  IF n <> 0 THEN
    RAISE EXCEPTION 'a vizinha enxerga % lançamentos alheios', n;
  END IF;
  SELECT count(*) INTO n FROM loyalty_programs;
  IF n <> 0 THEN
    RAISE EXCEPTION 'a vizinha enxerga o programa alheio';
  END IF;
  RAISE NOTICE 'OK 8a — a vizinha não lê o saldo desta barbearia';

  BEGIN
    INSERT INTO loyalty_entries (tenant_id, customer_id, kind, mode, amount)
    VALUES ('41414141-0000-0000-0000-000000000001',
            '41414141-3333-0000-0000-000000000001', 'acumulo', 'pontos', 500);
    RAISE EXCEPTION 'a vizinha creditou saldo na barbearia alheia';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 8b — WITH CHECK impede creditar em nome de outra barbearia';
  END;
END $$;

RESET ROLE;

-- ----------------------------------------------------------------------------
-- 9 — resgate é forma de pagamento, e existe como tal
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'payment_method' AND e.enumlabel = 'fidelidade'
  ) THEN
    RAISE EXCEPTION 'falta a forma de pagamento do resgate';
  END IF;
  RAISE NOTICE 'OK 9 — fidelidade existe como forma de pagamento';
END $$;

-- ----------------------------------------------------------------------------
-- 10 — a permissão de criar saldo é de dinheiro, e existe
--
-- Prefixo `finance.` de propósito: o segundo fator é derivado do prefixo, e
-- criar saldo é criar valor gastável no balcão da operação seguinte.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO role_permissions (tenant_id, role, permission)
  VALUES ('41414141-0000-0000-0000-000000000001', 'manager', 'finance.loyalty_adjust')
  ON CONFLICT DO NOTHING;
  RAISE NOTICE 'OK 10 — finance.loyalty_adjust é permissão válida';
END $$;

-- ----------------------------------------------------------------------------
-- 11 — os índices que as duas consultas quentes exigem
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'loyalty_entries'
       AND indexname IN ('loyalty_entries_por_cliente_idx', 'loyalty_entries_vencendo_idx')
     GROUP BY tablename HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'falta índice de saldo ou de vencimento';
  END IF;
  RAISE NOTICE 'OK 11 — os índices de saldo e de vencimento existem';
END $$;

ROLLBACK;
