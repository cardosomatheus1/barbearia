-- ============================================================================
-- A varredura global de cascata (revisão geral de segurança).
--
-- ## Por que ela substitui seis varreduras por tabela
--
-- `ON DELETE CASCADE` roda com os direitos do dono da tabela e **não passa pelo
-- `REVOKE DELETE`**. A regra está escrita desde o bloco 51, e desde então cada
-- migração que criou tabela append-only escreveu a própria varredura — com
-- `conrelid IN (...)` fixo, e às vezes com um filtro a mais.
--
-- O resultado é a classe de defeito que este repositório já nomeou: *a lista de
-- exceções de uma varredura é o lugar mais perigoso do teste*. Duas falharam
-- pelo **recorte**, não pela exceção:
--
-- - a da 0062 varre `loyalty_entries` e `customer_ledger` filtrando
--   `attname = 'location_id'`, então a chave `customer_id` era invisível para
--   ela;
-- - a da 0054 lista `bills` e `account_transfers` e deixa de fora
--   `financial_accounts`, que recebe `REVOKE DELETE` na **mesma migração** e
--   tinha `location_id ... ON DELETE CASCADE`.
--
-- E `customer_consents` nunca entrou em varredura nenhuma — foi por ali que
-- `reverterImportacao` destruía a prova de consentimento LGPD.
--
-- Esta pergunta ao catálogo pega os seis de uma vez e todo caso futuro: **toda
-- chave estrangeira `CASCADE` numa tabela em que a aplicação não pode apagar**.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

-- ----------------------------------------------------------------------------
-- 1 — nenhuma cascata alcança tabela append-only
--
-- A exceção é `tenant_id`, e é a única: apagar a barbearia leva tudo dela junto,
-- que é o comportamento desejado e o único caminho pelo qual isso acontece.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  furos text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    RAISE NOTICE 'PULADO 1 — sem role da aplicacao neste banco';
    RETURN;
  END IF;

  SELECT string_agg(c.conrelid::regclass || '.' || c.conname, ', ' ORDER BY c.conname)
    INTO furos
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE c.contype = 'f'
     AND c.confdeltype = 'c'
     AND n.nspname = 'public'
     -- Onde a aplicacao nao pode apagar, a cascata e o caminho de destruicao
     -- que o REVOKE existia para fechar.
     AND NOT has_table_privilege('barbearia_app', c.conrelid, 'DELETE')
     -- tenant_id e a excecao escrita: apagar a barbearia leva tudo dela.
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.conrelid
          AND a.attnum = c.conkey[1]
          AND a.attname = 'tenant_id'
     );

  IF furos IS NOT NULL THEN
    RAISE EXCEPTION 'cascata em tabela append-only: %', furos;
  END IF;

  RAISE NOTICE 'OK 1 — nenhuma cascata alcanca tabela que a aplicacao nao apaga';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — a varredura enxerga o defeito que a motivou
--
-- Guarda que não alcança o defeito que a motivou é pior que guarda nenhuma. Esta
-- reintroduz a cascata de `customer_consents` — a que destruía a prova de
-- consentimento — e confere que a pergunta do item 1 a acusa.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  achou integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    RAISE NOTICE 'PULADO 2 — sem role da aplicacao neste banco';
    RETURN;
  END IF;

  ALTER TABLE customer_consents DROP CONSTRAINT customer_consents_customer_id_fkey;
  ALTER TABLE customer_consents
    ADD CONSTRAINT customer_consents_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

  SELECT count(*) INTO achou
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE c.contype = 'f' AND c.confdeltype = 'c' AND n.nspname = 'public'
     AND NOT has_table_privilege('barbearia_app', c.conrelid, 'DELETE')
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          AND a.attname = 'tenant_id'
     );

  IF achou = 0 THEN
    RAISE EXCEPTION 'a varredura nao enxerga a cascata que a motivou';
  END IF;

  RAISE NOTICE 'OK 2 — a varredura acusa a cascata reintroduzida';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — o que a aplicação de fato não pode apagar
--
-- A outra metade da mesma frase: `GRANT` com menos verbos não revoga nada, e
-- catorze tabelas achavam que eram append-only por isso. Aqui se confere o
-- privilégio real, que é o que vale.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  tabela text;
  verbo  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    RAISE NOTICE 'PULADO 3 — sem role da aplicacao neste banco';
    RETURN;
  END IF;

  FOREACH tabela IN ARRAY ARRAY[
    'audit_log', 'cash_movements', 'stock_movements', 'commission_entries',
    'loyalty_entries', 'customer_consents', 'platform_audit', 'split_transfers',
    'package_transfers', 'account_transfers', 'online_blocks', 'stock_transfers',
    'tenant_alerts_sent'
  ] LOOP
    FOREACH verbo IN ARRAY ARRAY['UPDATE', 'DELETE'] LOOP
      -- `commission_entries` e as tabelas de estado aceitam UPDATE de propósito
      -- (fechar o período, marcar entregue); só o DELETE e proibido nelas.
      CONTINUE WHEN verbo = 'UPDATE' AND tabela IN (
        'commission_entries', 'audit_log', 'cash_movements', 'stock_movements',
        'loyalty_entries', 'customer_consents', 'platform_audit',
        'split_transfers', 'package_transfers', 'account_transfers'
      );

      IF has_table_privilege('barbearia_app', tabela, verbo) THEN
        RAISE EXCEPTION 'a aplicacao ainda tem % em %', verbo, tabela;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'OK 3 — o privilegio real bate com o que o comentario promete';
END $$;

ROLLBACK;
