-- ============================================================================
-- Invariantes da tolerância do combo.
--
-- Ela existe para a regra V1 do validador poder distinguir o combo pensado do
-- combo esquecido. O que se prova aqui: que o padrão não perdoa ninguém, e que
-- não dá para calar o validador com um número absurdo.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('23232323-0000-0000-0000-000000000001', 'Domari');

INSERT INTO service_combos (id, tenant_id, name, declared_duration_minutes)
VALUES ('c3232323-0000-0000-0000-000000000001', '23232323-0000-0000-0000-000000000001',
        'Cabelo + Barba', 60);

DO $$
DECLARE padrao smallint;
BEGIN
  SELECT tolerance_minutes INTO padrao FROM service_combos
   WHERE id = 'c3232323-0000-0000-0000-000000000001';
  IF padrao <> 0 THEN
    RAISE EXCEPTION 'o combo nasceu com folga que ninguém declarou';
  END IF;
  RAISE NOTICE 'OK 1 — tolerância padrão é zero; combo esquecido aparece no validador';
END $$;

DO $$
BEGIN
  UPDATE service_combos SET tolerance_minutes = 90
   WHERE id = 'c3232323-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'aceitou tolerância de uma hora e meia';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 2 — teto de 60 min; acima disso é jeito de calar o validador';
END $$;

DO $$
BEGIN
  UPDATE service_combos SET tolerance_minutes = -5
   WHERE id = 'c3232323-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'aceitou tolerância negativa';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 3 — tolerância negativa não é nada; a regra já cobre o combo curto';
END $$;

DO $$
BEGIN
  UPDATE service_combos SET tolerance_minutes = 10
   WHERE id = 'c3232323-0000-0000-0000-000000000001';
  RAISE NOTICE 'OK 4 — a casa declara quanto ganha fazendo os dois na sequência';
END $$;

ROLLBACK;
