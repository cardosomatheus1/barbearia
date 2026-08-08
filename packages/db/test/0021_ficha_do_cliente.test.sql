-- ============================================================================
-- Invariantes da ficha do cliente e da conta do barbeiro.
--
-- O que se prova aqui: que a anotação de uma barbearia não existe para a outra,
-- que o vocabulário de "conversa" é fechado, e que uma cadeira não pode ter
-- duas contas — porque a agenda e a comissão saem de `professional_id`.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('21212121-2121-2121-2121-212121212121', 'Domari'),
  ('21212121-2121-2121-2121-212121212122', 'Rival');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('a1212121-0000-0000-0000-000000000001', '21212121-2121-2121-2121-212121212121', 'Matriz', 'America/Bahia');

INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
  ('b1212121-0000-0000-0000-000000000001', '21212121-2121-2121-2121-212121212121', 'a1212121-0000-0000-0000-000000000001', 'Ruan', 'professional'),
  ('b1212121-0000-0000-0000-000000000002', '21212121-2121-2121-2121-212121212121', 'a1212121-0000-0000-0000-000000000001', 'Gleidson', 'professional');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('c1212121-0000-0000-0000-000000000001', '21212121-2121-2121-2121-212121212121', 'Carlos', '+5571900002121');

-- ----------------------------------------------------------------------------
-- A ficha
-- ----------------------------------------------------------------------------

INSERT INTO customer_preferences
  (customer_id, tenant_id, maquina_laterais, tipo_degrade, conversa, observacoes)
VALUES ('c1212121-0000-0000-0000-000000000001', '21212121-2121-2121-2121-212121212121',
        'Máquina 1', 'Degradê médio', 'silencioso', 'Redemoinho do lado direito abre para cima');

DO $$
DECLARE quantas integer;
BEGIN
  -- Uma linha por cliente: preferência é estado atual, não histórico. O que o
  -- cliente cortou em 2024 vive em `appointments`.
  BEGIN
    INSERT INTO customer_preferences (customer_id, tenant_id)
    VALUES ('c1212121-0000-0000-0000-000000000001', '21212121-2121-2121-2121-212121212121');
    RAISE EXCEPTION 'aceitou duas fichas para o mesmo cliente';
  EXCEPTION WHEN unique_violation THEN
    SELECT count(*) INTO quantas FROM customer_preferences;
    IF quantas <> 1 THEN RAISE EXCEPTION 'a ficha duplicou'; END IF;
    RAISE NOTICE 'OK 1 — uma ficha por cliente; preferência é estado, não histórico';
  END;
END $$;

DO $$
BEGIN
  UPDATE customer_preferences SET conversa = 'quieto'
   WHERE customer_id = 'c1212121-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'aceitou vocabulário livre em conversa';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 2 — "conversa" tem vocabulário fechado; três sinônimos leem como três coisas';
END $$;

DO $$
DECLARE padrao text;
BEGIN
  INSERT INTO customers (id, tenant_id, name, phone_e164)
  VALUES ('c1212121-0000-0000-0000-000000000002', '21212121-2121-2121-2121-212121212121', 'João', '+5571900002122');
  INSERT INTO customer_preferences (customer_id, tenant_id)
  VALUES ('c1212121-0000-0000-0000-000000000002', '21212121-2121-2121-2121-212121212121');

  SELECT conversa INTO padrao FROM customer_preferences
   WHERE customer_id = 'c1212121-0000-0000-0000-000000000002';
  IF padrao <> 'indiferente' THEN
    RAISE EXCEPTION 'a ficha nasceu com preferência de conversa que ninguém declarou';
  END IF;
  RAISE NOTICE 'OK 3 — sem ninguém dizer, a preferência de conversa é "indiferente"';
END $$;

DO $$
BEGIN
  UPDATE customer_preferences SET observacoes = repeat('a', 1001)
   WHERE customer_id = 'c1212121-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'aceitou anotação sem teto';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 4 — anotação tem teto; sem ele a ficha vira rolagem antes do que importa';
END $$;

-- ----------------------------------------------------------------------------
-- Uma cadeira, uma conta
-- ----------------------------------------------------------------------------

INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role, professional_id)
VALUES ('d1212121-0000-0000-0000-000000000001', '21212121-2121-2121-2121-212121212121',
        'Ruan', 'ruan@domari.com.br', 'x', 'professional', 'b1212121-0000-0000-0000-000000000001');

DO $$
BEGIN
  -- A agenda "minha" e a comissão saem de `professional_id`. Duas contas na
  -- mesma cadeira dariam dois donos ao mesmo dinheiro.
  INSERT INTO staff_users (tenant_id, name, email, password_hash, role, professional_id)
  VALUES ('21212121-2121-2121-2121-212121212121', 'Impostor', 'impostor@domari.com.br',
          'x', 'professional', 'b1212121-0000-0000-0000-000000000001');
  RAISE EXCEPTION 'aceitou duas contas para a mesma cadeira';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'OK 5 — uma cadeira, uma conta';
END $$;

DO $$
BEGIN
  -- Quem não é barbeiro tem a coluna nula, e essas linhas não competem entre si.
  INSERT INTO staff_users (tenant_id, name, email, password_hash, role) VALUES
    ('21212121-2121-2121-2121-212121212121', 'Maria', 'maria@domari.com.br', 'x', 'receptionist'),
    ('21212121-2121-2121-2121-212121212121', 'Bruno', 'bruno@domari.com.br', 'x', 'receptionist');
  RAISE NOTICE 'OK 6 — conta sem cadeira pode repetir; o índice ignora nulo';
END $$;

DO $$
DECLARE sobrou uuid;
BEGIN
  -- Desligar o profissional do cadastro não pode apagar a conta dele: a trilha
  -- de auditoria e a comissão fechada apontam para `staff_users`.
  DELETE FROM professionals WHERE id = 'b1212121-0000-0000-0000-000000000002';
  SELECT id INTO sobrou FROM staff_users WHERE id = 'd1212121-0000-0000-0000-000000000001';
  IF sobrou IS NULL THEN RAISE EXCEPTION 'a conta sumiu junto com a cadeira'; END IF;
  RAISE NOTICE 'OK 7 — apagar a cadeira solta a conta, não a destrói';
END $$;

-- ----------------------------------------------------------------------------
-- A parede entre barbearias
-- ----------------------------------------------------------------------------

SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '21212121-2121-2121-2121-212121212122', true);

DO $$
DECLARE quantas integer;
BEGIN
  SELECT count(*) INTO quantas FROM customer_preferences;
  IF quantas <> 0 THEN
    RAISE EXCEPTION 'a rival leu % ficha(s) da casa', quantas;
  END IF;
  RAISE NOTICE 'OK 8 — a anotação sobre um cliente não existe para a outra barbearia';
END $$;

DO $$
BEGIN
  /**
   * A chave estrangeira **não** protege: checagem de integridade referencial
   * ignora row security. O que recusa aqui é o `WITH CHECK` da política — e é
   * por isso que ele existe além do `USING`.
   */
  INSERT INTO customer_preferences (customer_id, tenant_id, observacoes)
  VALUES ('c1212121-0000-0000-0000-000000000001',
          '21212121-2121-2121-2121-212121212121', 'anotação plantada');
  RAISE EXCEPTION 'a rival escreveu na ficha de um cliente da casa';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'OK 9 — WITH CHECK recusa a escrita com tenant alheio';
END $$;

RESET ROLE;

DO $$ BEGIN RAISE NOTICE '--- invariantes da ficha do cliente passaram ---'; END $$;

ROLLBACK;
