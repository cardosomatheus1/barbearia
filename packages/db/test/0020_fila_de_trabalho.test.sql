-- ============================================================================
-- Invariantes da fila de trabalho e do registro de envio.
--
-- A fila é a primeira coisa que roda fora de uma requisição, e por isso a
-- primeira em que "duas vezes" não é hipótese: reentrega, worker reiniciado,
-- dois processos. O que impede a mensagem dupla é o banco.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('20202020-2020-2020-2020-202020202021', 'Domari'),
  ('20202020-2020-2020-2020-202020202022', 'Rival');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('a0202020-0000-0000-0000-000000000001', '20202020-2020-2020-2020-202020202021', 'Matriz', 'America/Bahia');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('c0202020-0000-0000-0000-000000000001', '20202020-2020-2020-2020-202020202021', 'Carlos', '+5571900002021');

-- ----------------------------------------------------------------------------
-- A fila
-- ----------------------------------------------------------------------------

INSERT INTO jobs (id, tenant_id, kind, payload, idempotency_key)
VALUES ('30303030-0000-0000-0000-000000000001', '20202020-2020-2020-2020-202020202021',
        'notificacao.lembrete_24h', '{"appointmentId":"x"}'::jsonb, 'lembrete_24h:ap-1');

DO $$
BEGIN
  -- Reentrega do mesmo evento não pode virar duas mensagens.
  INSERT INTO jobs (tenant_id, kind, idempotency_key)
  VALUES ('20202020-2020-2020-2020-202020202021', 'notificacao.lembrete_24h', 'lembrete_24h:ap-1');
  RAISE EXCEPTION 'aceitou duas tarefas com a mesma chave';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'OK 1 — chave de idempotência impede a tarefa duplicada';
END $$;

-- Sem chave, repetir é legítimo: varredura periódica roda sempre de novo.
INSERT INTO jobs (tenant_id, kind) VALUES ('20202020-2020-2020-2020-202020202021', 'agendamento.marcar_falta');
INSERT INTO jobs (tenant_id, kind) VALUES ('20202020-2020-2020-2020-202020202021', 'agendamento.marcar_falta');
DO $$ BEGIN RAISE NOTICE 'OK 2 — tarefa sem chave pode repetir; varredura não é evento'; END $$;

DO $$
BEGIN
  INSERT INTO jobs (tenant_id, kind) VALUES ('20202020-2020-2020-2020-202020202021', '   ');
  RAISE EXCEPTION 'aceitou tarefa sem tipo';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 3 — tarefa sem tipo é recusada; ninguém saberia o que executar';
END $$;

DO $$
BEGIN
  INSERT INTO jobs (tenant_id, kind, max_attempts) VALUES ('20202020-2020-2020-2020-202020202021', 'x', 0);
  RAISE EXCEPTION 'aceitou teto de zero tentativas';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 4 — teto de tentativas entre 1 e 20; zero nunca executaria';
END $$;

DO $$
BEGIN
  -- Tarefa sem dono não pode existir: o handler abre `withTenant` com o tenant
  -- da tarefa, e sem ele toda consulta a dado de negócio devolve zero linhas.
  -- A primeira versão permitia, para uma varredura que não podia funcionar.
  INSERT INTO jobs (kind, tenant_id) VALUES ('manutencao.varrer_faltas', NULL);
  RAISE EXCEPTION 'aceitou tarefa sem dono';
EXCEPTION WHEN not_null_violation THEN
  RAISE NOTICE 'OK 5 — toda tarefa tem tenant; sem ele nada de negócio é legível';
END $$;

DO $$
DECLARE pegou uuid;
BEGIN
  -- O padrão de tomada: `SKIP LOCKED` é o que permite dois workers sem que um
  -- espere o outro nem os dois peguem a mesma tarefa.
  SELECT id INTO pegou FROM jobs
   WHERE status = 'pending' AND run_after <= now()
   ORDER BY run_after
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF pegou IS NULL THEN
    RAISE EXCEPTION 'a fila não devolveu tarefa pronta';
  END IF;
  RAISE NOTICE 'OK 6 — FOR UPDATE SKIP LOCKED toma a próxima tarefa pronta';
END $$;

DO $$
DECLARE quantas integer;
BEGIN
  -- Tarefa com `run_after` no futuro não é "pronta". É isto que transforma a
  -- fila em agendador.
  INSERT INTO jobs (tenant_id, kind, run_after) VALUES ('20202020-2020-2020-2020-202020202021', 'notificacao.lembrete_2h', now() + interval '1 day');
  SELECT count(*) INTO quantas FROM jobs
   WHERE status = 'pending' AND run_after <= now() AND kind = 'notificacao.lembrete_2h';
  IF quantas <> 0 THEN
    RAISE EXCEPTION 'tarefa do futuro apareceu como pronta';
  END IF;
  RAISE NOTICE 'OK 7 — run_after no futuro não é tarefa pronta';
END $$;

-- ----------------------------------------------------------------------------
-- O registro de envio
-- ----------------------------------------------------------------------------

INSERT INTO notifications (id, tenant_id, kind, customer_id, status, phone_masked)
VALUES ('40404040-0000-0000-0000-000000000001', '20202020-2020-2020-2020-202020202021',
        'lembrete_24h', 'c0202020-0000-0000-0000-000000000001', 'sent', '(71) 9****-2021');

DO $$
DECLARE guardado text;
BEGIN
  SELECT phone_masked INTO guardado FROM notifications
   WHERE id = '40404040-0000-0000-0000-000000000001';
  IF guardado LIKE '%900002021%' THEN
    RAISE EXCEPTION 'o número inteiro vazou para o registro de envio';
  END IF;
  RAISE NOTICE 'OK 8 — o registro guarda o telefone mascarado, não o número';
END $$;

-- ----------------------------------------------------------------------------
-- Consentimento
-- ----------------------------------------------------------------------------

DO $$
DECLARE aceita boolean;
BEGIN
  SELECT accepts_marketing INTO aceita FROM customers
   WHERE id = 'c0202020-0000-0000-0000-000000000001';
  IF aceita THEN
    RAISE EXCEPTION 'cliente nasceu aceitando marketing';
  END IF;
  RAISE NOTICE 'OK 9 — consentimento de marketing é opt-in; o padrão é não';
END $$;

DO $$
DECLARE dias smallint;
BEGIN
  SELECT comeback_after_days INTO dias FROM locations
   WHERE id = 'a0202020-0000-0000-0000-000000000001';
  IF dias IS NULL THEN
    RAISE EXCEPTION 'unidade sem prazo de retorno';
  END IF;
  RAISE NOTICE 'OK 10 — a unidade nasce com prazo de retorno, e a mensagem desligada';
END $$;

DO $$
BEGIN
  UPDATE locations SET comeback_after_days = 2
   WHERE id = 'a0202020-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'aceitou prazo de retorno de dois dias';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 11 — prazo de retorno entre 7 e 365 dias; dois dias é perseguição';
END $$;

-- ----------------------------------------------------------------------------
-- A parede entre barbearias
-- ----------------------------------------------------------------------------

SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '20202020-2020-2020-2020-202020202022', true);

DO $$
DECLARE quantas integer;
BEGIN
  SELECT count(*) INTO quantas FROM notifications;
  IF quantas <> 0 THEN
    RAISE EXCEPTION 'a rival enxergou % envio(s) da casa', quantas;
  END IF;
  RAISE NOTICE 'OK 12 — envio de uma barbearia não existe para a outra';
END $$;

DO $$
BEGIN
  UPDATE notifications SET status = 'skipped';
  RAISE EXCEPTION 'a aplicação alterou registro de envio';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'OK 13 — registro de envio é append-only: "foi avisado?" não se reescreve';
END $$;

DO $$
BEGIN
  DELETE FROM notifications;
  RAISE EXCEPTION 'a aplicação apagou registro de envio';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'OK 14 — nem apagar';
END $$;

DO $$
DECLARE quantas integer;
BEGIN
  -- A fila **não** tem RLS de propósito: o worker roda sem tenant no contexto.
  -- O que protege o dado de negócio é a RLS das tabelas que a tarefa toca, e o
  -- payload guarda id, nunca conteúdo.
  SELECT count(*) INTO quantas FROM jobs;
  IF quantas = 0 THEN
    RAISE EXCEPTION 'a fila ficou invisível para a aplicação; o worker não rodaria';
  END IF;
  RAISE NOTICE 'OK 15 — a fila é infraestrutura e é legível sem tenant no contexto';
END $$;

RESET ROLE;

DO $$ BEGIN RAISE NOTICE '--- invariantes da fila de trabalho passaram ---'; END $$;

ROLLBACK;
