-- ============================================================================
-- Invariantes da camada de plataforma (bloco 24).
--
-- O que precisa ser provado aqui não é que as tabelas novas funcionam — é que
-- **elas não abriram a porta que o produto inteiro fecha**.
--
-- A camada de plataforma existe para ver todas as barbearias. A camada de
-- negócio existe para que nenhuma veja a outra. As duas convivem no mesmo banco
-- e no mesmo role, e a única coisa que as separa é qual tabela cada uma toca.
-- Um afrouxamento em `tenants`, `customers` ou `appointments` não daria erro em
-- lugar nenhum: as consultas do produto **não repetem `tenant_id` no `WHERE`**,
-- então elas passariam a devolver o vizinho em silêncio.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('26262626-0000-0000-0000-000000000001', 'Domari'),
  ('26262626-0000-0000-0000-000000000002', 'Rival');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('a6262626-0000-0000-0000-000000000001', '26262626-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('c6262626-0000-0000-0000-000000000001', '26262626-0000-0000-0000-000000000001', 'Carlos', '+5571900002601');

-- ----------------------------------------------------------------------------
-- 1 — o espelho é do banco, não da aplicação
-- ----------------------------------------------------------------------------
DO $$
DECLARE espelhadas int;
BEGIN
  SELECT count(*) INTO espelhadas FROM tenant_platform
   WHERE tenant_id IN ('26262626-0000-0000-0000-000000000001', '26262626-0000-0000-0000-000000000002');
  IF espelhadas <> 2 THEN
    RAISE EXCEPTION 'o gatilho espelhou % de 2 barbearias', espelhadas;
  END IF;
  RAISE NOTICE 'OK 1 — toda barbearia nova entra no espelho sem a aplicação pedir';
END $$;

-- 2 — renomear a barbearia acerta o espelho
UPDATE tenants SET name = 'Domari Barber Club' WHERE id = '26262626-0000-0000-0000-000000000001';
DO $$
DECLARE nome text;
BEGIN
  SELECT name INTO nome FROM tenant_platform WHERE tenant_id = '26262626-0000-0000-0000-000000000001';
  IF nome <> 'Domari Barber Club' THEN
    RAISE EXCEPTION 'o espelho ficou com "%"', nome;
  END IF;
  RAISE NOTICE 'OK 2 — renomear acerta o espelho';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — bloqueio sem motivo é recusado pelo banco
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE tenant_platform SET blocked_at = now()
     WHERE tenant_id = '26262626-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'bloqueou sem motivo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3 — bloqueio sem motivo escrito é recusado';
  END;
END $$;

-- 4 — e motivo sem bloqueio também
DO $$
BEGIN
  BEGIN
    UPDATE tenant_platform SET blocked_reason = 'inadimplente'
     WHERE tenant_id = '26262626-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'guardou motivo em conta ativa';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4 — motivo sem bloqueio é recusado';
  END;
END $$;

-- 5 — o par completo passa
UPDATE tenant_platform
   SET blocked_at = now(), blocked_reason = 'inadimplente há 60 dias'
 WHERE tenant_id = '26262626-0000-0000-0000-000000000002';

-- ----------------------------------------------------------------------------
-- 6 — plano em uso não pode ser apagado
-- ----------------------------------------------------------------------------
UPDATE tenant_platform SET plan_id = (SELECT id FROM plans WHERE code = 'essencial')
 WHERE tenant_id = '26262626-0000-0000-0000-000000000001';

DO $$
BEGIN
  BEGIN
    DELETE FROM plans WHERE code = 'essencial';
    RAISE EXCEPTION 'apagou plano com barbearia dentro';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'OK 6 — plano com barbearia dentro não some (ON DELETE RESTRICT)';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 7 — a trilha da plataforma sobrevive à barbearia
--
-- É o motivo de ela não ter `ON DELETE CASCADE`: o registro de que uma conta
-- foi bloqueada não pode ser apagado apagando a conta.
-- ----------------------------------------------------------------------------
INSERT INTO platform_audit (tenant_id, action, detail)
VALUES ('26262626-0000-0000-0000-000000000002', 'tenant.blocked', '{"motivo":"inadimplente"}'::jsonb);

DELETE FROM tenants WHERE id = '26262626-0000-0000-0000-000000000002';

DO $$
DECLARE sobrou int;
BEGIN
  SELECT count(*) INTO sobrou FROM platform_audit
   WHERE tenant_id = '26262626-0000-0000-0000-000000000002';
  IF sobrou <> 1 THEN
    RAISE EXCEPTION 'a trilha da plataforma sumiu com a barbearia (% linhas)', sobrou;
  END IF;
  RAISE NOTICE 'OK 7 — a trilha da plataforma sobrevive à barbearia apagada';
END $$;

-- ----------------------------------------------------------------------------
-- 8 — o QUE IMPORTA: nada disso afrouxou a separação entre barbearias
--
-- Este é o teste pelo qual a migração inteira precisa passar. Com o role da
-- aplicação e o tenant da Domari fixado, uma consulta **sem filtro** a cada
-- tabela de negócio tem que continuar devolvendo só o que é da Domari.
-- ----------------------------------------------------------------------------
INSERT INTO tenants (id, name) VALUES ('26262626-0000-0000-0000-000000000003', 'Outra');
INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('c6262626-0000-0000-0000-000000000003', '26262626-0000-0000-0000-000000000003', 'Espião', '+5571900002603');

SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '26262626-0000-0000-0000-000000000001', true);

DO $$
DECLARE visiveis int;
BEGIN
  SELECT count(*) INTO visiveis FROM customers;
  IF visiveis <> 1 THEN
    RAISE EXCEPTION 'a Domari enxergou % clientes; a plataforma abriu a porta', visiveis;
  END IF;

  SELECT count(*) INTO visiveis FROM tenants;
  IF visiveis <> 1 THEN
    RAISE EXCEPTION 'a Domari enxergou % barbearias em tenants', visiveis;
  END IF;

  RAISE NOTICE 'OK 8 — a camada de plataforma não alargou nenhuma tabela de negócio';
END $$;

-- ----------------------------------------------------------------------------
-- 9 — e as tabelas de plataforma são vistas de propósito
--
-- O contrário do 8, e igualmente necessário: se elas também estivessem
-- isoladas, o Super Admin não veria nada e o bloco não teria como funcionar.
-- ----------------------------------------------------------------------------
DO $$
DECLARE visiveis int;
BEGIN
  SELECT count(*) INTO visiveis FROM tenant_platform;
  IF visiveis < 2 THEN
    RAISE EXCEPTION 'a plataforma enxergou % barbearias; devia ver todas', visiveis;
  END IF;
  RAISE NOTICE 'OK 9 — as tabelas de plataforma são de leitura ampla, de propósito';
END $$;

-- ----------------------------------------------------------------------------
-- 10 — a trilha da plataforma é append-only para a aplicação
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE platform_audit SET action = 'mentira';
    RAISE EXCEPTION 'reescreveu a trilha da plataforma';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 10 — a trilha da plataforma não é reescrita';
  END;
END $$;

DO $$
BEGIN
  BEGIN
    DELETE FROM platform_audit;
    RAISE EXCEPTION 'apagou a trilha da plataforma';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 10b — a trilha da plataforma não é apagada';
  END;
END $$;

ROLLBACK;
