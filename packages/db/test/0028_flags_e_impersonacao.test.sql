-- ============================================================================
-- Invariantes dos recursos e do suporte assistido (bloco 26).
--
-- O que se prova aqui é o que a SPEC §1.2 exige que seja impossível de perder:
-- **o registro da impersonação**. Quem impersonou, quando, por quanto tempo e
-- com que motivo — e que nada disso pode ser apagado por quem o produziu.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('28282828-0000-0000-0000-000000000001', 'Domari'),
  ('28282828-0000-0000-0000-000000000002', 'Rival');

INSERT INTO platform_admins (id, email_key, name, password_hash)
VALUES ('a8282828-0000-0000-0000-000000000001', 'chave-de-teste-28', 'Super', 'hash');

-- ----------------------------------------------------------------------------
-- 1 — ausência é o padrão do catálogo, não "desligado"
-- ----------------------------------------------------------------------------
DO $$
DECLARE ligados int;
BEGIN
  SELECT count(*) INTO ligados
    FROM feature_flags f
    LEFT JOIN tenant_features tf
      ON tf.flag_code = f.code AND tf.tenant_id = '28282828-0000-0000-0000-000000000001'
   WHERE COALESCE(tf.enabled, f.default_enabled);

  IF ligados <> 3 THEN
    RAISE EXCEPTION 'barbearia nova nasceu com % de 3 recursos ligados', ligados;
  END IF;
  RAISE NOTICE 'OK 1 — sem exceção gravada, vale o padrão do catálogo';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — a exceção de uma barbearia não vale para a outra
-- ----------------------------------------------------------------------------
INSERT INTO tenant_features (tenant_id, flag_code, enabled)
VALUES ('28282828-0000-0000-0000-000000000001', 'fila', false);

DO $$
DECLARE domari boolean; rival boolean;
BEGIN
  SELECT COALESCE(tf.enabled, f.default_enabled) INTO domari
    FROM feature_flags f LEFT JOIN tenant_features tf
      ON tf.flag_code = f.code AND tf.tenant_id = '28282828-0000-0000-0000-000000000001'
   WHERE f.code = 'fila';

  SELECT COALESCE(tf.enabled, f.default_enabled) INTO rival
    FROM feature_flags f LEFT JOIN tenant_features tf
      ON tf.flag_code = f.code AND tf.tenant_id = '28282828-0000-0000-0000-000000000002'
   WHERE f.code = 'fila';

  IF domari OR NOT rival THEN
    RAISE EXCEPTION 'desligar na Domari (%) mexeu na Rival (%)', domari, rival;
  END IF;
  RAISE NOTICE 'OK 2 — recurso desligado numa barbearia não desliga na outra';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — recurso que o código não conhece não entra
--
-- O interruptor que não liga nada é o defeito que a lista fechada evita. A
-- chave estrangeira é a segunda barreira, depois do tipo do TypeScript.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO tenant_features (tenant_id, flag_code, enabled)
    VALUES ('28282828-0000-0000-0000-000000000002', 'inventado', true);
    RAISE EXCEPTION 'aceitou recurso que não existe no catálogo';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'OK 3 — recurso fora do catálogo é recusado pelo banco';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3b — e barbearia nenhuma liga ou desliga o próprio recurso
--
-- O interruptor é da plataforma. Sem esta política, a primeira rota de recurso
-- voltada ao tenant viraria escrita na linha da vizinha, porque a tabela tem
-- `tenant_id` e a política não olhava para ele.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  SET LOCAL ROLE barbearia_app;
  PERFORM set_config('app.tenant_id', '28282828-0000-0000-0000-000000000002', true);
  BEGIN
    INSERT INTO tenant_features (tenant_id, flag_code, enabled)
    VALUES ('28282828-0000-0000-0000-000000000002', 'avisos', false);
    RAISE EXCEPTION 'a barbearia ligou o próprio recurso';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 3b — recurso é decidido pela plataforma, não pela barbearia';
  END;
  RESET ROLE;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- ----------------------------------------------------------------------------
-- 4 — sessão de suporte sem motivo escrito não existe
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO support_sessions (tenant_id, admin_id, reason, expires_at)
    VALUES ('28282828-0000-0000-0000-000000000001', 'a8282828-0000-0000-0000-000000000001',
            '   ', now() + interval '30 minutes');
    RAISE EXCEPTION 'entrou na conta sem motivo escrito';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4 — suporte sem motivo escrito é recusado';
  END;
END $$;

INSERT INTO support_sessions (id, tenant_id, admin_id, reason, expires_at)
VALUES ('58282828-0000-0000-0000-000000000001', '28282828-0000-0000-0000-000000000001',
        'a8282828-0000-0000-0000-000000000001', 'chamado 4471: horário sumindo da grade',
        now() + interval '30 minutes');

-- ----------------------------------------------------------------------------
-- 5 — o registro sobrevive à barbearia **e** ao Super Admin
--
-- As duas ausências que apagariam a prova. A da barbearia é o caso do cliente
-- que cancelou e depois pergunta quem olhou os dados dele; a do Super Admin é o
-- caso do funcionário desligado.
-- ----------------------------------------------------------------------------
DELETE FROM tenants WHERE id = '28282828-0000-0000-0000-000000000001';

DO $$
DECLARE sobrou int;
BEGIN
  SELECT count(*) INTO sobrou FROM support_sessions
   WHERE tenant_id = '28282828-0000-0000-0000-000000000001';
  IF sobrou <> 1 THEN
    RAISE EXCEPTION 'o registro do suporte sumiu com a barbearia';
  END IF;
  RAISE NOTICE 'OK 5 — o registro do suporte sobrevive à barbearia apagada';
END $$;

DELETE FROM platform_admins WHERE id = 'a8282828-0000-0000-0000-000000000001';

DO $$
DECLARE sobrou int; motivo text;
BEGIN
  SELECT count(*), max(reason) INTO sobrou, motivo FROM support_sessions
   WHERE tenant_id = '28282828-0000-0000-0000-000000000001';
  IF sobrou <> 1 OR motivo IS NULL THEN
    RAISE EXCEPTION 'o registro do suporte sumiu com a conta do Super Admin';
  END IF;
  RAISE NOTICE 'OK 5b — e sobrevive à conta do Super Admin apagada';
END $$;

-- ----------------------------------------------------------------------------
-- 6 — e a aplicação não apaga o registro
-- ----------------------------------------------------------------------------
SET LOCAL ROLE barbearia_app;

DO $$
BEGIN
  BEGIN
    DELETE FROM support_sessions;
    RAISE EXCEPTION 'apagou o registro do suporte';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 6 — o registro do suporte não é apagado pela aplicação';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 7 — a sessão de suporte é uma sessão de gestor marcada, não um usuário falso
--
-- É o que garante que a conta usada existe de verdade e que a barbearia não
-- ganha um membro fantasma na equipe dela.
-- ----------------------------------------------------------------------------
RESET ROLE;

DO $$
DECLARE tipo text;
BEGIN
  SELECT data_type INTO tipo FROM information_schema.columns
   WHERE table_name = 'staff_sessions' AND column_name = 'impersonated_by';
  IF tipo IS NULL THEN
    RAISE EXCEPTION 'staff_sessions não sabe dizer que a sessão é de suporte';
  END IF;
  RAISE NOTICE 'OK 7 — a marca de suporte vive na sessão, que toda rota já lê';
END $$;

ROLLBACK;
