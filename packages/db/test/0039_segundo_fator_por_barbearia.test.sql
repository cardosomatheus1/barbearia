-- ============================================================================
-- Invariantes do interruptor do segundo fator (migração 0039).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

-- ----------------------------------------------------------------------------
-- 1 — barbearia nova nasce sem exigir o segundo fator
--
-- É a decisão do produto, e ela mora no `DEFAULT` da coluna. Escrita só no
-- código da aplicação, ela valeria para quem entra pelo cadastro e não valeria
-- para a linha criada por qualquer outro caminho — semente, importação,
-- correção manual.
-- ----------------------------------------------------------------------------
INSERT INTO tenants (id, name) VALUES
  ('39393939-0000-0000-0000-000000000001', 'Domari');

DO $$
DECLARE exige boolean;
BEGIN
  SELECT mfa_required INTO exige FROM tenants
   WHERE id = '39393939-0000-0000-0000-000000000001';
  IF exige IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'barbearia nova nasceu com mfa_required = %', exige;
  END IF;
  RAISE NOTICE 'OK 1 — a exigência nasce desligada';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — a coluna não aceita nulo
--
-- Nulo aqui seria um terceiro estado — "ninguém decidiu" — e todo lugar que lê
-- o campo teria que escolher o que fazer com ele. A guarda escolheria falso,
-- que é desligar a proteção por omissão.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE tenants SET mfa_required = NULL
     WHERE id = '39393939-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou nulo em mfa_required';
  EXCEPTION WHEN not_null_violation THEN
    RAISE NOTICE 'OK 2 — mfa_required não aceita nulo';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — `security.mfa_policy` entra no catálogo do banco
--
-- A `CHECK` espelha `packages/core/src/permissoes.ts`, e há teste em
-- `packages/identity` que reprova se as duas listas divergirem. Aqui se prova o
-- lado do banco: a permissão nova é aceita, e uma inventada continua não sendo.
-- ----------------------------------------------------------------------------
INSERT INTO role_permissions (tenant_id, role, permission) VALUES
  ('39393939-0000-0000-0000-000000000001', 'manager', 'security.mfa_policy');

DO $$
BEGIN
  BEGIN
    INSERT INTO role_permissions (tenant_id, role, permission)
    VALUES ('39393939-0000-0000-0000-000000000001', 'manager', 'security.mfa_tudo');
    RAISE EXCEPTION 'aceitou permissão fora do catálogo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3 — o catálogo do banco conhece a permissão nova e recusa a inventada';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — a permissão de papel continua sendo por barbearia
--
-- `security.mfa_policy` é a permissão mais perigosa a vazar entre contas: quem
-- a tem decide se o caixa pede código. A chave primária de `role_permissions`
-- inclui o tenant desde o bloco 16, e é isso que impede a linha de uma
-- barbearia de valer na outra — aqui se prova que a permissão nova não é
-- exceção.
-- ----------------------------------------------------------------------------
INSERT INTO tenants (id, name) VALUES
  ('39393939-0000-0000-0000-000000000002', 'Rival');

INSERT INTO role_permissions (tenant_id, role, permission) VALUES
  ('39393939-0000-0000-0000-000000000002', 'manager', 'security.mfa_policy');

DO $$
DECLARE quantas int;
BEGIN
  DELETE FROM role_permissions
   WHERE tenant_id = '39393939-0000-0000-0000-000000000001'
     AND permission = 'security.mfa_policy';

  SELECT count(*) INTO quantas FROM role_permissions
   WHERE permission = 'security.mfa_policy';
  IF quantas <> 1 THEN
    RAISE EXCEPTION 'tirar a permissão de uma barbearia mexeu na outra: sobraram %', quantas;
  END IF;
  RAISE NOTICE 'OK 4 — a permissão nova é por barbearia, e apagar não vaza';
END $$;

ROLLBACK;
