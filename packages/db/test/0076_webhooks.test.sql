-- ============================================================================
-- Invariantes de 0076 — webhooks para terceiros (bloco 79)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1 — só `https://`
--
-- A assinatura prova a origem; ela não esconde o conteúdo. Um endereço `http`
-- levaria o corpo pela rede em claro — e o corpo carrega ids que abrem a API
-- pública para quem também tiver a chave.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_t uuid; recusou boolean := false;
BEGIN
  INSERT INTO tenants (name) VALUES ('Webhooks 76') RETURNING id INTO v_t;

  BEGIN
    INSERT INTO webhook_endpoints (tenant_id, name, url, secret_cipher, events)
    VALUES (v_t, 'Inseguro', 'http://exemplo.com.br/hook', 'x',
            ARRAY['appointment.created']::webhook_event[]);
  EXCEPTION WHEN check_violation THEN recusou := true;
  END;
  IF NOT recusou THEN RAISE EXCEPTION 'endereco http foi aceito'; END IF;

  INSERT INTO webhook_endpoints (tenant_id, name, url, secret_cipher, events)
  VALUES (v_t, 'Seguro', 'https://exemplo.com.br/hook', 'x',
          ARRAY['appointment.created']::webhook_event[]);

  RAISE NOTICE 'OK 1 — so https';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — endereço sem evento é recusado
--
-- Um endereço que não assina nada é uma credencial viva que nunca é usada e que
-- ninguém revoga, porque não dá para saber o que ela quebraria.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_t uuid; recusou boolean := false;
BEGIN
  INSERT INTO tenants (name) VALUES ('Webhooks 76b') RETURNING id INTO v_t;
  BEGIN
    INSERT INTO webhook_endpoints (tenant_id, name, url, secret_cipher, events)
    VALUES (v_t, 'Mudo', 'https://exemplo.com.br/hook', 'x', ARRAY[]::webhook_event[]);
  EXCEPTION WHEN check_violation THEN recusou := true;
  END;
  IF NOT recusou THEN RAISE EXCEPTION 'endereco sem evento foi aceito'; END IF;
  RAISE NOTICE 'OK 2 — endereco sem evento e recusado';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — o endereço da vizinha não é visto nem desligado
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_a uuid; v_b uuid; visiveis integer; escreveu integer;
BEGIN
  INSERT INTO tenants (name) VALUES ('Casa A 76c') RETURNING id INTO v_a;
  INSERT INTO tenants (name) VALUES ('Casa B 76c') RETURNING id INTO v_b;
  INSERT INTO webhook_endpoints (tenant_id, name, url, secret_cipher, events)
  VALUES (v_b, 'Da vizinha', 'https://vizinha.com.br/hook', 'segredo-cifrado',
          ARRAY['appointment.created']::webhook_event[]);

  SET LOCAL ROLE barbearia_app;
  PERFORM set_config('app.tenant_id', v_a::text, true);

  -- A consulta roda **sem filtro** de propósito: quem filtra é a política.
  SELECT count(*) INTO visiveis FROM webhook_endpoints;
  IF visiveis <> 0 THEN RAISE EXCEPTION 'a casa A leu o endereco da casa B'; END IF;

  UPDATE webhook_endpoints SET active = false;
  GET DIAGNOSTICS escreveu = ROW_COUNT;
  IF escreveu <> 0 THEN RAISE EXCEPTION 'a casa A desligou o webhook da casa B'; END IF;

  RESET ROLE;
  PERFORM set_config('app.tenant_id', '', true);
  RAISE NOTICE 'OK 3 — o endereco da vizinha nao e visto nem desligado';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — o segredo não tem coluna em claro
--
-- Só o cifrado. É o precedente do token do cartão, do certificado digital e do
-- token de WhatsApp.
-- ----------------------------------------------------------------------------
DO $$
DECLARE achada text;
BEGIN
  SELECT c.column_name INTO achada
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'webhook_endpoints'
     AND c.column_name ~* '(secret|token|segredo)'
     AND c.column_name <> 'secret_cipher'
   LIMIT 1;

  IF achada IS NOT NULL THEN
    RAISE EXCEPTION 'webhook_endpoints guarda credencial em claro: %', achada;
  END IF;
  RAISE NOTICE 'OK 4 — so o segredo cifrado';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — a entrega não é apagável, e o id do evento é único
--
-- A entrega é o documento da conversa: *"não recebi nada"* é a discussão que
-- ela fecha. E o `event_id` é a chave que o outro lado usa para deduplicar —
-- reentrega é normal, porque a escada existe.
-- ----------------------------------------------------------------------------
DO $$
DECLARE tem boolean; v_t uuid; v_e uuid; recusou boolean := false;
BEGIN
  SELECT has_table_privilege('barbearia_app', 'webhook_deliveries', 'DELETE') INTO tem;
  IF tem THEN RAISE EXCEPTION 'a aplicacao pode apagar entrega de webhook'; END IF;

  INSERT INTO tenants (name) VALUES ('Webhooks 76e') RETURNING id INTO v_t;
  INSERT INTO webhook_endpoints (tenant_id, name, url, secret_cipher, events)
  VALUES (v_t, 'Um', 'https://exemplo.com.br/hook', 'x',
          ARRAY['appointment.created']::webhook_event[]) RETURNING id INTO v_e;

  INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event, payload, event_id)
  VALUES (v_t, v_e, 'appointment.created', '{}'::jsonb,
          '76e00000-0000-0000-0000-000000000001');

  BEGIN
    INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event, payload, event_id)
    VALUES (v_t, v_e, 'appointment.created', '{}'::jsonb,
            '76e00000-0000-0000-0000-000000000001');
  EXCEPTION WHEN unique_violation THEN recusou := true;
  END;
  IF NOT recusou THEN RAISE EXCEPTION 'dois eventos com o mesmo id'; END IF;

  RAISE NOTICE 'OK 5 — entrega nao e apagavel, e o id do evento e unico';
END $$;

-- ----------------------------------------------------------------------------
-- 6 — entregue sem hora, ou hora sem entregue, é recusado
--
-- "Entregue" é o fato que o integrador confere quando reclama. Um estado sem
-- data seria a tela afirmando algo que ninguém consegue datar.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_t uuid; v_e uuid; recusou boolean := false;
BEGIN
  INSERT INTO tenants (name) VALUES ('Webhooks 76f') RETURNING id INTO v_t;
  INSERT INTO webhook_endpoints (tenant_id, name, url, secret_cipher, events)
  VALUES (v_t, 'Um', 'https://exemplo.com.br/hook', 'x',
          ARRAY['order.paid']::webhook_event[]) RETURNING id INTO v_e;

  BEGIN
    INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event, payload, status)
    VALUES (v_t, v_e, 'order.paid', '{}'::jsonb, 'entregue');
  EXCEPTION WHEN check_violation THEN recusou := true;
  END;
  IF NOT recusou THEN RAISE EXCEPTION 'entregue sem hora foi aceito'; END IF;

  RAISE NOTICE 'OK 6 — entregue e hora andam juntos';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — a varredura enxerga sem tenant, e a barbearia só o que é dela
--
-- O worker entrega fora de requisição e varre o pendente de todas as
-- barbearias; a barbearia enxerga a própria fila. Uma política estrita por
-- tenant deixaria a varredura com zero linhas — sempre, e em silêncio.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_a uuid; v_b uuid; v_e uuid; visiveis integer;
BEGIN
  INSERT INTO tenants (name) VALUES ('Casa A 76g') RETURNING id INTO v_a;
  INSERT INTO tenants (name) VALUES ('Casa B 76g') RETURNING id INTO v_b;
  INSERT INTO webhook_endpoints (tenant_id, name, url, secret_cipher, events)
  VALUES (v_b, 'Da vizinha', 'https://vizinha.com.br/hook', 'x',
          ARRAY['order.paid']::webhook_event[]) RETURNING id INTO v_e;
  INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event, payload)
  VALUES (v_b, v_e, 'order.paid', '{}'::jsonb);

  SET LOCAL ROLE barbearia_app;

  PERFORM set_config('app.tenant_id', v_a::text, true);
  SELECT count(*) INTO visiveis FROM webhook_deliveries;
  IF visiveis <> 0 THEN RAISE EXCEPTION 'a casa A leu a fila da casa B'; END IF;

  -- Recortado a este endpoint: os blocos anteriores deixaram entregas de outras
  -- barbearias, e sem tenant a varredura enxerga todas — que é o ponto.
  PERFORM set_config('app.tenant_id', '', true);
  SELECT count(*) INTO visiveis FROM webhook_deliveries WHERE endpoint_id = v_e;
  IF visiveis <> 1 THEN RAISE EXCEPTION 'a varredura nao enxerga sem tenant'; END IF;

  RESET ROLE;
  RAISE NOTICE 'OK 7 — a varredura enxerga sem tenant; a barbearia so o que e dela';
END $$;

-- ----------------------------------------------------------------------------
-- 8 — nenhuma chave estrangeira em `webhook_deliveries` apaga em cascata
--
-- Ação referencial roda com os direitos do dono da tabela e **não** passa pelo
-- `REVOKE DELETE`. Numa tabela que ninguém pode apagar, uma cascata é o caminho
-- de destruição que a revogação existia para fechar. `tenant_id` é a exceção de
-- sempre: apagada a barbearia, não há conversa a documentar.
-- ----------------------------------------------------------------------------
DO $$
DECLARE achada text;
BEGIN
  SELECT c.conname INTO achada
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'webhook_deliveries'
     AND c.contype = 'f'
     AND c.confdeltype = 'c'
     AND NOT EXISTS (
       SELECT 1 FROM unnest(c.conkey) k
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
       WHERE a.attname = 'tenant_id'
     )
   LIMIT 1;

  IF achada IS NOT NULL THEN
    RAISE EXCEPTION 'cascata numa tabela append-only: %', achada;
  END IF;
  RAISE NOTICE 'OK 8 — nenhuma cascata alcanca a entrega';
END $$;
