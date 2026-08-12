-- ============================================================================
-- Invariantes das avaliações (bloco 43).
--
-- O que se prova aqui é o limite ético da SPEC §4.10 escrito onde não depende
-- de ninguém lembrar: não se apaga avaliação, não se reescreve a nota, e a
-- resolução não é um botão de "resolvido" sem conteúdo.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('43434343-0000-0000-0000-000000000001', 'Domari'),
  ('43434343-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('43434343-1111-0000-0000-000000000001',
   '43434343-0000-0000-0000-000000000001', 'Centro', 'America/Bahia');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('43434343-3333-0000-0000-000000000001',
   '43434343-0000-0000-0000-000000000001', 'Carlos', '+5571988887777');

INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
  ('43434343-4444-0000-0000-000000000001',
   '43434343-0000-0000-0000-000000000001',
   '43434343-1111-0000-0000-000000000001', 'Ruan');

INSERT INTO appointments
  (id, tenant_id, location_id, customer_id, professional_id,
   starts_at, ends_at, service_starts_at, service_ends_at, price_cents, status)
VALUES ('43434343-5555-0000-0000-000000000001',
        '43434343-0000-0000-0000-000000000001',
        '43434343-1111-0000-0000-000000000001',
        '43434343-3333-0000-0000-000000000001',
        '43434343-4444-0000-0000-000000000001',
        '2026-09-20T13:00:00Z', '2026-09-20T13:30:00Z',
        '2026-09-20T13:00:00Z', '2026-09-20T13:30:00Z', 5000, 'completed');

INSERT INTO reviews (id, tenant_id, appointment_id, customer_id, professional_id, rating, comment)
VALUES ('43434343-6666-0000-0000-000000000001',
        '43434343-0000-0000-0000-000000000001',
        '43434343-5555-0000-0000-000000000001',
        '43434343-3333-0000-0000-000000000001',
        '43434343-4444-0000-0000-000000000001', 2, 'Esperei quarenta minutos');

-- ----------------------------------------------------------------------------
-- 1 — um atendimento, uma avaliação
--
-- A garantia é do banco: a checagem na aplicação perde a corrida entre dois
-- toques no mesmo botão, e a segunda nota entraria na média do barbeiro.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO reviews (tenant_id, appointment_id, customer_id, rating)
    VALUES ('43434343-0000-0000-0000-000000000001',
            '43434343-5555-0000-0000-000000000001',
            '43434343-3333-0000-0000-000000000001', 5);
    RAISE EXCEPTION 'aceitou duas avaliações do mesmo atendimento';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 1 — uma avaliação por atendimento';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — a nota não se reescreve
--
-- `REVOKE DELETE` sozinho não bastaria: `UPDATE SET rating = 5` é apagar a
-- avaliação ruim com outro nome, e seria o caminho mais curto para exatamente
-- o que a SPEC §4.10 proíbe.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE reviews SET rating = 5 WHERE id = '43434343-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou reescrever a nota';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2a — a nota é imutável';
  END;

  BEGIN
    UPDATE reviews SET comment = 'Ótimo!' WHERE id = '43434343-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou reescrever o comentário';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2b — o comentário é imutável';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — a resolução escreve, e escreve de verdade
--
-- "Resolvido" sozinho não é registro de nada: seis meses depois ninguém sabe se
-- ligaram, se refizeram o corte ou se desistiram.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE reviews SET resolved_at = now()
     WHERE id = '43434343-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou resolução sem desfecho nem texto';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3a — resolução exige desfecho e texto';
  END;

  BEGIN
    UPDATE reviews
       SET resolved_at = now(), outcome = 'contato', resolution_note = 'ok'
     WHERE id = '43434343-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou resolução com texto vazio de conteúdo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3b — o texto da resolução tem piso';
  END;
END $$;

-- A resolução válida passa, e o gatilho de imutabilidade não atrapalha.
UPDATE reviews
   SET resolved_at = now(), outcome = 'retrabalho',
       resolution_note = 'Liguei e refiz o corte na quinta.'
 WHERE id = '43434343-6666-0000-0000-000000000001';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM reviews
     WHERE id = '43434343-6666-0000-0000-000000000001' AND resolved_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a resolução válida não gravou';
  END IF;
  RAISE NOTICE 'OK 3c — a resolução válida grava';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — nota fora da escala é recusada
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO reviews (tenant_id, appointment_id, customer_id, rating)
    VALUES ('43434343-0000-0000-0000-000000000001',
            '43434343-5555-0000-0000-000000000001',
            '43434343-3333-0000-0000-000000000001', 0);
    RAISE EXCEPTION 'aceitou nota zero';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4 — a nota vai de 1 a 5';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — a aplicação não apaga avaliação
--
-- A SPEC §4.10: *"O produto não pode oferecer 'apagar avaliação ruim'.
-- Suprimir review é o que destrói a credibilidade de plataforma de avaliação —
-- e é risco jurídico."* Aqui isso deixa de depender de alguém lembrar.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  pode_apagar boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    RAISE NOTICE 'PULADO 5 — sem role da aplicação neste banco';
    RETURN;
  END IF;

  SELECT has_table_privilege('barbearia_app', 'reviews', 'DELETE') INTO pode_apagar;
  IF pode_apagar THEN
    RAISE EXCEPTION 'a aplicação pode apagar avaliação';
  END IF;
  RAISE NOTICE 'OK 5 — não existe caminho para apagar avaliação';
END $$;

-- ----------------------------------------------------------------------------
-- 6 — não existe permissão de apagar avaliação no catálogo
--
-- A segunda metade da mesma decisão: o privilégio não existe no banco, e a
-- permissão não existe na lista — nem para o dono conceder por engano.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO role_permissions (tenant_id, role, permission)
    VALUES ('43434343-0000-0000-0000-000000000001', 'manager', 'reviews.delete');
    RAISE EXCEPTION 'o catálogo aceitou uma permissão de apagar avaliação';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6a — reviews.delete não existe';
  END;

  INSERT INTO role_permissions (tenant_id, role, permission) VALUES
    ('43434343-0000-0000-0000-000000000001', 'manager', 'reviews.view'),
    ('43434343-0000-0000-0000-000000000001', 'manager', 'reviews.recover');
  RAISE NOTICE 'OK 6b — as duas permissões do bloco são válidas';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — a vizinha não lê nem grava avaliação nesta casa
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  visiveis integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    RAISE NOTICE 'PULADO 7 — sem role da aplicação neste banco';
    RETURN;
  END IF;

  SET LOCAL ROLE barbearia_app;
  PERFORM set_config('app.tenant_id', '43434343-0000-0000-0000-000000000002', true);

  -- Sem filtro nenhum no WHERE: quem filtra é a política, e é isso que se prova.
  SELECT count(*) INTO visiveis FROM reviews;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'a vizinha enxergou % avaliações desta casa', visiveis;
  END IF;

  BEGIN
    INSERT INTO reviews (tenant_id, appointment_id, customer_id, rating)
    VALUES ('43434343-0000-0000-0000-000000000001',
            '43434343-5555-0000-0000-000000000001',
            '43434343-3333-0000-0000-000000000001', 1);
    RAISE EXCEPTION 'a vizinha gravou avaliação na casa alheia';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 7 — WITH CHECK recusa gravar em tenant alheio';
  END;

  RESET ROLE;
END $$;

ROLLBACK;
