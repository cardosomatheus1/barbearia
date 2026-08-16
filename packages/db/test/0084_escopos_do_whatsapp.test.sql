-- ============================================================================
-- Invariantes dos escopos concedidos (bloco 88).
--
-- O bloco se resume a uma frase: **"não dá para dizer" não é "não pode"**. O
-- que se prova aqui é essa frase escrita onde não depende de ninguém lembrar
-- dela — a ausência é aceita, o vazio é recusado, e o que a Meta disse
-- atravessa a gravação inteiro.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('84848484-0000-0000-0000-000000000001', 'Domari');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('84848484-1111-0000-0000-000000000001',
   '84848484-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia'),
  ('84848484-1111-0000-0000-000000000002',
   '84848484-0000-0000-0000-000000000001', 'Filial', 'America/Bahia');

-- ----------------------------------------------------------------------------
-- 1 — sem escopo é aceito, e é o cadastro pelo formulário
--
-- O caminho de escape do bloco 55 nunca fala com a Meta: quem já tem os ids
-- cola os dois e o token. Recusar a linha sem escopo transformaria o único
-- caminho que funciona sem Embedded Signup em erro de banco — e ele é
-- justamente o que sobra quando a janela da Meta não abre.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO whatsapp_settings
    (location_id, tenant_id, status, phone_number_id, waba_id, access_token_cipher)
  VALUES ('84848484-1111-0000-0000-000000000001',
          '84848484-0000-0000-0000-000000000001', 'ativo', '1234', '5678',
          'nonce.tag.dados');
  RAISE NOTICE 'OK 1 — cadastro sem escopo declarado é aceito';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — vazio é recusado
--
-- `{}` seria "a Meta respondeu e não concedeu nada", que não acontece:
-- `descobrirWaba` recusa a conexão antes, porque sem escopo não há como saber a
-- qual conta o token pertence. Sem o `CHECK`, um caminho novo escrito errado
-- gravaria `{}`, a leitura o entenderia como "não pode gerenciar", e a tela
-- acusaria a barbearia por um defeito nosso.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE whatsapp_settings
       SET granted_scopes = '{}'::text[]
     WHERE location_id = '84848484-1111-0000-0000-000000000001';
    RAISE EXCEPTION 'escopo vazio foi aceito';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2 — escopo vazio é recusado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — o que a Meta disse atravessa inteiro
--
-- Guardar os nomes, e não um booleano derivado deles, é o que deixa a pergunta
-- seguinte ser respondida sem migração. O teste grava os dois escopos e os lê
-- de volta na ordem em que entraram.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_escopos text[];
BEGIN
  UPDATE whatsapp_settings
     SET granted_scopes = ARRAY['whatsapp_business_messaging',
                                'whatsapp_business_management']
   WHERE location_id = '84848484-1111-0000-0000-000000000001';

  SELECT granted_scopes INTO v_escopos
    FROM whatsapp_settings
   WHERE location_id = '84848484-1111-0000-0000-000000000001';

  IF v_escopos <> ARRAY['whatsapp_business_messaging',
                        'whatsapp_business_management'] THEN
    RAISE EXCEPTION 'os escopos não voltaram como entraram: %', v_escopos;
  END IF;
  RAISE NOTICE 'OK 3 — os escopos concedidos são lidos de volta inteiros';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — só `messaging` é gravável, e é o caso que o bloco existe para pegar
--
-- É o cadastro que conecta o número sem erro nenhum e não cria template. Ele
-- precisa ser uma linha **válida** no banco: quem recusa não é a constraint, é
-- a tela avisando antes de a pessoa escrever o texto.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO whatsapp_settings
    (location_id, tenant_id, status, phone_number_id, waba_id,
     access_token_cipher, granted_scopes)
  VALUES ('84848484-1111-0000-0000-000000000002',
          '84848484-0000-0000-0000-000000000001', 'ativo', '4321', '8765',
          'nonce.tag.dados', ARRAY['whatsapp_business_messaging']);
  RAISE NOTICE 'OK 4 — token só de envio é cadastro válido, não erro de banco';
END $$;

ROLLBACK;
