-- ============================================================================
-- Invariantes da lista de espera (bloco 38).
--
-- O que se prova aqui é o que o teste de integração não alcança: que a mesma
-- pessoa não entra duas vezes para a mesma coisa — inclusive no pedido mais
-- comum, que é "qualquer barbeiro" —, que estado terminal carrega hora, que
-- "conseguiu marcar" tem lastro, e que a barbearia vizinha não enxerga nem
-- escreve nesta lista.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('41414141-0000-0000-0000-000000000001', 'Domari'),
  ('41414141-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('41414141-1111-0000-0000-000000000001',
   '41414141-0000-0000-0000-000000000001', 'Centro', 'America/Bahia'),
  ('41414141-1111-0000-0000-000000000002',
   '41414141-0000-0000-0000-000000000002', 'Outra', 'America/Bahia');

INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
  ('41414141-2222-0000-0000-000000000001',
   '41414141-0000-0000-0000-000000000001',
   '41414141-1111-0000-0000-000000000001', 'Ruan');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('41414141-3333-0000-0000-000000000001',
   '41414141-0000-0000-0000-000000000001', 'Carlos', '+5571988887777'),
  ('41414141-3333-0000-0000-000000000002',
   '41414141-0000-0000-0000-000000000002', 'Cliente da Vizinha', '+5571977776666');

-- ----------------------------------------------------------------------------
-- 1 — janela e período incoerentes são recusados
--
-- Janela vazia casaria com nada e ficaria na lista para sempre; período
-- invertido casaria com nada pela razão oposta. Os dois são entrada malformada
-- que o banco recusa em vez de guardar como lixo silencioso.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO waitlist_entries
      (tenant_id, location_id, customer_id, wanted_from, wanted_to,
       window_start_minute, window_end_minute, duration_minutes)
    VALUES ('41414141-0000-0000-0000-000000000001',
            '41414141-1111-0000-0000-000000000001',
            '41414141-3333-0000-0000-000000000001',
            '2026-08-15', '2026-08-15', 600, 600, 30);
    RAISE EXCEPTION 'aceitou janela vazia';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1a — janela vazia recusada';
  END;

  BEGIN
    INSERT INTO waitlist_entries
      (tenant_id, location_id, customer_id, wanted_from, wanted_to,
       window_start_minute, window_end_minute, duration_minutes)
    VALUES ('41414141-0000-0000-0000-000000000001',
            '41414141-1111-0000-0000-000000000001',
            '41414141-3333-0000-0000-000000000001',
            '2026-08-20', '2026-08-15', 480, 720, 30);
    RAISE EXCEPTION 'aceitou período invertido';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1b — período invertido recusado';
  END;

  BEGIN
    INSERT INTO waitlist_entries
      (tenant_id, location_id, customer_id, wanted_from, wanted_to,
       window_start_minute, window_end_minute, duration_minutes)
    VALUES ('41414141-0000-0000-0000-000000000001',
            '41414141-1111-0000-0000-000000000001',
            '41414141-3333-0000-0000-000000000001',
            '2026-08-15', '2026-08-15', 480, 720, 0);
    RAISE EXCEPTION 'aceitou duração zero';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1c — duração zero recusada';
  END;

  /**
   * A faixa aberta, achado da revisão de segurança.
   *
   * "De hoje até 2099" passava no domínio, que conferia só o começo — e nunca
   * expirava, porque a varredura só fecha o que já passou. Três dessas,
   * cobrindo o dia de trabalho, faziam uma pessoa ser candidata permanente a
   * toda vaga da barbearia. A CHECK vale para quem entrar por outro caminho.
   */
  BEGIN
    INSERT INTO waitlist_entries
      (tenant_id, location_id, customer_id, wanted_from, wanted_to,
       window_start_minute, window_end_minute, duration_minutes)
    VALUES ('41414141-0000-0000-0000-000000000001',
            '41414141-1111-0000-0000-000000000001',
            '41414141-3333-0000-0000-000000000001',
            '2026-08-15', '2099-12-31', 480, 720, 30);
    RAISE EXCEPTION 'aceitou faixa sem fim';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1d — faixa acima de 60 dias recusada';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — a mesma pessoa não entra duas vezes para a mesma coisa
--
-- A chave de idempotência resolve o duplo toque; este índice resolve o pedido
-- repetido dias depois, que ela não alcança. O caso que importa é o **sem
-- profissional**: `NULL` não colide com `NULL` num índice único, então sem o
-- `COALESCE` o pedido mais comum do produto poderia ser cadastrado sem limite.
-- ----------------------------------------------------------------------------
INSERT INTO waitlist_entries
  (id, tenant_id, location_id, customer_id, wanted_from, wanted_to,
   window_start_minute, window_end_minute, duration_minutes)
VALUES ('41414141-4444-0000-0000-000000000001',
        '41414141-0000-0000-0000-000000000001',
        '41414141-1111-0000-0000-000000000001',
        '41414141-3333-0000-0000-000000000001',
        '2026-08-15', '2026-08-15', 480, 720, 30);

DO $$
BEGIN
  BEGIN
    INSERT INTO waitlist_entries
      (tenant_id, location_id, customer_id, wanted_from, wanted_to,
       window_start_minute, window_end_minute, duration_minutes)
    VALUES ('41414141-0000-0000-0000-000000000001',
            '41414141-1111-0000-0000-000000000001',
            '41414141-3333-0000-0000-000000000001',
            '2026-08-15', '2026-08-15', 480, 720, 30);
    RAISE EXCEPTION 'aceitou a mesma espera duas vezes (qualquer profissional)';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 2a — espera repetida sem profissional recusada';
  END;

  -- Mas com um profissional escolhido é outro pedido, e entra.
  INSERT INTO waitlist_entries
    (tenant_id, location_id, customer_id, professional_id, wanted_from, wanted_to,
     window_start_minute, window_end_minute, duration_minutes)
  VALUES ('41414141-0000-0000-0000-000000000001',
          '41414141-1111-0000-0000-000000000001',
          '41414141-3333-0000-0000-000000000001',
          '41414141-2222-0000-0000-000000000001',
          '2026-08-15', '2026-08-15', 480, 720, 30);
  RAISE NOTICE 'OK 2b — a mesma faixa com profissional escolhido é outro pedido';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — quem saiu da lista pode entrar de novo
--
-- O índice é parcial em `status = 'waiting'` justamente por isto: sem o
-- recorte, desistir do sábado trancaria a pessoa para fora do sábado para
-- sempre.
-- ----------------------------------------------------------------------------
UPDATE waitlist_entries
   SET status = 'left', closed_at = now()
 WHERE id = '41414141-4444-0000-0000-000000000001';

INSERT INTO waitlist_entries
  (tenant_id, location_id, customer_id, wanted_from, wanted_to,
   window_start_minute, window_end_minute, duration_minutes)
VALUES ('41414141-0000-0000-0000-000000000001',
        '41414141-1111-0000-0000-000000000001',
        '41414141-3333-0000-0000-000000000001',
        '2026-08-15', '2026-08-15', 480, 720, 30);

DO $$ BEGIN RAISE NOTICE 'OK 3 — quem saiu volta para a mesma lista'; END $$;

-- ----------------------------------------------------------------------------
-- 4 — estado terminal exige hora, e "conseguiu marcar" exige o agendamento
--
-- Sobre uma entrada **ainda esperando**: a do bloco 3 já saiu e já tem hora, e
-- reusá-la provaria menos do que diz.
-- ----------------------------------------------------------------------------
INSERT INTO waitlist_entries
  (id, tenant_id, location_id, customer_id, wanted_from, wanted_to,
   window_start_minute, window_end_minute, duration_minutes)
VALUES ('41414141-4444-0000-0000-000000000009',
        '41414141-0000-0000-0000-000000000001',
        '41414141-1111-0000-0000-000000000001',
        '41414141-3333-0000-0000-000000000001',
        '2026-09-05', '2026-09-05', 480, 720, 30);

DO $$
BEGIN
  BEGIN
    UPDATE waitlist_entries SET status = 'expired'
     WHERE id = '41414141-4444-0000-0000-000000000009';
    RAISE EXCEPTION 'aceitou estado terminal sem hora';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4a — estado terminal sem hora recusado';
  END;

  BEGIN
    UPDATE waitlist_entries SET status = 'booked', closed_at = now()
     WHERE id = '41414141-4444-0000-0000-000000000009';
    RAISE EXCEPTION 'aceitou "conseguiu marcar" sem agendamento';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4b — "conseguiu marcar" sem agendamento recusado';
  END;

  -- E o caminho certo passa: sair com hora escrita.
  UPDATE waitlist_entries SET status = 'expired', closed_at = now()
   WHERE id = '41414141-4444-0000-0000-000000000009';
  RAISE NOTICE 'OK 4c — estado terminal com hora aceito';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — a lista de uma barbearia não existe para a outra
-- ----------------------------------------------------------------------------
SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '41414141-0000-0000-0000-000000000002', true);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM waitlist_entries;
  IF n <> 0 THEN
    RAISE EXCEPTION 'a vizinha enxerga % entradas da lista alheia', n;
  END IF;
  RAISE NOTICE 'OK 5 — a lista da vizinha não mostra a desta barbearia';
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO waitlist_entries
      (tenant_id, location_id, customer_id, wanted_from, wanted_to,
       window_start_minute, window_end_minute, duration_minutes)
    VALUES ('41414141-0000-0000-0000-000000000001',
            '41414141-1111-0000-0000-000000000001',
            '41414141-3333-0000-0000-000000000001',
            '2026-08-22', '2026-08-22', 480, 720, 30);
    RAISE EXCEPTION 'a vizinha escreveu na lista da outra barbearia';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 5b — WITH CHECK impede escrever em nome de outra barbearia';
  END;
END $$;

RESET ROLE;

-- ----------------------------------------------------------------------------
-- 6 — sem tenant no contexto, a lista não existe
-- ----------------------------------------------------------------------------
SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '', true);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM waitlist_entries;
  IF n <> 0 THEN
    RAISE EXCEPTION 'sem tenant, ainda se enxerga % entradas', n;
  END IF;
  RAISE NOTICE 'OK 6 — sem tenant no contexto a lista não existe';
END $$;

RESET ROLE;

-- ----------------------------------------------------------------------------
-- 7 — os índices que as duas consultas quentes exigem
--
-- O gatilho roda **dentro da transação do cancelamento**, com a recepção
-- esperando a tela responder; o teto de três é conferido a cada entrada nova.
-- Índice junto com a query que o exige (CLAUDE.md §3).
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'waitlist_entries' AND indexname = 'waitlist_candidatos_idx'
  ) THEN
    RAISE EXCEPTION 'falta o índice dos candidatos à vaga';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'waitlist_entries' AND indexname = 'waitlist_do_cliente_idx'
  ) THEN
    RAISE EXCEPTION 'falta o índice das entradas ativas do cliente';
  END IF;
  RAISE NOTICE 'OK 7 — os dois índices quentes existem';
END $$;

ROLLBACK;
