-- ============================================================================
-- Invariantes da cobrança online da comanda (bloco 35).
--
-- O que se prova aqui é o que o teste de integração não alcança: que duas
-- cobranças vivas na mesma comanda são recusadas **pelo banco**, que a tabela
-- não tem por onde guardar número de cartão, e que a cobrança de uma barbearia
-- é invisível para a outra mesmo numa consulta sem filtro.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('37373737-0000-0000-0000-000000000001', 'Domari'),
  ('37373737-0000-0000-0000-000000000002', 'Vizinha');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('37373737-aaaa-0000-0000-000000000001', '37373737-0000-0000-0000-000000000001',
   'Matriz', 'America/Bahia'),
  ('37373737-aaaa-0000-0000-000000000002', '37373737-0000-0000-0000-000000000002',
   'Vizinha', 'America/Bahia');

INSERT INTO orders (id, tenant_id, location_id, total_cents) VALUES
  ('37373737-bbbb-0000-0000-000000000001', '37373737-0000-0000-0000-000000000001',
   '37373737-aaaa-0000-0000-000000000001', 4900),
  ('37373737-bbbb-0000-0000-000000000002', '37373737-0000-0000-0000-000000000002',
   '37373737-aaaa-0000-0000-000000000002', 4900);

-- ----------------------------------------------------------------------------
-- 1 — não existe coluna para número de cartão
--
-- Como em `billing_customers` (bloco 29), e pelo mesmo motivo: coluna que não
-- existe não é preenchida por engano. O dia em que alguém achar que "seria
-- prático guardar os quatro últimos aqui também", este teste reprova.
-- ----------------------------------------------------------------------------
DO $$
DECLARE suspeitas text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO suspeitas
    FROM information_schema.columns
   WHERE table_name = 'order_charges'
     AND column_name IN ('pan', 'card_number', 'cvv', 'cvc', 'exp_month', 'exp_year', 'last4');

  IF suspeitas IS NOT NULL THEN
    RAISE EXCEPTION 'order_charges ganhou coluna de cartão: %', suspeitas;
  END IF;
  RAISE NOTICE 'OK 1 — a cobrança guarda id opaco do provedor, e mais nada de cartão';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — uma cobrança viva por comanda
--
-- Dois QR Codes abertos para a mesma conta é o cliente pagando duas vezes. A
-- recusa é do banco e não de uma consulta antes do `INSERT`: essa tem janela de
-- corrida, e dois toques no "Cobrar" acontecem em milissegundos.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO order_charges
    (id, tenant_id, location_id, order_id, method, amount_cents, created_by_name)
  VALUES ('37373737-cccc-0000-0000-000000000001', '37373737-0000-0000-0000-000000000001',
          '37373737-aaaa-0000-0000-000000000001', '37373737-bbbb-0000-0000-000000000001',
          'pix', 4900, 'Maria');

  BEGIN
    INSERT INTO order_charges
      (tenant_id, location_id, order_id, method, amount_cents, created_by_name)
    VALUES ('37373737-0000-0000-0000-000000000001',
            '37373737-aaaa-0000-0000-000000000001', '37373737-bbbb-0000-0000-000000000001',
            'pix', 4900, 'Maria');
    RAISE EXCEPTION 'a comanda aceitou duas cobranças vivas';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 2 — uma cobrança viva por comanda';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — encerrada a primeira, a comanda aceita outra
--
-- O índice é **parcial**: ele vale só para `aguardando`. Sem isso, um Pix
-- recusado travaria a comanda para sempre.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  UPDATE order_charges SET status = 'expirado'
   WHERE id = '37373737-cccc-0000-0000-000000000001';

  INSERT INTO order_charges
    (tenant_id, location_id, order_id, method, amount_cents, created_by_name)
  VALUES ('37373737-0000-0000-0000-000000000001',
          '37373737-aaaa-0000-0000-000000000001', '37373737-bbbb-0000-0000-000000000001',
          'pix', 4900, 'Maria');
  RAISE NOTICE 'OK 3 — encerrada a primeira, a comanda aceita a segunda';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — cobrança paga exige hora e id do provedor
--
-- Paga sem id seria dinheiro sem origem conferível: a conciliação não teria o
-- que perguntar, e a divergência não teria dono.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE order_charges SET status = 'pago', paid_at = now()
     WHERE id = '37373737-cccc-0000-0000-000000000001';
    RAISE EXCEPTION 'a cobrança foi dada como paga sem id do provedor';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4 — paga exige id do provedor';
  END;

  BEGIN
    UPDATE order_charges SET status = 'pago', psp_payment_id = 'pi_1'
     WHERE id = '37373737-cccc-0000-0000-000000000001';
    RAISE EXCEPTION 'a cobrança foi dada como paga sem hora';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4b — paga exige hora';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — não se emite cobrança de dinheiro
--
-- O enum é o mesmo de `order_payments` de propósito — dois vocabulários para a
-- mesma coisa se separam no primeiro ajuste. O `CHECK` restringe aos meios que
-- o adquirente sabe emitir.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO order_charges
      (tenant_id, location_id, order_id, method, amount_cents, created_by_name)
    VALUES ('37373737-0000-0000-0000-000000000002',
            '37373737-aaaa-0000-0000-000000000002', '37373737-bbbb-0000-0000-000000000002',
            'cash', 4900, 'Maria');
    RAISE EXCEPTION 'aceitou emitir cobrança de dinheiro';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 5 — só pix, cartão e link são emissíveis';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — a cobrança de uma barbearia não é vista pela outra
--
-- Consulta **sem filtro**, de propósito: quem separa é a política, não o
-- `WHERE`. É o que faz um filtro esquecido no repositório não virar vazamento.
-- ----------------------------------------------------------------------------
INSERT INTO order_charges
  (tenant_id, location_id, order_id, method, amount_cents, created_by_name)
VALUES ('37373737-0000-0000-0000-000000000002',
        '37373737-aaaa-0000-0000-000000000002', '37373737-bbbb-0000-0000-000000000002',
        'pix', 4900, 'Vizinha');

INSERT INTO order_charge_events (event_id, tenant_id, type, outcome) VALUES
  ('evt_domari', '37373737-0000-0000-0000-000000000001', 'payment_intent.succeeded', 'pago'),
  ('evt_vizinha', '37373737-0000-0000-0000-000000000002', 'payment_intent.succeeded', 'pago');

-- O papel da aplicação, e não o dono da tabela: superusuário ignora RLS, e um
-- teste de isolamento rodado como ele afirmaria o contrário do que prova.
SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '37373737-0000-0000-0000-000000000001', true);

DO $$
DECLARE vistas integer;
BEGIN
  SELECT count(*) INTO vistas FROM order_charges;

  IF vistas <> 2 THEN
    RAISE EXCEPTION 'a Domari enxergou % cobranças; deveria enxergar as 2 dela', vistas;
  END IF;
  RAISE NOTICE 'OK 6 — cada barbearia enxerga só as próprias cobranças';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — o evento do adquirente também é da barbearia
--
-- Ao contrário de `psp_events`, que é infraestrutura da plataforma e só deixa
-- passar quem **não** tem tenant fixado. Aqui o evento é de uma venda dela, e
-- quem o aplica roda com o tenant aberto.
-- ----------------------------------------------------------------------------
DO $$
DECLARE vistos integer;
BEGIN
  SELECT count(*) INTO vistos FROM order_charge_events;

  IF vistos <> 1 THEN
    RAISE EXCEPTION 'a Domari enxergou % eventos; deveria enxergar 1', vistos;
  END IF;
  RAISE NOTICE 'OK 7 — o evento do adquirente é da barbearia dele';
END $$;

-- ----------------------------------------------------------------------------
-- 8 — a aplicação não apaga cobrança nem evento
--
-- A cobrança recusada e o evento que a recusou são a resposta para "por que
-- esta venda não fechou?" — justamente a pergunta que alguém quer apagar quando
-- o número não bate. Cobrança que não vale mais vira `expirado`, que é estado,
-- não sumiço.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    DELETE FROM order_charges;
    RAISE EXCEPTION 'a aplicação apagou cobrança';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 8 — a aplicação não apaga cobrança';
  END;
END $$;

DO $$
BEGIN
  BEGIN
    DELETE FROM order_charge_events;
    RAISE EXCEPTION 'a aplicação apagou evento do adquirente';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 8b — a aplicação não apaga evento';
  END;
END $$;

RESET ROLE;

ROLLBACK;
