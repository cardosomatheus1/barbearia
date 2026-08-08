-- ============================================================================
-- Invariantes do índice da trilha por ação.
--
-- O índice existe por uma razão de custo, mas está aqui por uma de segurança: a
-- trilha passou a ser lida em duas rotas com permissões diferentes, e a coluna
-- que separa as duas é `action`. Se o planejador ignorar o índice, a leitura
-- continua correta — mas numa tabela que nunca encolhe, "correta e cara" vira
-- "o dono não abre mais essa tela".
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'audit_log_acao_idx') THEN
    RAISE EXCEPTION 'a trilha voltou a filtrar action sem índice';
  END IF;
  RAISE NOTICE 'OK 1 — audit_log tem índice por (tenant_id, action, id DESC)';
END $$;

INSERT INTO tenants (id, name) VALUES
  ('24242424-0000-0000-0000-000000000001', 'Domari'),
  ('24242424-0000-0000-0000-000000000002', 'Rival');

-- Duas barbearias, duas famílias de ação. A varredura sequencial é mais barata
-- em tabela pequena, então o que se prova aqui não é o plano — é que o filtro
-- devolve exatamente o que a rota daquela permissão pode ver.
INSERT INTO audit_log (tenant_id, actor_id, actor_name, action, entity, entity_id, before, after)
VALUES
  ('24242424-0000-0000-0000-000000000001', NULL, 'Dona', 'staff.role_changed', 'staff_users', NULL,
   '{"role":"receptionist"}', '{"role":"manager"}'),
  ('24242424-0000-0000-0000-000000000001', NULL, 'Dona', 'cash.closed', 'cash_sessions', NULL,
   NULL, '{"esperadoCents":123400,"contadoCents":123000,"divergenciaCents":-400}'),
  ('24242424-0000-0000-0000-000000000002', NULL, 'Rival', 'cash.closed', 'cash_sessions', NULL,
   NULL, '{"esperadoCents":999900}');

DO $$
DECLARE gestao int; dinheiro int;
BEGIN
  SELECT count(*) INTO gestao FROM audit_log
   WHERE tenant_id = '24242424-0000-0000-0000-000000000001'
     AND action = ANY(ARRAY['staff.created','staff.role_changed','staff.deactivated',
                            'staff.reactivated','staff.password_reset','permissions.changed',
                            'mfa.enabled','mfa.disabled','mfa.recovery_used']::text[]);

  SELECT count(*) INTO dinheiro FROM audit_log
   WHERE tenant_id = '24242424-0000-0000-0000-000000000001'
     AND action = ANY(ARRAY['cash.opened','cash.closed','cash.withdrawal','cash.supply',
                            'order.closed','order.discount','debt.received',
                            'commission.closed','commission.rule_changed']::text[]);

  IF gestao <> 1 THEN
    RAISE EXCEPTION 'a trilha de gestão devolveu % linhas em vez de 1', gestao;
  END IF;
  IF dinheiro <> 1 THEN
    RAISE EXCEPTION 'a trilha de dinheiro devolveu % linhas em vez de 1', dinheiro;
  END IF;
  RAISE NOTICE 'OK 2 — o filtro por ação separa gestão de dinheiro, e o tenant separa as casas';
END $$;

-- O que a rota de gestão NUNCA pode devolver: uma linha com centavo dentro.
DO $$
DECLARE vazou int;
BEGIN
  SELECT count(*) INTO vazou FROM audit_log
   WHERE action = ANY(ARRAY['staff.created','staff.role_changed','staff.deactivated',
                            'staff.reactivated','staff.password_reset','permissions.changed',
                            'mfa.enabled','mfa.disabled','mfa.recovery_used']::text[])
     AND (before::text ILIKE '%Cents%' OR after::text ILIKE '%Cents%');

  IF vazou > 0 THEN
    RAISE EXCEPTION 'ação de gestão gravou valor em dinheiro: % linha(s)', vazou;
  END IF;
  RAISE NOTICE 'OK 3 — nenhuma ação do lado de gestão carrega valor em centavos';
END $$;

ROLLBACK;
