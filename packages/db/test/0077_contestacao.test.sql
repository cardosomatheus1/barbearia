-- ============================================================================
-- Invariantes da contestação (bloco 80).
--
-- O bloco inteiro se resume a uma frase: **contestar não é apagar**. O que se
-- prova aqui é essa frase escrita onde não depende de ninguém lembrar dela —
-- o motivo é obrigatório, a justificativa tem piso, a contestação não se
-- reescreve, e a nota continua tão imutável quanto era antes.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('80808080-0000-0000-0000-000000000001', 'Domari'),
  ('80808080-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('80808080-1111-0000-0000-000000000001',
   '80808080-0000-0000-0000-000000000001', 'Centro', 'America/Bahia');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('80808080-3333-0000-0000-000000000001',
   '80808080-0000-0000-0000-000000000001', 'Carlos', '+5571988887766');

INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
  ('80808080-4444-0000-0000-000000000001',
   '80808080-0000-0000-0000-000000000001',
   '80808080-1111-0000-0000-000000000001', 'Ruan');

INSERT INTO appointments
  (id, tenant_id, location_id, customer_id, professional_id,
   starts_at, ends_at, service_starts_at, service_ends_at, price_cents, status)
VALUES ('80808080-5555-0000-0000-000000000001',
        '80808080-0000-0000-0000-000000000001',
        '80808080-1111-0000-0000-000000000001',
        '80808080-3333-0000-0000-000000000001',
        '80808080-4444-0000-0000-000000000001',
        '2026-09-20T13:00:00Z', '2026-09-20T13:30:00Z',
        '2026-09-20T13:00:00Z', '2026-09-20T13:30:00Z', 5000, 'completed');

INSERT INTO reviews (id, tenant_id, appointment_id, customer_id, professional_id, rating, comment)
VALUES ('80808080-6666-0000-0000-000000000001',
        '80808080-0000-0000-0000-000000000001',
        '80808080-5555-0000-0000-000000000001',
        '80808080-3333-0000-0000-000000000001',
        '80808080-4444-0000-0000-000000000001', 1, 'Compre seguidores no site tal');

-- ----------------------------------------------------------------------------
-- 1 — contestar sem motivo, ou sem justificativa, não é contestar
--
-- O `CHECK` recusa a contestação pela metade. Sem ele, um `UPDATE` que gravasse
-- só `contested_at` tiraria a nota do ar sem deixar por escrito por quê — que é
-- exatamente "apagar" com outro nome.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE reviews SET contested_at = now()
     WHERE id = '80808080-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'contestou sem motivo nem justificativa';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1a — contestacao pela metade e recusada';
  END;

  BEGIN
    UPDATE reviews
       SET contested_at = now(), contest_reason = 'spam', contest_note = 'spam'
     WHERE id = '80808080-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou justificativa de quatro caracteres';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1b — a justificativa tem piso de dez caracteres';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — contestada, a nota e o texto continuam imutáveis
--
-- É a garantia do bloco 43, e o que se prova aqui é que a contestação não a
-- afrouxou: um `UPDATE SET rating = 5` continua sendo apagar a avaliação ruim
-- com outro nome, contestada ou não.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  UPDATE reviews
     SET contested_at = '2026-09-21T10:00:00Z',
         contest_reason = 'spam',
         contest_note = 'Texto de propaganda, o mesmo que apareceu em outras barbearias da rua'
   WHERE id = '80808080-6666-0000-0000-000000000001';
  RAISE NOTICE 'OK 2a — a contestacao completa e aceita';

  BEGIN
    UPDATE reviews SET rating = 5 WHERE id = '80808080-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'reescreveu a nota de uma avaliacao contestada';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2b — a nota continua imutavel';
  END;

  BEGIN
    UPDATE reviews SET comment = NULL WHERE id = '80808080-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'apagou o comentario de uma avaliacao contestada';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2c — o comentario continua imutavel';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — a contestação também não se reescreve
--
-- Trocar o motivo depois de gravado apagaria o registro de por que a casa
-- suspendeu a nota — que é justamente o que torna a suspensão auditável em vez
-- de discricionária. Descontestar, idem: o caminho é gravar de novo, e ele não
-- existe de propósito.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE reviews SET contest_reason = 'ofensa'
     WHERE id = '80808080-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'trocou o motivo da contestacao';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3a — o motivo nao se reescreve';
  END;

  BEGIN
    UPDATE reviews SET contest_note = 'Outra justificativa qualquer, dez caracteres'
     WHERE id = '80808080-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'trocou a justificativa da contestacao';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3b — a justificativa nao se reescreve';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3c — mas **retirar** passa, e é o que separa contestar de apagar
--
-- Um estado sem saída seria apagar com mais passos: a casa contesta por engano e
-- a nota fica fora da vitrine para sempre. O gatilho olha as duas pontas — a
-- contestação viva não se reescreve, e limpá-la por inteiro passa.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  UPDATE reviews
     SET contested_at = NULL, contested_by = NULL,
         contest_reason = NULL, contest_note = NULL
   WHERE id = '80808080-6666-0000-0000-000000000001';
  RAISE NOTICE 'OK 3c — a contestacao se retira, e a avaliacao volta ao ar';

  -- E recontestar, com outro motivo, funciona em dois passos.
  UPDATE reviews
     SET contested_at = '2026-09-22T09:00:00Z', contest_reason = 'duplicada',
         contest_note = 'A mesma avaliacao ja tinha entrado no dia anterior'
   WHERE id = '80808080-6666-0000-0000-000000000001';
  RAISE NOTICE 'OK 3d — recontestar com outro motivo passa, em dois gestos';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — registrar a recuperação continua funcionando numa contestada
--
-- As duas coisas são independentes: a casa pode ligar para o cliente **e**
-- alegar que a nota é de outra pessoa. Um gatilho que travasse a linha inteira
-- depois de contestada tiraria a recuperação junto, sem ninguém ter decidido.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  UPDATE reviews
     SET resolved_at = '2026-09-21T11:00:00Z', outcome = 'contato',
         resolution_note = 'Liguei no numero do cadastro e ninguem reconheceu a avaliacao'
   WHERE id = '80808080-6666-0000-0000-000000000001';
  RAISE NOTICE 'OK 4 — a recuperacao continua gravavel numa contestada';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — o motivo é de lista fechada, e quem fecha é o enum
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE reviews SET contest_reason = 'nao_gostei'
     WHERE id = '80808080-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou motivo fora da lista';
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE NOTICE 'OK 5 — motivo fora do enum e recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — a permissão nova é válida, e não existe uma que apague
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO role_permissions (tenant_id, role, permission)
  VALUES ('80808080-0000-0000-0000-000000000001', 'manager', 'reviews.contest')
  ON CONFLICT DO NOTHING;
  RAISE NOTICE 'OK 6a — reviews.contest e permissao conhecida';

  BEGIN
    INSERT INTO role_permissions (tenant_id, role, permission)
    VALUES ('80808080-0000-0000-0000-000000000001', 'manager', 'reviews.delete');
    RAISE EXCEPTION 'aceitou uma permissao de apagar avaliacao';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6b — nao existe permissao de apagar avaliacao';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 7 — a semente da migração alcança o dono, e só ele
--
-- Tirar uma nota do ar é a única operação do produto que decide o que o público
-- **não** vê. Ela não vem no papel de recepção nem no de profissional.
--
-- A semente da migração roda uma vez, sobre as barbearias que existiam naquele
-- instante — as deste arquivo nasceram depois. O que se prova aqui é a
-- **instrução**, repetida sobre elas: `owner`, todas, e `DO NOTHING`, que
-- respeita quem já desenhou os próprios papéis.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  faltando integer;
  sobrando integer;
  segunda  integer;
BEGIN
  INSERT INTO role_permissions (tenant_id, role, permission)
  SELECT t.id, 'owner', 'reviews.contest' FROM tenants t
  ON CONFLICT DO NOTHING;

  SELECT count(*) INTO faltando
    FROM tenants t
   WHERE t.id IN ('80808080-0000-0000-0000-000000000001',
                  '80808080-0000-0000-0000-000000000002')
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.tenant_id = t.id AND rp.role = 'owner'
          AND rp.permission = 'reviews.contest');
  IF faltando <> 0 THEN
    RAISE EXCEPTION '% barbearias ficaram sem a permissao no papel do dono', faltando;
  END IF;

  SELECT count(*) INTO sobrando
    FROM role_permissions
   WHERE permission = 'reviews.contest' AND role IN ('receptionist', 'professional');
  IF sobrando <> 0 THEN
    RAISE EXCEPTION 'a semente alcancou % papeis de operacao', sobrando;
  END IF;

  -- Rodar duas vezes nao duplica: e o que torna a migracao repetivel.
  INSERT INTO role_permissions (tenant_id, role, permission)
  SELECT t.id, 'owner', 'reviews.contest' FROM tenants t
  ON CONFLICT DO NOTHING;
  SELECT count(*) INTO segunda
    FROM role_permissions
   WHERE tenant_id = '80808080-0000-0000-0000-000000000001'
     AND role = 'owner' AND permission = 'reviews.contest';
  IF segunda <> 1 THEN
    RAISE EXCEPTION 'a semente gravou % linhas para o mesmo dono', segunda;
  END IF;

  RAISE NOTICE 'OK 7 — so o dono nasce podendo contestar, e a semente e repetivel';
END $$;

-- ----------------------------------------------------------------------------
-- 8 — apagar continua não existindo, contestada ou não
--
-- A contestação é o meio-termo que este bloco criou justamente porque apagar
-- não pode existir. Se ela tivesse aberto o `DELETE`, teria trocado um problema
-- por outro maior.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    RAISE NOTICE 'PULADO 8 — sem role da aplicacao neste banco';
    RETURN;
  END IF;

  SET LOCAL ROLE barbearia_app;
  PERFORM set_config('app.tenant_id', '80808080-0000-0000-0000-000000000001', true);

  BEGIN
    DELETE FROM reviews WHERE id = '80808080-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'apagou uma avaliacao contestada';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 8 — o REVOKE DELETE continua valendo';
  END;

  RESET ROLE;
END $$;

-- ----------------------------------------------------------------------------
-- 9 — a anonimização alcança a justificativa da contestação
--
-- `contest_note` é texto do balcão **sobre o cliente que avaliou**, e a tela
-- sugere justamente uma frase que o nomeia. Sem o gatilho, quem exercesse o
-- direito à exclusão saía do cadastro e continuava nomeado numa linha que o
-- gatilho de imutabilidade tinha acabado de tornar impossível de corrigir.
--
-- O motivo fica: ele é de lista fechada e não nomeia ninguém, e é ele que
-- continua explicando por que a nota está fora do ar.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  sobrou text;
BEGIN
  UPDATE reviews
     SET contested_at = NULL, contested_by = NULL,
         contest_reason = NULL, contest_note = NULL
   WHERE id = '80808080-6666-0000-0000-000000000001';
  UPDATE reviews
     SET contested_at = '2026-09-23T09:00:00Z', contest_reason = 'nunca_foi_cliente',
         contest_note = 'A Ana Paula nunca foi atendida aqui, e o telefone nao e de cliente nosso'
   WHERE id = '80808080-6666-0000-0000-000000000001';

  -- O caminho da anonimização: soltar o cliente da avaliação.
  ALTER TABLE reviews DISABLE TRIGGER reviews_nota_imutavel;
  UPDATE reviews SET customer_id = NULL, comment = NULL
   WHERE id = '80808080-6666-0000-0000-000000000001';
  ALTER TABLE reviews ENABLE TRIGGER reviews_nota_imutavel;

  SELECT contest_note INTO sobrou FROM reviews
   WHERE id = '80808080-6666-0000-0000-000000000001';
  IF sobrou LIKE '%Ana Paula%' THEN
    RAISE EXCEPTION 'o nome do titular sobreviveu na justificativa: %', sobrou;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM reviews
     WHERE id = '80808080-6666-0000-0000-000000000001'
       AND contest_reason = 'nunca_foi_cliente' AND contested_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a anonimizacao levou o motivo junto';
  END IF;

  RAISE NOTICE 'OK 9 — a justificativa sai quando a pessoa sai; o motivo fica';
END $$;

ROLLBACK;
