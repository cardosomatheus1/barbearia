-- ============================================================================
-- Invariantes do vale, do estorno e da transferência de pacote (bloco 52).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('55555555-0000-0000-0000-000000000001', 'Domari');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('55555555-1111-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia');

INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
  ('55555555-2222-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000001',
   '55555555-1111-0000-0000-000000000001', 'Ruan'),
  ('55555555-2222-0000-0000-000000000002',
   '55555555-0000-0000-0000-000000000001',
   '55555555-1111-0000-0000-000000000001', 'Bruno');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('55555555-3333-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000001', 'Carlos', '+5571988880001'),
  ('55555555-3333-0000-0000-000000000002',
   '55555555-0000-0000-0000-000000000001', 'Diego', '+5571988880002');

INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes) VALUES
  ('55555555-4444-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000001', 'Corte', 5000, 30);

INSERT INTO professional_advances
  (id, tenant_id, location_id, professional_id, amount_cents, granted_on, created_by_name)
VALUES ('55555555-5555-0000-0000-000000000001',
        '55555555-0000-0000-0000-000000000001',
        '55555555-1111-0000-0000-000000000001',
        '55555555-2222-0000-0000-000000000001', 40000, current_date, 'Matheus');

-- ----------------------------------------------------------------------------
-- 1 — vale descontado é sempre por um fechamento, e aberto nunca tem um
--
-- "Descontado" sem fechamento é um adiantamento que sumiu da folha sem aparecer
-- em nenhum acerto: o profissional não recebe e ninguém consegue dizer onde o
-- dinheiro foi abatido.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE professional_advances SET status = 'descontado'
     WHERE id = '55555555-5555-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou vale descontado sem fechamento';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 1 — vale descontado tem fechamento';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 2 — cancelar exige motivo escrito
--
-- É dinheiro que saiu da gaveta e voltou sem passar pela folha. Sem o motivo, a
-- pergunta "por que o vale do Ruan sumiu?" não tem resposta.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE professional_advances SET status = 'cancelado'
     WHERE id = '55555555-5555-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou cancelar vale sem motivo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2 — cancelar vale exige motivo';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — de quem é o vale e quanto ele vale são congelados
--
-- Reatribuir moveria um adiantamento de uma pessoa para outra sem registro
-- nenhum, e o acerto do mês pagaria a menos a quem nunca pegou nada.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE professional_advances
       SET professional_id = '55555555-2222-0000-0000-000000000002'
     WHERE id = '55555555-5555-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou trocar o dono do vale';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'OK 3a — o dono do vale é congelado';
  END;

  BEGIN
    UPDATE professional_advances SET amount_cents = 1
     WHERE id = '55555555-5555-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou mudar o valor do vale';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'OK 3b — o valor do vale é congelado';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — vale já descontado num fechamento é imutável
--
-- Ele virou linha da folha que já foi paga; mexer nele mudaria o valor de um
-- período fechado, que é o que a SPEC §3.4 proíbe em letras.
-- ----------------------------------------------------------------------------
INSERT INTO commission_closures
  (id, tenant_id, starts_on, ends_on, closed_by_name)
VALUES ('55555555-6666-0000-0000-000000000001',
        '55555555-0000-0000-0000-000000000001',
        current_date - 30, current_date, 'Matheus');

DO $$
BEGIN
  UPDATE professional_advances
     SET status = 'descontado', closure_id = '55555555-6666-0000-0000-000000000001'
   WHERE id = '55555555-5555-0000-0000-000000000001';

  BEGIN
    UPDATE professional_advances SET reason = 'mudei de ideia'
     WHERE id = '55555555-5555-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou mexer num vale já descontado';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'OK 4 — vale descontado é imutável';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — o fechamento não se apaga por baixo de um vale descontado
--
-- `CASCADE` deixaria um adiantamento "descontado" de nada, e a ação referencial
-- roda com os direitos do dono da tabela — sem passar pelo `REVOKE DELETE`.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    DELETE FROM commission_closures WHERE id = '55555555-6666-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou apagar o fechamento que descontou um vale';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'OK 5 — fechamento com vale descontado não se apaga';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — a venda estornada tem data e motivo, e os dois andam juntos
--
-- "Estornada" sem data não responde "quando?"; sem motivo não responde "por
-- quê?" — e a linha é imutável depois, então o campo vazio fica vazio para
-- sempre.
-- ----------------------------------------------------------------------------
INSERT INTO orders (id, tenant_id, location_id, status, business_day, closed_at, total_cents)
VALUES ('55555555-7777-0000-0000-000000000001',
        '55555555-0000-0000-0000-000000000001',
        '55555555-1111-0000-0000-000000000001', 'paid', current_date, now(), 9000);

DO $$
BEGIN
  BEGIN
    UPDATE orders SET status = 'refunded'
     WHERE id = '55555555-7777-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou venda estornada sem data';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6a — venda estornada tem data';
  END;

  BEGIN
    UPDATE orders SET status = 'refunded', refunded_at = now()
     WHERE id = '55555555-7777-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou venda estornada sem motivo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6b — venda estornada tem motivo';
  END;

  BEGIN
    UPDATE orders SET refunded_at = now(), refund_reason = 'engano'
     WHERE id = '55555555-7777-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou data de estorno numa venda paga';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6c — venda paga não tem data de estorno';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 7 — não se transfere pacote para a mesma pessoa, nem sem motivo
-- ----------------------------------------------------------------------------
INSERT INTO customer_packages
  (id, tenant_id, customer_id, service_id, quantity, price_cents, unit_value_cents,
   transferable)
VALUES ('55555555-8888-0000-0000-000000000001',
        '55555555-0000-0000-0000-000000000001',
        '55555555-3333-0000-0000-000000000001',
        '55555555-4444-0000-0000-000000000001', 5, 25000, 5000, true);

DO $$
BEGIN
  BEGIN
    INSERT INTO package_transfers
      (tenant_id, customer_package_id, from_customer_id, to_customer_id,
       units_moved, reason, created_by_name)
    VALUES ('55555555-0000-0000-0000-000000000001',
            '55555555-8888-0000-0000-000000000001',
            '55555555-3333-0000-0000-000000000001',
            '55555555-3333-0000-0000-000000000001', 3, 'presente', 'Matheus');
    RAISE EXCEPTION 'aceitou transferir pacote para a mesma pessoa';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 7a — transferência exige duas pessoas diferentes';
  END;

  BEGIN
    INSERT INTO package_transfers
      (tenant_id, customer_package_id, from_customer_id, to_customer_id,
       units_moved, reason, created_by_name)
    VALUES ('55555555-0000-0000-0000-000000000001',
            '55555555-8888-0000-0000-000000000001',
            '55555555-3333-0000-0000-000000000001',
            '55555555-3333-0000-0000-000000000002', 3, ' ', 'Matheus');
    RAISE EXCEPTION 'aceitou transferência sem motivo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 7b — transferência exige motivo escrito';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 8 — vale e transferência são append-only para a aplicação
--
-- O vale aceita `UPDATE` porque descontar e cancelar são estado; a
-- transferência não aceita nem isso — ela é o registro de que o vale ao portador
-- mudou de dono, e reescrevê-la responderia a pergunta de hoje apagando a de
-- ontem.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    IF has_table_privilege('barbearia_app', 'professional_advances', 'DELETE') THEN
      RAISE EXCEPTION 'a aplicação pode apagar um vale';
    END IF;
    IF has_table_privilege('barbearia_app', 'package_transfers', 'DELETE')
       OR has_table_privilege('barbearia_app', 'package_transfers', 'UPDATE') THEN
      RAISE EXCEPTION 'a aplicação pode mexer numa transferência de pacote';
    END IF;
    RAISE NOTICE 'OK 8 — vale e transferência não se apagam';
  ELSE
    RAISE NOTICE 'PULADO 8 — sem o role da aplicação neste banco';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 9 — nenhuma chave destrói vale ou transferência em cascata
--
-- Varredura de catálogo, e `tenant_id` é a única exceção — inclusive
-- `location_id`, que é a lição que a revisão do bloco 51 deixou: a lista de
-- exceções de uma varredura é onde o defeito se esconde.
-- ----------------------------------------------------------------------------
DO $$
DECLARE ruins text;
BEGIN
  SELECT string_agg(conrelid::regclass || '.' || conname, ', ') INTO ruins
    FROM pg_constraint
   WHERE conrelid IN ('professional_advances'::regclass, 'package_transfers'::regclass)
     AND contype = 'f' AND confdeltype = 'c'
     AND conname NOT LIKE '%tenant_id_fkey';

  IF ruins IS NOT NULL THEN
    RAISE EXCEPTION 'chave com CASCADE no bloco 52: %', ruins;
  END IF;
  RAISE NOTICE 'OK 9 — nenhuma chave do bloco 52 destrói a linha em cascata';
END $$;

-- ----------------------------------------------------------------------------
-- 10 — RLS forçada nas duas tabelas novas
-- ----------------------------------------------------------------------------
DO $$
DECLARE faltando text;
BEGIN
  SELECT string_agg(relname, ', ') INTO faltando
    FROM pg_class
   WHERE relname IN ('professional_advances', 'package_transfers')
     AND NOT (relrowsecurity AND relforcerowsecurity);

  IF faltando IS NOT NULL THEN
    RAISE EXCEPTION 'sem RLS forçada: %', faltando;
  END IF;
  RAISE NOTICE 'OK 10 — RLS forçada no vale e na transferência';
END $$;

-- ----------------------------------------------------------------------------
-- 11 — o desconto do vale na folha nunca é negativo
--
-- `advance_cents` guarda quanto foi abatido, sempre positivo. Um valor negativo
-- ali somaria em vez de subtrair, e o barbeiro receberia o vale de novo — desta
-- vez como comissão.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO commission_closure_lines
      (tenant_id, closure_id, professional_id, professional_name, base_cents,
       amount_cents, advance_cents)
    VALUES ('55555555-0000-0000-0000-000000000001',
            '55555555-6666-0000-0000-000000000001',
            '55555555-2222-0000-0000-000000000002', 'Bruno', 100000, 40000, -1);
    RAISE EXCEPTION 'aceitou desconto de vale negativo na folha';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 11 — o vale abatido na folha é sempre positivo';
  END;
END $$;

ROLLBACK;
