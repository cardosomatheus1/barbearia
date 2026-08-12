-- ============================================================================
-- Invariantes da nota fiscal em operação (bloco 54).
--
-- O que só o banco prova: que o CPF tem forma, que a anonimização o leva junto
-- **dentro da nota já emitida**, e que a nota entregue não é entregue de novo.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('57575757-0000-0000-0000-000000000001', 'Domari');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('57575757-1111-0000-0000-000000000001',
   '57575757-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia');

INSERT INTO customers (id, tenant_id, name, phone_e164, tax_id) VALUES
  ('57575757-3333-0000-0000-000000000001',
   '57575757-0000-0000-0000-000000000001', 'Carlos Souza', '+5571988887777',
   '52998224725');

INSERT INTO orders (id, tenant_id, location_id, customer_id, status,
                    business_day, closed_at, total_cents)
VALUES ('57575757-2222-0000-0000-000000000001',
        '57575757-0000-0000-0000-000000000001',
        '57575757-1111-0000-0000-000000000001',
        '57575757-3333-0000-0000-000000000001', 'paid', current_date, now(), 9000);

-- ----------------------------------------------------------------------------
-- 1 — CPF e CNPJ têm forma, e só as duas
--
-- Só dígitos, 11 ou 14. O que a CHECK impede não é o CPF inválido — dígito
-- verificador é conta, e ela mora em `packages/core` — é o campo com pontuação,
-- com espaço ou com meia dúzia de dígitos indo para o emissor, que devolveria
-- rejeição da prefeitura dias depois sem dizer que o problema é o cadastro.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE customers SET tax_id = '529.982.247-25'
     WHERE id = '57575757-3333-0000-0000-000000000001';
    RAISE EXCEPTION 'CPF com pontuação foi aceito';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1a — CPF pontuado recusado';
  END;

  BEGIN
    UPDATE customers SET tax_id = '5299822472'
     WHERE id = '57575757-3333-0000-0000-000000000001';
    RAISE EXCEPTION 'documento de dez dígitos foi aceito';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1b — documento de tamanho errado recusado';
  END;

  -- CNPJ passa pela mesma coluna: é a empresa que manda a equipe cortar cabelo.
  UPDATE customers SET tax_id = '11222333000181'
   WHERE id = '57575757-3333-0000-0000-000000000001';
  RAISE NOTICE 'OK 1c — CNPJ aceito na mesma coluna';

  -- E nulo é o caso comum: nota ao consumidor.
  UPDATE customers SET tax_id = NULL
   WHERE id = '57575757-3333-0000-0000-000000000001';
  RAISE NOTICE 'OK 1d — sem documento é estado legítimo';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — a anonimização tira o tomador de dentro da nota, e a nota fica
--
-- O registro fiscal tem guarda de cinco anos: o valor, o número e a data ficam.
-- Quem sai é a pessoa. Sem este trecho, a função apagaria nome, telefone e CPF
-- do cadastro e deixaria os mesmos nome e CPF copiados na nota — que é
-- exatamente o documento que a barbearia é obrigada a guardar, ou seja, o lugar
-- onde eles sobreviveriam mais tempo.
-- ----------------------------------------------------------------------------
UPDATE customers SET tax_id = '52998224725'
 WHERE id = '57575757-3333-0000-0000-000000000001';

INSERT INTO fiscal_invoices
  (id, tenant_id, location_id, order_id, status, number, pdf_url, authorized_at,
   regime, service_cents, iss_bps, service_code, municipality_ibge,
   customer_name, customer_document, created_by_name)
VALUES ('57575757-4444-0000-0000-000000000001',
        '57575757-0000-0000-0000-000000000001',
        '57575757-1111-0000-0000-000000000001',
        '57575757-2222-0000-0000-000000000001',
        'autorizada', '2026/1043', 'https://nfse.exemplo/1043.pdf', now(),
        'simples', 9000, 200, '14.01', '2927408',
        'Carlos Souza', '52998224725', 'Maria Recepção');

DO $$
DECLARE
  v_nome text;
  v_doc text;
  v_numero text;
  v_valor integer;
BEGIN
  PERFORM set_config('app.tenant_id', '57575757-0000-0000-0000-000000000001', true);
  PERFORM anonimizar_cliente('57575757-3333-0000-0000-000000000001',
                             'pedido de exclusão do titular');

  SELECT customer_name, customer_document, number, service_cents
    INTO v_nome, v_doc, v_numero, v_valor
    FROM fiscal_invoices WHERE id = '57575757-4444-0000-0000-000000000001';

  IF v_doc IS NOT NULL THEN
    RAISE EXCEPTION 'o CPF sobreviveu dentro da nota fiscal: %', v_doc;
  END IF;
  IF v_nome LIKE '%Carlos%' THEN
    RAISE EXCEPTION 'o nome do tomador sobreviveu dentro da nota: %', v_nome;
  END IF;

  -- E o documento continua sendo um documento.
  IF v_numero IS DISTINCT FROM '2026/1043' OR v_valor <> 9000 THEN
    RAISE EXCEPTION 'a anonimização destruiu o registro fiscal (% / %)', v_numero, v_valor;
  END IF;

  RAISE NOTICE 'OK 2 — a pessoa sai de dentro da nota e a nota fica';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — o CPF sai do cadastro
--
-- A varredura de catálogo do bloco 34 cobre isto, e é ela quem manda. Aqui a
-- afirmação é direta e serve de sinal mais legível: quando o teste da varredura
-- ficar vermelho por causa desta coluna, este diz por quê.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_doc text;
BEGIN
  SELECT tax_id INTO v_doc FROM customers
   WHERE id = '57575757-3333-0000-0000-000000000001';
  IF v_doc IS NOT NULL THEN
    RAISE EXCEPTION 'customers.tax_id sobreviveu à anonimização: %', v_doc;
  END IF;
  RAISE NOTICE 'OK 3 — o CPF sai do cadastro';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — a nota entregue sai da fila de entrega
--
-- O índice parcial é a fila, e o carimbo é o que tira dela. Sem o carimbo a
-- varredura remandaria a mesma nota a cada volta do laço — e a barbearia
-- descobriria pelo cliente reclamando de vinte mensagens iguais.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_na_fila integer;
BEGIN
  SELECT count(*) INTO v_na_fila FROM fiscal_invoices
   WHERE status = 'autorizada' AND customer_notified_at IS NULL AND pdf_url IS NOT NULL;
  IF v_na_fila <> 1 THEN
    RAISE EXCEPTION 'a nota autorizada com link deveria estar na fila de entrega (%)', v_na_fila;
  END IF;

  UPDATE fiscal_invoices SET customer_notified_at = now()
   WHERE id = '57575757-4444-0000-0000-000000000001';

  SELECT count(*) INTO v_na_fila FROM fiscal_invoices
   WHERE status = 'autorizada' AND customer_notified_at IS NULL AND pdf_url IS NOT NULL;
  IF v_na_fila <> 0 THEN
    RAISE EXCEPTION 'a nota entregue continuou na fila de entrega';
  END IF;

  RAISE NOTICE 'OK 4 — o carimbo tira a nota da fila de entrega';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — nota sem link não entra na fila de entrega
--
-- Autorizada e sem PDF acontece: o emissor confirma o número antes de o
-- documento ficar disponível. Mandar "sua nota está pronta" com um link vazio é
-- pior que não mandar nada, porque gasta a única mensagem que o cliente lê.
-- ----------------------------------------------------------------------------
-- Outra venda: a primeira nota continua autorizada, e uma comanda só aceita
-- uma nota viva.
INSERT INTO orders (id, tenant_id, location_id, status, business_day, closed_at, total_cents)
VALUES ('57575757-2222-0000-0000-000000000002',
        '57575757-0000-0000-0000-000000000001',
        '57575757-1111-0000-0000-000000000001', 'paid', current_date, now(), 9000);

INSERT INTO fiscal_invoices
  (id, tenant_id, location_id, order_id, status, number, authorized_at,
   regime, service_cents, iss_bps, service_code, municipality_ibge, created_by_name)
VALUES ('57575757-4444-0000-0000-000000000002',
        '57575757-0000-0000-0000-000000000001',
        '57575757-1111-0000-0000-000000000001',
        '57575757-2222-0000-0000-000000000002',
        'autorizada', '2026/1044', now(),
        'simples', 9000, 200, '14.01', '2927408', 'Maria Recepção');

DO $$
DECLARE v_na_fila integer;
BEGIN
  SELECT count(*) INTO v_na_fila FROM fiscal_invoices
   WHERE status = 'autorizada' AND customer_notified_at IS NULL AND pdf_url IS NOT NULL;
  IF v_na_fila <> 0 THEN
    RAISE EXCEPTION 'nota autorizada sem PDF entrou na fila de entrega';
  END IF;
  RAISE NOTICE 'OK 5 — sem link, sem mensagem';
END $$;

ROLLBACK;
