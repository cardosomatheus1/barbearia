-- ============================================================================
-- Invariantes da oferta de vaga (bloco 39).
--
-- O que se prova aqui é o que separa Priority Queue de First Come: **uma oferta
-- viva por vaga** e **uma por pessoa**. Sem as duas, o produto avisa cinco
-- clientes do mesmo horário e quatro descobrem que perderam — que é justamente
-- o modo que a SPEC §2.9 não recomenda.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('42424242-0000-0000-0000-000000000001', 'Domari'),
  ('42424242-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('42424242-1111-0000-0000-000000000001',
   '42424242-0000-0000-0000-000000000001', 'Centro', 'America/Bahia');

INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
  ('42424242-2222-0000-0000-000000000001',
   '42424242-0000-0000-0000-000000000001',
   '42424242-1111-0000-0000-000000000001', 'Ruan'),
  ('42424242-2222-0000-0000-000000000002',
   '42424242-0000-0000-0000-000000000001',
   '42424242-1111-0000-0000-000000000001', 'Gleidson');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('42424242-3333-0000-0000-000000000001',
   '42424242-0000-0000-0000-000000000001', 'Carlos', '+5571988887777'),
  ('42424242-3333-0000-0000-000000000002',
   '42424242-0000-0000-0000-000000000001', 'Bruno', '+5571977776666'),
  ('42424242-3333-0000-0000-000000000003',
   '42424242-0000-0000-0000-000000000001', 'Daniel', '+5571966665555'),
  ('42424242-3333-0000-0000-000000000004',
   '42424242-0000-0000-0000-000000000001', 'Elias', '+5571955554444');

INSERT INTO waitlist_entries
  (id, tenant_id, location_id, customer_id, wanted_from, wanted_to,
   window_start_minute, window_end_minute, duration_minutes)
VALUES
  ('42424242-4444-0000-0000-000000000001',
   '42424242-0000-0000-0000-000000000001',
   '42424242-1111-0000-0000-000000000001',
   '42424242-3333-0000-0000-000000000001',
   '2026-09-08', '2026-09-08', 480, 720, 30),
  ('42424242-4444-0000-0000-000000000002',
   '42424242-0000-0000-0000-000000000001',
   '42424242-1111-0000-0000-000000000001',
   '42424242-3333-0000-0000-000000000002',
   '2026-09-08', '2026-09-08', 480, 720, 30),
  -- Duas entradas sem oferta nenhuma, para as invariantes que precisam de uma
  -- pessoa limpa: reusar quem já tem convite vivo faria o índice da **entrada**
  -- disparar no lugar do que se quer provar, e o teste passaria pelo motivo
  -- errado.
  ('42424242-4444-0000-0000-000000000003',
   '42424242-0000-0000-0000-000000000001',
   '42424242-1111-0000-0000-000000000001',
   '42424242-3333-0000-0000-000000000003',
   '2026-09-08', '2026-09-12', 480, 720, 30),
  ('42424242-4444-0000-0000-000000000004',
   '42424242-0000-0000-0000-000000000001',
   '42424242-1111-0000-0000-000000000001',
   '42424242-3333-0000-0000-000000000004',
   '2026-09-08', '2026-09-12', 480, 720, 30);

-- ----------------------------------------------------------------------------
-- 1 — a oferta nasce com prazo no futuro e janela coerente
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO waitlist_offers
      (tenant_id, entry_id, professional_id, starts_at, ends_at, service_starts_at, expires_at, token_hash)
    VALUES ('42424242-0000-0000-0000-000000000001',
            '42424242-4444-0000-0000-000000000001',
            '42424242-2222-0000-0000-000000000001',
            '2026-09-08T12:00:00Z', '2026-09-08T11:00:00Z', '2026-09-08T12:00:00Z',
            now() + interval '10 min', 'hash-1');
    RAISE EXCEPTION 'aceitou janela invertida';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1a — janela invertida recusada';
  END;

  BEGIN
    -- Prazo no passado é oferta que nasce vencida: a pessoa recebe a mensagem e
    -- descobre que já perdeu.
    INSERT INTO waitlist_offers
      (tenant_id, entry_id, professional_id, starts_at, ends_at, service_starts_at,
       offered_at, expires_at, token_hash)
    VALUES ('42424242-0000-0000-0000-000000000001',
            '42424242-4444-0000-0000-000000000001',
            '42424242-2222-0000-0000-000000000001',
            '2026-09-08T12:00:00Z', '2026-09-08T12:30:00Z', '2026-09-08T12:00:00Z',
            now(), now() - interval '1 min', 'hash-2');
    RAISE EXCEPTION 'aceitou prazo no passado';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1b — prazo no passado recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — uma oferta viva por vaga
--
-- É o que separa Priority Queue de First Come. Duas ofertas abertas para o
-- mesmo horário são duas pessoas com direito exclusivo à mesma coisa.
-- ----------------------------------------------------------------------------
INSERT INTO waitlist_offers
  (id, tenant_id, entry_id, professional_id, starts_at, ends_at, service_starts_at, expires_at, token_hash)
VALUES ('42424242-5555-0000-0000-000000000001',
        '42424242-0000-0000-0000-000000000001',
        '42424242-4444-0000-0000-000000000001',
        '42424242-2222-0000-0000-000000000001',
        '2026-09-08T12:00:00Z', '2026-09-08T12:30:00Z', '2026-09-08T12:00:00Z',
        now() + interval '10 min', 'hash-viva-1');

DO $$
BEGIN
  BEGIN
    INSERT INTO waitlist_offers
      (tenant_id, entry_id, professional_id, starts_at, ends_at, service_starts_at, expires_at, token_hash)
    VALUES ('42424242-0000-0000-0000-000000000001',
            '42424242-4444-0000-0000-000000000002',
            '42424242-2222-0000-0000-000000000001',
            '2026-09-08T12:00:00Z', '2026-09-08T12:30:00Z', '2026-09-08T12:00:00Z',
            now() + interval '10 min', 'hash-viva-2');
    RAISE EXCEPTION 'aceitou duas ofertas vivas para a mesma vaga';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 2a — uma oferta viva por vaga';
  END;

  -- O mesmo horário em **outra cadeira** é outra vaga, e pode ser oferecido.
  INSERT INTO waitlist_offers
    (tenant_id, entry_id, professional_id, starts_at, ends_at, service_starts_at, expires_at, token_hash)
  VALUES ('42424242-0000-0000-0000-000000000001',
          '42424242-4444-0000-0000-000000000002',
          '42424242-2222-0000-0000-000000000002',
          '2026-09-08T12:00:00Z', '2026-09-08T12:30:00Z', '2026-09-08T12:00:00Z',
          now() + interval '10 min', 'hash-viva-3');
  RAISE NOTICE 'OK 2b — a mesma hora em outra cadeira é outra vaga';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — uma oferta viva por pessoa
--
-- Sem isto a mesma pessoa recebe duas mensagens ao mesmo tempo, ambas
-- exclusivas por dez minutos, e só consegue aceitar uma.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO waitlist_offers
      (tenant_id, entry_id, professional_id, starts_at, ends_at, service_starts_at, expires_at, token_hash)
    VALUES ('42424242-0000-0000-0000-000000000001',
            '42424242-4444-0000-0000-000000000001',
            '42424242-2222-0000-0000-000000000002',
            '2026-09-08T15:00:00Z', '2026-09-08T15:30:00Z', '2026-09-08T15:00:00Z',
            now() + interval '10 min', 'hash-viva-4');
    RAISE EXCEPTION 'aceitou duas ofertas vivas para a mesma entrada';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 3 — uma oferta viva por pessoa';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — encerrar exige hora, e "aceita" exige o agendamento
--
-- Sem a hora de resposta não há como medir conversão depois — e "a fila
-- funciona?" é a pergunta que decide se ela continua existindo.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE waitlist_offers SET status = 'vencida'
     WHERE id = '42424242-5555-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou estado terminal sem hora de resposta';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4a — estado terminal sem hora recusado';
  END;

  BEGIN
    UPDATE waitlist_offers SET status = 'aceita', answered_at = now()
     WHERE id = '42424242-5555-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou "aceita" sem agendamento';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4b — "aceita" sem agendamento recusado';
  END;

  UPDATE waitlist_offers SET status = 'vencida', answered_at = now()
   WHERE id = '42424242-5555-0000-0000-000000000001';
  RAISE NOTICE 'OK 4c — vencida com hora aceita';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — encerrada a primeira, a vaga aceita a segunda
--
-- O índice é parcial em `status = 'aberta'` justamente por isto: sem o recorte,
-- a primeira recusa trancaria aquele horário para sempre — e passar ao próximo
-- da fila é o que a SPEC pede.
-- ----------------------------------------------------------------------------
INSERT INTO waitlist_offers
  (tenant_id, entry_id, professional_id, starts_at, ends_at, service_starts_at, expires_at, token_hash)
VALUES ('42424242-0000-0000-0000-000000000001',
        '42424242-4444-0000-0000-000000000001',
        '42424242-2222-0000-0000-000000000001',
        '2026-09-08T12:00:00Z', '2026-09-08T12:30:00Z', '2026-09-08T12:00:00Z',
        now() + interval '10 min', 'hash-segunda-volta');

DO $$ BEGIN RAISE NOTICE 'OK 5 — vencida a primeira, a vaga vai ao próximo'; END $$;

-- ----------------------------------------------------------------------------
-- 6 — o token é guardado só como hash
--
-- Ele é a credencial que aceita a oferta sem sessão. Em claro, quem lesse a
-- tabela marcaria o horário de qualquer pessoa — é a mesma decisão do token da
-- fila presencial (migração 0017).
-- ----------------------------------------------------------------------------
DO $$
DECLARE colunas int;
BEGIN
  SELECT count(*) INTO colunas
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'waitlist_offers'
     AND column_name IN ('token', 'public_token', 'token_plain');
  IF colunas > 0 THEN
    RAISE EXCEPTION 'existe coluna de token em claro na oferta';
  END IF;
  RAISE NOTICE 'OK 6 — só o hash do token é guardado';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — a barbearia vizinha não enxerga nem escreve estas ofertas
-- ----------------------------------------------------------------------------
SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '42424242-0000-0000-0000-000000000002', true);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM waitlist_offers;
  IF n <> 0 THEN
    RAISE EXCEPTION 'a vizinha enxerga % ofertas alheias', n;
  END IF;
  RAISE NOTICE 'OK 7 — as ofertas da vizinha não mostram as desta barbearia';
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO waitlist_offers
      (tenant_id, entry_id, professional_id, starts_at, ends_at, service_starts_at, expires_at, token_hash)
    VALUES ('42424242-0000-0000-0000-000000000001',
            '42424242-4444-0000-0000-000000000002',
            '42424242-2222-0000-0000-000000000001',
            '2026-09-09T12:00:00Z', '2026-09-09T12:30:00Z', '2026-09-09T12:00:00Z',
            now() + interval '10 min', 'hash-da-vizinha');
    RAISE EXCEPTION 'a vizinha escreveu oferta na barbearia alheia';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 7b — WITH CHECK impede oferecer em nome de outra barbearia';
  END;
END $$;

RESET ROLE;

-- ----------------------------------------------------------------------------
-- 9 — o início do serviço cai dentro da vaga segurada
--
-- A janela gravada é a **ocupada**, com buffers; o que se marca e o que se
-- anuncia é o início do serviço. Fora da vaga, o aceite marcaria um horário que
-- a barbearia não tirou da grade para ninguém.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO waitlist_offers
      (tenant_id, entry_id, professional_id, starts_at, ends_at, service_starts_at,
       expires_at, token_hash)
    VALUES ('42424242-0000-0000-0000-000000000001',
            '42424242-4444-0000-0000-000000000003',
            '42424242-2222-0000-0000-000000000001',
            '2026-09-10T12:00:00Z', '2026-09-10T12:30:00Z',
            '2026-09-10T11:50:00Z',
            now() + interval '10 min', 'hash-servico-fora');
    RAISE EXCEPTION 'aceitou início de serviço fora da vaga';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 9 — início de serviço fora da vaga recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 10 — "aceitando" conta como oferta viva
--
-- É o estado entre o resgate do convite e o agendamento existir. Se ele não
-- contasse, a vaga aceitaria uma segunda oferta exatamente na janela que o
-- estado existe para fechar — e duas pessoas marcariam o mesmo horário.
-- ----------------------------------------------------------------------------
INSERT INTO waitlist_offers
  (id, tenant_id, entry_id, professional_id, starts_at, ends_at, service_starts_at,
   expires_at, token_hash)
VALUES ('42424242-5555-0000-0000-000000000009',
        '42424242-0000-0000-0000-000000000001',
        '42424242-4444-0000-0000-000000000003',
        '42424242-2222-0000-0000-000000000001',
        '2026-09-11T12:00:00Z', '2026-09-11T12:30:00Z', '2026-09-11T12:00:00Z',
        now() + interval '10 min', 'hash-aceitando');

DO $$
BEGIN
  -- `aceitando` não é terminal: ela não exige hora de resposta nem agendamento.
  UPDATE waitlist_offers SET status = 'aceitando'
   WHERE id = '42424242-5555-0000-0000-000000000009';
  RAISE NOTICE 'OK 10a — aceitando não exige hora de resposta';

  BEGIN
    INSERT INTO waitlist_offers
      (tenant_id, entry_id, professional_id, starts_at, ends_at, service_starts_at,
       expires_at, token_hash)
    VALUES ('42424242-0000-0000-0000-000000000001',
            '42424242-4444-0000-0000-000000000004',
            '42424242-2222-0000-0000-000000000001',
            '2026-09-11T12:00:00Z', '2026-09-11T12:30:00Z', '2026-09-11T12:00:00Z',
            now() + interval '10 min', 'hash-durante-aceite');
    RAISE EXCEPTION 'ofereceu a vaga enquanto alguém a resgatava';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 10b — a vaga em resgate não é oferecida a mais ninguém';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 8 — o aviso de vaga entrou no vocabulário de notificação
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'notification_kind' AND e.enumlabel = 'vaga_liberada'
  ) THEN
    RAISE EXCEPTION 'falta o tipo de aviso da vaga liberada';
  END IF;
  RAISE NOTICE 'OK 8 — vaga_liberada existe como tipo de aviso';
END $$;

ROLLBACK;
