-- ============================================================================
-- Invariantes das métricas de plataforma (bloco 25).
--
-- Duas coisas precisam ser provadas aqui, e a segunda é a que importa:
--
-- 1. que o agregado e o ciclo de vida funcionam;
-- 2. que **eles não são um atalho para ler o que a RLS esconde**. A tabela nova
--    é de leitura ampla porque só tem contagem dentro. Se um dia alguém colar
--    aqui uma coluna com nome, telefone ou id de cliente, essa decisão passa a
--    valer para todas as barbearias ao mesmo tempo.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('27272727-0000-0000-0000-000000000001', 'Domari'),
  ('27272727-0000-0000-0000-000000000002', 'Rival');

-- ----------------------------------------------------------------------------
-- 1 — nascer já entra no ciclo de vida, sem a aplicação pedir
-- ----------------------------------------------------------------------------
DO $$
DECLARE marcadas int;
BEGIN
  SELECT count(*) INTO marcadas FROM tenant_lifecycle
   WHERE event = 'activated'
     AND tenant_id IN ('27272727-0000-0000-0000-000000000001', '27272727-0000-0000-0000-000000000002');
  IF marcadas <> 2 THEN
    RAISE EXCEPTION 'o gatilho marcou % de 2 ativações', marcadas;
  END IF;
  RAISE NOTICE 'OK 1 — toda barbearia nova entra no ciclo de vida pelo banco';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — o ciclo de vida sobrevive à barbearia apagada
--
-- É o motivo de não haver `ON DELETE CASCADE`: um churn que some quando a conta
-- é removida do banco é um churn que só sabe contar quem ficou.
-- ----------------------------------------------------------------------------
INSERT INTO tenant_lifecycle (tenant_id, event)
VALUES ('27272727-0000-0000-0000-000000000002', 'blocked');

DELETE FROM tenants WHERE id = '27272727-0000-0000-0000-000000000002';

DO $$
DECLARE sobrou int;
BEGIN
  SELECT count(*) INTO sobrou FROM tenant_lifecycle
   WHERE tenant_id = '27272727-0000-0000-0000-000000000002';
  IF sobrou <> 2 THEN
    RAISE EXCEPTION 'o ciclo de vida perdeu linhas com a barbearia (% restantes)', sobrou;
  END IF;
  RAISE NOTICE 'OK 2 — o ciclo de vida sobrevive à barbearia apagada';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — o agregado não aceita número impossível
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO tenant_metrics_daily (tenant_id, business_day, appointments_total)
    VALUES ('27272727-0000-0000-0000-000000000001', DATE '2026-08-01', -1);
    RAISE EXCEPTION 'aceitou contagem negativa';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3 — contagem negativa é recusada pelo banco';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — reapurar o mesmo dia substitui, não duplica
--
-- É o que permite refazer um dia depois de o worker ficar parado. Sem a chave
-- composta, a segunda apuração dobraria o faturamento da plataforma.
-- ----------------------------------------------------------------------------
INSERT INTO tenant_metrics_daily (tenant_id, business_day, appointments_total, revenue_cents)
VALUES ('27272727-0000-0000-0000-000000000001', DATE '2026-08-01', 10, 50000);

INSERT INTO tenant_metrics_daily (tenant_id, business_day, appointments_total, revenue_cents)
VALUES ('27272727-0000-0000-0000-000000000001', DATE '2026-08-01', 12, 60000)
ON CONFLICT (tenant_id, business_day) DO UPDATE
  SET appointments_total = EXCLUDED.appointments_total,
      revenue_cents = EXCLUDED.revenue_cents;

DO $$
DECLARE linhas int; total bigint;
BEGIN
  SELECT count(*), max(revenue_cents) INTO linhas, total FROM tenant_metrics_daily
   WHERE tenant_id = '27272727-0000-0000-0000-000000000001' AND business_day = DATE '2026-08-01';
  IF linhas <> 1 OR total <> 60000 THEN
    RAISE EXCEPTION 'reapuração deixou % linha(s) com total %', linhas, total;
  END IF;
  RAISE NOTICE 'OK 4 — reapurar o mesmo dia substitui o número, não soma outro';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — o agregado guarda contagem, e **só** contagem
--
-- A guarda real deste bloco. A tabela é lida por todas as barbearias ao mesmo
-- tempo; uma coluna de texto aqui é onde um nome de cliente entraria sem
-- ninguém notar, porque nada daria erro.
-- ----------------------------------------------------------------------------
DO $$
DECLARE suspeitas text;
BEGIN
  SELECT string_agg(column_name || ' ' || data_type, ', ') INTO suspeitas
    FROM information_schema.columns
   WHERE table_name = 'tenant_metrics_daily'
     AND data_type NOT IN ('integer', 'bigint', 'date', 'timestamp with time zone', 'uuid');

  IF suspeitas IS NOT NULL THEN
    RAISE EXCEPTION 'coluna não numérica no agregado de plataforma: %', suspeitas;
  END IF;
  RAISE NOTICE 'OK 5 — o agregado global só guarda número, data e o id da barbearia';
END $$;

-- ----------------------------------------------------------------------------
-- 6 — e nada por profissional ou por cliente
-- ----------------------------------------------------------------------------
DO $$
DECLARE proibidas text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO proibidas
    FROM information_schema.columns
   WHERE table_name = 'tenant_metrics_daily'
     AND (column_name LIKE '%customer%' OR column_name LIKE '%professional%'
          OR column_name LIKE '%phone%' OR column_name LIKE '%email%');

  IF proibidas IS NOT NULL THEN
    RAISE EXCEPTION 'o agregado global desceu ao nível da pessoa: %', proibidas;
  END IF;
  RAISE NOTICE 'OK 6 — nada por profissional nem por cliente atravessa para a plataforma';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — e continua sem afrouxar nada: a Domari só enxerga a Domari
-- ----------------------------------------------------------------------------
INSERT INTO tenants (id, name) VALUES ('27272727-0000-0000-0000-000000000003', 'Outra');
INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('c7272727-0000-0000-0000-000000000003', '27272727-0000-0000-0000-000000000003', 'Espião', '+5571900002703');

SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '27272727-0000-0000-0000-000000000001', true);

DO $$
DECLARE visiveis int;
BEGIN
  SELECT count(*) INTO visiveis FROM customers;
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'a Domari enxergou % clientes; as métricas abriram a porta', visiveis;
  END IF;
  RAISE NOTICE 'OK 7 — a camada de métricas não alargou nenhuma tabela de negócio';
END $$;

-- ----------------------------------------------------------------------------
-- 7b — e ninguém escreve o número da vizinha
--
-- A leitura do agregado é ampla de propósito: é assim que o Super Admin soma a
-- plataforma. A escrita não. Sem esta política, uma conexão de barbearia
-- poderia reescrever o faturamento da concorrente — e o painel da plataforma
-- passaria a decidir sobre número inventado por quem tem interesse nele.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO tenant_metrics_daily (tenant_id, business_day, revenue_cents)
    VALUES ('27272727-0000-0000-0000-000000000003', DATE '2026-08-02', 999999);
    RAISE EXCEPTION 'escreveu o agregado de outra barbearia';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 7b — o agregado de uma barbearia não é escrito por outra';
  END;
END $$;

DO $$
DECLARE gravou int;
BEGIN
  INSERT INTO tenant_metrics_daily (tenant_id, business_day, revenue_cents)
  VALUES ('27272727-0000-0000-0000-000000000001', DATE '2026-08-03', 12345);
  SELECT count(*) INTO gravou FROM tenant_metrics_daily
   WHERE tenant_id = '27272727-0000-0000-0000-000000000001' AND business_day = DATE '2026-08-03';
  IF gravou <> 1 THEN
    RAISE EXCEPTION 'a política também barrou a própria linha';
  END IF;
  RAISE NOTICE 'OK 7c — e a própria continua escrevendo a sua';
END $$;

-- ----------------------------------------------------------------------------
-- 8 — o ciclo de vida é append-only para a aplicação
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE tenant_lifecycle SET event = 'activated';
    RAISE EXCEPTION 'reescreveu o ciclo de vida';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 8 — o ciclo de vida não é reescrito';
  END;
END $$;

DO $$
BEGIN
  BEGIN
    DELETE FROM tenant_lifecycle;
    RAISE EXCEPTION 'apagou o ciclo de vida';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 8b — o ciclo de vida não é apagado';
  END;
END $$;

ROLLBACK;
