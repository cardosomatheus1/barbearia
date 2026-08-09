-- ============================================================================
-- Invariantes do RBAC editável (bloco 30).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('32323232-0000-0000-0000-000000000001', 'Domari');

-- ----------------------------------------------------------------------------
-- 1 — as duas permissões novas são aceitas pelo catálogo do banco
--
-- O `CHECK` espelha `packages/core/src/permissoes.ts`, e a duplicação existe
-- para que uma permissão inventada não entre numa correção manual. Aqui se
-- prova que as duas legítimas entram.
-- ----------------------------------------------------------------------------
INSERT INTO role_permissions (tenant_id, role, permission) VALUES
  ('32323232-0000-0000-0000-000000000001', 'receptionist', 'finance.discount'),
  ('32323232-0000-0000-0000-000000000001', 'professional', 'customers.edit_notes');

DO $$
BEGIN
  RAISE NOTICE 'OK 1 — `finance.discount` e `customers.edit_notes` entram';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — e uma inventada continua recusada
--
-- É esta recusa que impede a correção manual de madrugada de conceder uma
-- permissão que nenhuma rota exige — e que, portanto, ninguém nota faltando.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO role_permissions (tenant_id, role, permission)
    VALUES ('32323232-0000-0000-0000-000000000001', 'receptionist', 'finance.tudo');
    RAISE EXCEPTION 'aceitou permissão fora do catálogo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2 — permissão fora do catálogo é recusada pelo banco';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — o teto de desconto é pontos-base, entre zero e cem por cento
-- ----------------------------------------------------------------------------
DO $$
DECLARE padrao int;
BEGIN
  SELECT max_discount_bps INTO padrao FROM tenants
   WHERE id = '32323232-0000-0000-0000-000000000001';
  IF padrao <> 2000 THEN
    RAISE EXCEPTION 'o padrão do teto virou %, e não 2000', padrao;
  END IF;

  BEGIN
    UPDATE tenants SET max_discount_bps = 10001
     WHERE id = '32323232-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou teto acima de 100%%';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3 — o teto de desconto fica entre 0 e 10000 pontos-base';
  END;

  BEGIN
    UPDATE tenants SET max_discount_bps = -1
     WHERE id = '32323232-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou teto negativo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3b — nem teto negativo';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — a permissão de um papel é da barbearia, não da plataforma
--
-- É o que torna a tela deste bloco possível: tirar `appointments.cancel` da
-- recepção de uma barbearia não pode alcançar a vizinha.
-- ----------------------------------------------------------------------------
INSERT INTO tenants (id, name) VALUES
  ('32323232-0000-0000-0000-000000000002', 'Vizinha');
INSERT INTO role_permissions (tenant_id, role, permission) VALUES
  ('32323232-0000-0000-0000-000000000002', 'receptionist', 'appointments.cancel');

SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '32323232-0000-0000-0000-000000000001', true);

DO $$
DECLARE visiveis int;
BEGIN
  SELECT count(*) INTO visiveis FROM role_permissions;
  IF visiveis <> 2 THEN
    RAISE EXCEPTION 'a barbearia enxerga % linhas de permissão, e só 2 são dela', visiveis;
  END IF;

  DELETE FROM role_permissions WHERE role = 'receptionist';
  SELECT count(*) INTO visiveis FROM role_permissions;
  IF visiveis <> 1 THEN
    RAISE EXCEPTION 'apagar a permissão da recepção alcançou % linhas', visiveis;
  END IF;
  RAISE NOTICE 'OK 4 — permissão de papel é por barbearia, e apagar não vaza';
END $$;

ROLLBACK;
