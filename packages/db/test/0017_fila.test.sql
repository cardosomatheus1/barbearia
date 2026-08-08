-- ============================================================================
-- Invariantes da fila presencial.
--
-- O que se prova aqui é do banco, não da aplicação: mock não testa constraint
-- nem RLS. Cada bloco falha com exceção; saída limpa é tudo passou.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

-- Ids próprios: a prova do 0001 faz commit e deixa os dela no banco. Reusar os
-- mesmos ids faria esta abortar na primeira linha, com a colisão travestida de
-- "arquivo não rodou".
INSERT INTO tenants (id, name) VALUES
  ('77777777-7777-7777-7777-777777777771', 'Domari'),
  ('77777777-7777-7777-7777-777777777772', 'Rival');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('aaaaaaaa-7777-0000-0000-000000000001', '77777777-7777-7777-7777-777777777771', 'Matriz', 'America/Bahia'),
  ('aaaaaaaa-7777-0000-0000-000000000002', '77777777-7777-7777-7777-777777777772', 'Rival', 'America/Bahia');

INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
  ('bbbbbbbb-7777-0000-0000-000000000001', '77777777-7777-7777-7777-777777777771', 'aaaaaaaa-7777-0000-0000-000000000001', 'Ruan', 'professional');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('cccccccc-7777-0000-0000-000000000001', '77777777-7777-7777-7777-777777777771', 'Carlos', '+5571900001111'),
  ('cccccccc-7777-0000-0000-000000000002', '77777777-7777-7777-7777-777777777771', 'Joao', '+5571900002222'),
  ('cccccccc-7777-0000-0000-000000000009', '77777777-7777-7777-7777-777777777772', 'Do Rival', '+5571900003333');

INSERT INTO queue_entries (id, tenant_id, location_id, customer_id, public_token_hash) VALUES
  ('dddddddd-7777-0000-0000-000000000001', '77777777-7777-7777-7777-777777777771',
   'aaaaaaaa-7777-0000-0000-000000000001', 'cccccccc-7777-0000-0000-000000000001', 'hash-do-carlos');

-- ----------------------------------------------------------------------------
-- A mesma pessoa não entra duas vezes na fila viva
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  INSERT INTO queue_entries (tenant_id, location_id, customer_id, public_token_hash)
  VALUES ('77777777-7777-7777-7777-777777777771', 'aaaaaaaa-7777-0000-0000-000000000001',
          'cccccccc-7777-0000-0000-000000000001', 'hash-repetido');
  RAISE EXCEPTION 'FALHOU: mesma pessoa entrou duas vezes na fila viva';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'OK 1 — duplo toque na recepção não põe a mesma pessoa duas vezes na fila';
END $$;

-- Mas depois de sair, pode voltar: quem cortou de manhã e volta à tarde é
-- cliente, não duplicata. O índice é parcial exatamente por isso.
DO $$
DECLARE nova uuid;
BEGIN
  UPDATE queue_entries SET status = 'gave_up', finished_at = now()
   WHERE id = 'dddddddd-7777-0000-0000-000000000001';

  INSERT INTO queue_entries (tenant_id, location_id, customer_id, public_token_hash)
  VALUES ('77777777-7777-7777-7777-777777777771', 'aaaaaaaa-7777-0000-0000-000000000001',
          'cccccccc-7777-0000-0000-000000000001', 'hash-da-volta')
  RETURNING id INTO nova;

  IF nova IS NULL THEN
    RAISE EXCEPTION 'FALHOU: quem já saiu da fila não conseguiu voltar';
  END IF;
  RAISE NOTICE 'OK 2 — quem saiu da fila pode entrar de novo mais tarde';

  DELETE FROM queue_entries WHERE id = nova;
  UPDATE queue_entries SET status = 'waiting', finished_at = NULL
   WHERE id = 'dddddddd-7777-0000-0000-000000000001';
END $$;

-- ----------------------------------------------------------------------------
-- O token do link é único e nunca fica em claro nesta tabela
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  INSERT INTO queue_entries (tenant_id, location_id, customer_id, public_token_hash)
  VALUES ('77777777-7777-7777-7777-777777777771', 'aaaaaaaa-7777-0000-0000-000000000001',
          'cccccccc-7777-0000-0000-000000000002', 'hash-do-carlos');
  RAISE EXCEPTION 'FALHOU: dois na fila com o mesmo token — um veria a posição do outro';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'OK 3 — token do link de acompanhamento é único';
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'queue_entries' AND column_name = 'public_token'
  ) THEN
    RAISE EXCEPTION 'FALHOU: existe coluna de token em claro';
  END IF;
  RAISE NOTICE 'OK 4 — só o hash do token é guardado';
END $$;

-- ----------------------------------------------------------------------------
-- Estados coerentes
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  UPDATE queue_entries SET status = 'done' WHERE id = 'dddddddd-7777-0000-0000-000000000001';
  RAISE EXCEPTION 'FALHOU: entrada terminou sem hora de término';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 5 — estado terminal exige hora de término';
END $$;

DO $$
BEGIN
  UPDATE queue_entries SET status = 'in_service', started_at = now()
   WHERE id = 'dddddddd-7777-0000-0000-000000000001';
  RAISE EXCEPTION 'FALHOU: em atendimento sem agendamento — não vira comanda nem comissão';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 6 — em atendimento exige o agendamento que nasceu dali';
END $$;

DO $$
BEGIN
  UPDATE queue_entries SET called_at = joined_at - interval '5 minutes'
   WHERE id = 'dddddddd-7777-0000-0000-000000000001';
  RAISE EXCEPTION 'FALHOU: chamado antes de chegar';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 7 — ninguém é chamado antes de entrar na fila';
END $$;

-- ----------------------------------------------------------------------------
-- Isolamento entre barbearias, com o role da aplicação
-- ----------------------------------------------------------------------------

SET ROLE barbearia_app;

DO $$
DECLARE visiveis int;
BEGIN
  PERFORM set_config('app.tenant_id', '77777777-7777-7777-7777-777777777772', true);
  -- Consulta sem filtro nenhum: quem filtra é a política, não o WHERE.
  SELECT count(*) INTO visiveis FROM queue_entries;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'FALHOU: rival enxergou % entradas da fila alheia', visiveis;
  END IF;
  RAISE NOTICE 'OK 8 — a fila de uma barbearia não aparece para a outra';
END $$;

DO $$
BEGIN
  PERFORM set_config('app.tenant_id', '77777777-7777-7777-7777-777777777772', true);
  INSERT INTO queue_entries (tenant_id, location_id, customer_id, public_token_hash)
  VALUES ('77777777-7777-7777-7777-777777777771', 'aaaaaaaa-7777-0000-0000-000000000001',
          'cccccccc-7777-0000-0000-000000000001', 'hash-invasor');
  RAISE EXCEPTION 'FALHOU: gravou entrada na fila de outra barbearia';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'OK 9 — não se põe ninguém na fila de outra barbearia';
END $$;

DO $$
DECLARE afetadas int;
BEGIN
  PERFORM set_config('app.tenant_id', '77777777-7777-7777-7777-777777777772', true);
  UPDATE queue_entries SET status = 'gave_up', finished_at = now();
  GET DIAGNOSTICS afetadas = ROW_COUNT;
  IF afetadas <> 0 THEN
    RAISE EXCEPTION 'FALHOU: rival desistiu por % pessoas da fila alheia', afetadas;
  END IF;
  RAISE NOTICE 'OK 10 — o rival não tira ninguém da fila da casa';
END $$;

DO $$
DECLARE sem_tenant int;
BEGIN
  PERFORM set_config('app.tenant_id', '', true);
  SELECT count(*) INTO sem_tenant FROM queue_entries;
  IF sem_tenant <> 0 THEN
    RAISE EXCEPTION 'FALHOU: fila visível sem tenant no contexto';
  END IF;
  RAISE NOTICE 'OK 11 — sem tenant no contexto a fila não existe';
END $$;

RESET ROLE;

ROLLBACK;

DO $$ BEGIN RAISE NOTICE '--- invariantes da fila passaram ---'; END $$;
