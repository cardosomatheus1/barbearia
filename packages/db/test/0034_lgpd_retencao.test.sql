-- ============================================================================
-- Invariantes da anonimização (bloco 32).
--
-- O que se prova aqui é o que separa anonimizar de apagar: que a pessoa some e
-- o dinheiro fica, que a porta para as tabelas append-only é uma só e é
-- nomeada, e que ela não alcança a barbearia vizinha nem sem RLS.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('34343434-0000-0000-0000-000000000001', 'Domari'),
  ('34343434-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('4a343434-0000-0000-0000-000000000001', '34343434-0000-0000-0000-000000000001',
   'Matriz', 'America/Bahia');

INSERT INTO customers (id, tenant_id, name, phone_e164, birth_date,
                       accepts_marketing, marketing_consent_ip, balance_cents)
VALUES
  ('c4343434-0000-0000-0000-000000000001', '34343434-0000-0000-0000-000000000001',
   'Carlos Souza', '+5571988887777', '1990-04-12', true, '203.0.113.9', -8000),
  ('c4343434-0000-0000-0000-000000000002', '34343434-0000-0000-0000-000000000002',
   'Cliente da Vizinha', '+5571977776666', '1985-01-01', false, NULL, 0);

INSERT INTO customer_consents (customer_id, tenant_id, purpose, granted, text_version, ip)
VALUES ('c4343434-0000-0000-0000-000000000001', '34343434-0000-0000-0000-000000000001',
        'marketing', true, 'v1', '203.0.113.9');

INSERT INTO customer_preferences (customer_id, tenant_id, produtos_evitar, observacoes)
VALUES ('c4343434-0000-0000-0000-000000000001', '34343434-0000-0000-0000-000000000001',
        'Álcool no pós-barba', 'Mora na rua de cima, sempre vem com o filho');

INSERT INTO customer_ledger
  (tenant_id, customer_id, kind, amount_cents, balance_after_cents, note, created_by_name)
VALUES ('34343434-0000-0000-0000-000000000001', 'c4343434-0000-0000-0000-000000000001',
        'fiado', -8000, -8000, 'Carlos levou fiado, disse que paga sexta', 'Maria');

INSERT INTO notifications (tenant_id, kind, customer_id, status, phone_masked)
VALUES ('34343434-0000-0000-0000-000000000001', 'lembrete_24h',
        'c4343434-0000-0000-0000-000000000001', 'sent', '(71) 9****-7777');

INSERT INTO customer_sessions (tenant_id, customer_id, token_hash, expires_at, ip)
VALUES ('34343434-0000-0000-0000-000000000001', 'c4343434-0000-0000-0000-000000000001',
        'hash-qualquer', now() + interval '30 days', '203.0.113.9');

-- ----------------------------------------------------------------------------
-- 1 — a aplicação não reescreve o extrato nem o consentimento por fora
--
-- A função existe porque estas duas portas continuam fechadas. Se elas
-- estivessem abertas, ela seria burocracia.
-- ----------------------------------------------------------------------------
SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '34343434-0000-0000-0000-000000000001', true);

DO $$
BEGIN
  BEGIN
    UPDATE customer_ledger SET note = NULL;
    RAISE EXCEPTION 'a aplicação reescreveu o extrato direto';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 1 — extrato continua fora do alcance da aplicação';
  END;

  BEGIN
    UPDATE customer_consents SET ip = NULL;
    RAISE EXCEPTION 'a aplicação reescreveu o consentimento direto';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 1b — consentimento também';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — sem tenant no contexto, a função recusa
--
-- É a diferença entre "anonimize este cliente da barbearia X" e "anonimize este
-- uuid onde quer que ele esteja". `SECURITY DEFINER` tornaria a segunda uma
-- porta para apagar cadastro alheio conhecendo só o id.
-- ----------------------------------------------------------------------------
SELECT set_config('app.tenant_id', '', true);

DO $$
BEGIN
  BEGIN
    PERFORM anonimizar_cliente('c4343434-0000-0000-0000-000000000001', 'pedido do titular');
    RAISE EXCEPTION 'anonimizou sem tenant no contexto';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%anonimizou sem tenant%' THEN RAISE; END IF;
    RAISE NOTICE 'OK 2 — sem tenant, a função recusa';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — motivo escrito é obrigatório
-- ----------------------------------------------------------------------------
SELECT set_config('app.tenant_id', '34343434-0000-0000-0000-000000000001', true);

DO $$
BEGIN
  BEGIN
    PERFORM anonimizar_cliente('c4343434-0000-0000-0000-000000000001', ' ');
    RAISE EXCEPTION 'anonimizou sem motivo';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%anonimizou sem motivo%' THEN RAISE; END IF;
    RAISE NOTICE 'OK 3 — anonimizar exige motivo escrito';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — a barbearia não anonimiza o cliente da vizinha
--
-- O ponto mais importante do arquivo. A função roda como dono das tabelas, onde
-- a RLS pode não valer: quem isola é o filtro escrito dentro dela.
-- ----------------------------------------------------------------------------
DO $$
DECLARE feito boolean; nome text;
BEGIN
  SELECT anonimizar_cliente('c4343434-0000-0000-0000-000000000002', 'tentativa')
    INTO feito;
  IF feito THEN
    RAISE EXCEPTION 'anonimizou o cliente de outra barbearia';
  END IF;

  -- E a linha da vizinha continua intacta.
  RESET ROLE;
  SELECT name INTO nome FROM customers
   WHERE id = 'c4343434-0000-0000-0000-000000000002';
  IF nome <> 'Cliente da Vizinha' THEN
    RAISE EXCEPTION 'o cadastro da vizinha foi tocado: %', nome;
  END IF;
  RAISE NOTICE 'OK 4 — a função não atravessa a fronteira do tenant';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — a pessoa some e o dinheiro fica
-- ----------------------------------------------------------------------------
SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '34343434-0000-0000-0000-000000000001', true);

DO $$
DECLARE feito boolean;
BEGIN
  SELECT anonimizar_cliente('c4343434-0000-0000-0000-000000000001', 'pedido de exclusão do titular')
    INTO feito;
  IF NOT feito THEN
    RAISE EXCEPTION 'a anonimização não aconteceu';
  END IF;
  RAISE NOTICE 'OK 5 — anonimização executada';
END $$;

DO $$
DECLARE c record;
BEGIN
  SELECT name, phone_e164, birth_date, accepts_marketing, marketing_consent_ip,
         anonymized_at, balance_cents
    INTO c
    FROM customers WHERE id = 'c4343434-0000-0000-0000-000000000001';

  IF c.name <> 'cliente_anonimizado_c434' THEN
    RAISE EXCEPTION 'o nome não virou apelido: %', c.name;
  END IF;
  IF c.phone_e164 IS NOT NULL THEN
    RAISE EXCEPTION 'o telefone sobreviveu — a busca do balcão reencontra a pessoa';
  END IF;
  IF c.birth_date IS NOT NULL OR c.marketing_consent_ip IS NOT NULL THEN
    RAISE EXCEPTION 'nascimento ou IP sobreviveram';
  END IF;
  IF c.accepts_marketing THEN
    RAISE EXCEPTION 'continua aceitando campanha depois de anonimizado';
  END IF;
  IF c.anonymized_at IS NULL THEN
    RAISE EXCEPTION 'não ficou marcado como anonimizado';
  END IF;

  -- O que a obrigação fiscal exige continua lá, com o centavo intacto.
  IF c.balance_cents <> -8000 THEN
    RAISE EXCEPTION 'o saldo do fiado foi alterado: %', c.balance_cents;
  END IF;

  RAISE NOTICE 'OK 5b — nome, telefone, nascimento e IP saíram; o saldo ficou';
END $$;

DO $$
DECLARE n int; valor int;
BEGIN
  SELECT count(*) INTO n FROM customer_consents
   WHERE customer_id = 'c4343434-0000-0000-0000-000000000001' AND ip IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'o IP do consentimento sobreviveu'; END IF;

  -- A decisão fica: a prova de que houve aceite não some com a anonimização.
  SELECT count(*) INTO n FROM customer_consents
   WHERE customer_id = 'c4343434-0000-0000-0000-000000000001';
  IF n <> 1 THEN RAISE EXCEPTION 'o consentimento foi apagado, não anonimizado'; END IF;

  SELECT count(*) INTO n FROM customer_ledger
   WHERE customer_id = 'c4343434-0000-0000-0000-000000000001' AND note IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'a nota do extrato sobreviveu'; END IF;

  SELECT amount_cents INTO valor FROM customer_ledger
   WHERE customer_id = 'c4343434-0000-0000-0000-000000000001';
  IF valor <> -8000 THEN RAISE EXCEPTION 'o valor do extrato foi alterado: %', valor; END IF;

  SELECT count(*) INTO n FROM customer_preferences
   WHERE customer_id = 'c4343434-0000-0000-0000-000000000001'
     AND (observacoes IS NOT NULL OR produtos_evitar IS NOT NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'a ficha sobreviveu'; END IF;

  SELECT count(*) INTO n FROM notifications
   WHERE customer_id = 'c4343434-0000-0000-0000-000000000001' AND phone_masked IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'o telefone mascarado sobreviveu'; END IF;

  SELECT count(*) INTO n FROM customer_sessions
   WHERE customer_id = 'c4343434-0000-0000-0000-000000000001';
  IF n <> 0 THEN RAISE EXCEPTION 'a sessão do navegador continua aberta'; END IF;

  RAISE NOTICE 'OK 5c — ficha, notas, IP e sessão saíram; os centavos ficaram';
END $$;

-- ----------------------------------------------------------------------------
-- 6 — anonimizar de novo não faz nada, e não quebra
--
-- A varredura processa lote. Uma linha que outro processo acabou de anonimizar
-- não pode derrubar as outras quarenta.
-- ----------------------------------------------------------------------------
DO $$
DECLARE feito boolean;
BEGIN
  SELECT anonimizar_cliente('c4343434-0000-0000-0000-000000000001', 'de novo') INTO feito;
  IF feito THEN
    RAISE EXCEPTION 'anonimizou duas vezes';
  END IF;
  RAISE NOTICE 'OK 6 — a segunda vez é silenciosa e devolve falso';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — cadastro vivo não fica sem telefone
--
-- A CHECK amarra as duas colunas. Sem ela, um UPDATE errado em qualquer canto
-- do produto zeraria o telefone de um cliente ativo e ninguém notaria até a
-- próxima busca no balcão.
-- ----------------------------------------------------------------------------
RESET ROLE;

DO $$
BEGIN
  BEGIN
    INSERT INTO customers (tenant_id, name, phone_e164)
    VALUES ('34343434-0000-0000-0000-000000000001', 'Sem telefone', NULL);
    RAISE EXCEPTION 'aceitou cadastro vivo sem telefone';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 7 — cadastro vivo precisa de telefone';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 8 — a função não é executável por qualquer papel
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_function_privilege('public', 'anonimizar_cliente(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a função SECURITY DEFINER está aberta a PUBLIC';
  END IF;
  RAISE NOTICE 'OK 8 — anonimizar_cliente não está aberta a PUBLIC';
END $$;

ROLLBACK;
