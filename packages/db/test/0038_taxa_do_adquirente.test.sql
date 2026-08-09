-- ============================================================================
-- Invariantes da taxa do adquirente (bloco 36).
--
-- O que se prova aqui é o que o teste de integração não alcança: que a alíquota
-- absurda é recusada pelo banco e não só pela borda, que uma barbearia não
-- enxerga a alíquota da outra, e que o padrão de `fee_treatment` é o
-- comportamento **anterior** — porque um padrão novo faria a comissão de todo
-- mundo cair no dia da migração, sem ninguém ter decidido nada.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('38383838-0000-0000-0000-000000000001', 'Domari'),
  ('38383838-0000-0000-0000-000000000002', 'Vizinha');

-- ----------------------------------------------------------------------------
-- 1 — o padrão é o comportamento de antes
--
-- `absorvida` é o que o produto sempre fez por omissão: a casa paga a
-- maquininha inteira. Mudança de dinheiro nunca entra por padrão novo.
-- ----------------------------------------------------------------------------
DO $$
DECLARE tratamento text;
BEGIN
  INSERT INTO commission_settings (tenant_id)
  VALUES ('38383838-0000-0000-0000-000000000001');

  SELECT fee_treatment::text INTO tratamento FROM commission_settings
   WHERE tenant_id = '38383838-0000-0000-0000-000000000001';

  IF tratamento <> 'absorvida' THEN
    RAISE EXCEPTION 'o padrão da taxa virou %, e deveria ser absorvida', tratamento;
  END IF;
  RAISE NOTICE 'OK 1 — a taxa nasce absorvida, como o produto sempre fez';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — alíquota absurda é recusada pelo banco
--
-- 3,19 virando 319 é o erro de digitação plausível, e o estrago seria a
-- comissão do mês inteiro de todo mundo. A recusa existe na borda **e** aqui:
-- a do banco é a que fica quando alguém escrever um caminho novo.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO acquirer_fees (tenant_id, method, bps)
    VALUES ('38383838-0000-0000-0000-000000000001', 'credit', 31900);
    RAISE EXCEPTION 'aceitou alíquota de 319%%';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2 — alíquota acima de 30%% recusada';
  END;

  BEGIN
    INSERT INTO acquirer_fees (tenant_id, method, bps)
    VALUES ('38383838-0000-0000-0000-000000000001', 'debit', -100);
    RAISE EXCEPTION 'aceitou alíquota negativa';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2b — alíquota negativa recusada';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — uma alíquota por meio, e não duas
--
-- Duas linhas para `credit` fariam a taxa depender da ordem da consulta, que é
-- o mesmo defeito que a chave de `commission_rules` existe para impedir.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO acquirer_fees (tenant_id, method, bps)
  VALUES ('38383838-0000-0000-0000-000000000001', 'credit', 319);

  BEGIN
    INSERT INTO acquirer_fees (tenant_id, method, bps)
    VALUES ('38383838-0000-0000-0000-000000000001', 'credit', 199);
    RAISE EXCEPTION 'aceitou duas alíquotas para o mesmo meio';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 3 — uma alíquota por meio de pagamento';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — a taxa congelada na venda não fica negativa
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO locations (id, tenant_id, name, timezone)
  VALUES ('38383838-aaaa-0000-0000-000000000001', '38383838-0000-0000-0000-000000000001',
          'Matriz', 'America/Bahia');

  INSERT INTO orders (id, tenant_id, location_id, total_cents)
  VALUES ('38383838-bbbb-0000-0000-000000000001', '38383838-0000-0000-0000-000000000001',
          '38383838-aaaa-0000-0000-000000000001', 4900);

  BEGIN
    UPDATE orders SET fee_cents = -1 WHERE id = '38383838-bbbb-0000-0000-000000000001';
    RAISE EXCEPTION 'a venda aceitou taxa negativa';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4 — taxa negativa recusada na venda';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — nulo continua sendo "não sabemos", e é diferente de zero
--
-- Toda venda anterior a esta migração não tem resposta para "quanto custou de
-- adquirente". Inventar zero para elas afirmaria que não houve taxa.
-- ----------------------------------------------------------------------------
DO $$
DECLARE sem_resposta integer;
BEGIN
  SELECT count(*) INTO sem_resposta FROM orders
   WHERE id = '38383838-bbbb-0000-0000-000000000001' AND fee_cents IS NULL;

  IF sem_resposta <> 1 THEN
    RAISE EXCEPTION 'a venda antiga deixou de aceitar taxa nula';
  END IF;
  RAISE NOTICE 'OK 5 — nulo continua sendo "não sabemos"';
END $$;

-- ----------------------------------------------------------------------------
-- 6 — a alíquota de uma barbearia não é vista pela outra
--
-- Consulta sem filtro, sob o papel da aplicação: quem separa é a política, não
-- o `WHERE`. Superusuário ignora RLS, e o teste rodado como ele afirmaria o
-- contrário do que prova.
-- ----------------------------------------------------------------------------
INSERT INTO acquirer_fees (tenant_id, method, bps)
VALUES ('38383838-0000-0000-0000-000000000002', 'credit', 500);

SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '38383838-0000-0000-0000-000000000001', true);

DO $$
DECLARE vistas integer;
BEGIN
  SELECT count(*) INTO vistas FROM acquirer_fees;

  IF vistas <> 1 THEN
    RAISE EXCEPTION 'a Domari enxergou % alíquotas; deveria enxergar a 1 dela', vistas;
  END IF;
  RAISE NOTICE 'OK 6 — cada barbearia enxerga só a própria alíquota';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — e não consegue escrever na da outra
--
-- `WITH CHECK` além do `USING`: sem ele, a política deixaria inserir uma linha
-- que a própria barbearia não conseguiria ler depois.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO acquirer_fees (tenant_id, method, bps)
    VALUES ('38383838-0000-0000-0000-000000000002', 'pix', 99);
    RAISE EXCEPTION 'a Domari escreveu alíquota na conta da vizinha';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 7 — não se escreve alíquota na conta alheia';
  END;
END $$;

RESET ROLE;

ROLLBACK;
