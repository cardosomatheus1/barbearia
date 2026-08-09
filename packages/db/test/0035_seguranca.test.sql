-- ============================================================================
-- Invariantes da segurança (bloco 33).
--
-- O que se prova aqui é o que o teste de integração não alcança: que a tabela
-- sem tenant não guarda e-mail em claro, que o registro de aviso não é
-- apagável, e que a preferência de uma barbearia não é lida pela outra.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('35353535-0000-0000-0000-000000000001', 'Domari'),
  ('35353535-0000-0000-0000-000000000002', 'Vizinha');

-- ----------------------------------------------------------------------------
-- 1 — a escada de espera não tem coluna para e-mail em claro
--
-- A tabela é lida antes de existir tenant no contexto, então a política é
-- `USING (true)`. Uma coluna de e-mail aqui seria a lista de clientes da
-- plataforma exposta a qualquer consulta que escape — é o mesmo motivo pelo
-- qual `staff_directory` guarda HMAC desde o bloco 12.
-- ----------------------------------------------------------------------------
DO $$
DECLARE suspeitas text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO suspeitas
    FROM information_schema.columns
   WHERE table_name = 'login_attempts'
     AND column_name IN ('email', 'phone', 'phone_e164', 'name');

  IF suspeitas IS NOT NULL THEN
    RAISE EXCEPTION 'login_attempts ganhou coluna de dado pessoal: %', suspeitas;
  END IF;
  RAISE NOTICE 'OK 1 — a escada guarda HMAC, contador e data, e mais nada';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — contador negativo é recusado
--
-- Um `UPDATE` errado que zerasse para baixo transformaria a escada em teto
-- infinito — e ninguém notaria, porque login continuaria funcionando.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO login_attempts (email_key, ip, failures)
    VALUES ('chave-qualquer', '203.0.113.1'::inet, -1);
    RAISE EXCEPTION 'aceitou contador negativo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2 — contador de falhas não fica negativo';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2b — a escada é por conta **e** origem
--
-- O achado mais grave da /security-review do bloco 33: contando só por conta, a
-- proteção virava arma — errar de propósito uma senha a cada meia hora trancava
-- o dono fora do próprio negócio, de qualquer endereço, para sempre.
--
-- Duas origens da mesma conta convivem; a mesma origem duas vezes, não.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO login_attempts (email_key, ip, failures)
  VALUES ('mesma-conta', '203.0.113.1'::inet, 3),
         ('mesma-conta', '198.51.100.9'::inet, 3);

  BEGIN
    INSERT INTO login_attempts (email_key, ip, failures)
    VALUES ('mesma-conta', '203.0.113.1'::inet, 1);
    RAISE EXCEPTION 'a mesma conta e origem entrou duas vezes';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 2b — uma escada por conta e origem';
  END;

  -- Sem IP conhecido todos caem na mesma escada, e não numa linha nova por
  -- tentativa — que seria o caminho que um atacante escolheria.
  INSERT INTO login_attempts (email_key, ip, failures) VALUES ('mesma-conta', NULL, 1);
  BEGIN
    INSERT INTO login_attempts (email_key, ip, failures) VALUES ('mesma-conta', NULL, 1);
    RAISE EXCEPTION 'tentativa sem IP criou linha nova';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 2c — sem IP conhecido, uma escada só';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — conta de plataforma nasce sem poder agir
--
-- O padrão da coluna é o lado seguro: nascer podendo tudo e depender de alguém
-- lembrar de rebaixar é como toda conta acaba com acesso total.
-- ----------------------------------------------------------------------------
INSERT INTO platform_admins (email_key, name, password_hash)
VALUES ('hmac-de-teste-35', 'Novo', 'scrypt$x');

DO $$
DECLARE papel text;
BEGIN
  SELECT role::text INTO papel FROM platform_admins WHERE email_key = 'hmac-de-teste-35';
  IF papel <> 'viewer' THEN
    RAISE EXCEPTION 'conta nova de plataforma nasceu como %', papel;
  END IF;
  RAISE NOTICE 'OK 3 — conta de plataforma nasce viewer';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — o registro de que o dono foi avisado não é apagável pela aplicação
--
-- É o que responde "por que ninguém me contou?" depois. Mesma razão do
-- `audit_log` e do extrato do fiado.
-- ----------------------------------------------------------------------------
INSERT INTO tenant_alerts_sent (tenant_id, code, dia)
VALUES ('35353535-0000-0000-0000-000000000001', 'fila_travada', current_date);

SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '35353535-0000-0000-0000-000000000001', true);

DO $$
BEGIN
  BEGIN
    DELETE FROM tenant_alerts_sent;
    RAISE EXCEPTION 'a aplicação apagou o registro de aviso';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 4 — o registro de aviso não é apagado pela aplicação';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — o mesmo aviso não entra duas vezes no mesmo dia
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO tenant_alerts_sent (tenant_id, code, dia)
    VALUES ('35353535-0000-0000-0000-000000000001', 'fila_travada', current_date);
    RAISE EXCEPTION 'o mesmo aviso entrou duas vezes hoje';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 5 — um aviso por regra por dia';
  END;

  -- Amanhã ele volta, se a causa continuar.
  INSERT INTO tenant_alerts_sent (tenant_id, code, dia)
  VALUES ('35353535-0000-0000-0000-000000000001', 'fila_travada', current_date + 1);
  RAISE NOTICE 'OK 5b — o mesmo aviso volta amanhã';
END $$;

-- ----------------------------------------------------------------------------
-- 6 — a preferência de uma barbearia não é lida pela outra
-- ----------------------------------------------------------------------------
RESET ROLE;
INSERT INTO tenant_alert_settings (tenant_id, enviar_critico, enviar_aviso)
VALUES ('35353535-0000-0000-0000-000000000002', false, false);

SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '35353535-0000-0000-0000-000000000001', true);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM tenant_alert_settings;
  IF n <> 0 THEN
    RAISE EXCEPTION 'a barbearia enxerga a preferência da vizinha';
  END IF;

  SELECT count(*) INTO n FROM tenant_alerts_sent
   WHERE tenant_id = '35353535-0000-0000-0000-000000000002';
  IF n <> 0 THEN
    RAISE EXCEPTION 'a barbearia enxerga o histórico de aviso da vizinha';
  END IF;

  RAISE NOTICE 'OK 6 — preferência e histórico de aviso são da barbearia';
END $$;

ROLLBACK;
