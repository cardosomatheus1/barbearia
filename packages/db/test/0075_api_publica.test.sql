-- ============================================================================
-- Invariantes de 0075 — API pública (bloco 78)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1 — dinheiro não entra numa chave de API
--
-- O segundo fator deste produto é derivado do prefixo e provado por **sessão**,
-- com TOTP. Máquina não digita TOTP: ou a chave seria inútil, ou alguém a
-- isentaria da exigência — e aí a API pública viraria a porta sem segundo fator
-- para o dinheiro que o balcão só move com ele.
--
-- Terceira camada. As outras duas são a borda e o domínio.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_t uuid; recusou boolean;
BEGIN
  INSERT INTO tenants (name) VALUES ('Chaves 75') RETURNING id INTO v_t;

  -- `finance.view`
  recusou := false;
  BEGIN
    INSERT INTO api_keys (tenant_id, name, prefix, secret_hmac, scopes)
    VALUES (v_t, 'Integracao', 'aaaaaaaaaaaa', 'x', ARRAY['appointments.view', 'finance.view']);
  EXCEPTION WHEN check_violation THEN recusou := true;
  END;
  IF NOT recusou THEN RAISE EXCEPTION 'chave com finance.view foi aceita'; END IF;

  -- `cashier.withdraw`
  recusou := false;
  BEGIN
    INSERT INTO api_keys (tenant_id, name, prefix, secret_hmac, scopes)
    VALUES (v_t, 'Integracao', 'bbbbbbbbbbbb', 'x', ARRAY['cashier.withdraw']);
  EXCEPTION WHEN check_violation THEN recusou := true;
  END;
  IF NOT recusou THEN RAISE EXCEPTION 'chave com cashier.withdraw foi aceita'; END IF;

  -- `commission.view_all` — revela a folha, e por isso está no grupo.
  recusou := false;
  BEGIN
    INSERT INTO api_keys (tenant_id, name, prefix, secret_hmac, scopes)
    VALUES (v_t, 'Integracao', 'cccccccccccc', 'x', ARRAY['commission.view_all']);
  EXCEPTION WHEN check_violation THEN recusou := true;
  END;
  IF NOT recusou THEN RAISE EXCEPTION 'chave com commission.view_all foi aceita'; END IF;

  -- E a chave legítima passa.
  INSERT INTO api_keys (tenant_id, name, prefix, secret_hmac, scopes)
  VALUES (v_t, 'Integracao do site', 'dddddddddddd', 'x',
          ARRAY['appointments.view', 'appointments.create']);

  RAISE NOTICE 'OK 1 — dinheiro nao entra numa chave de API';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — chave sem escopo é recusada
--
-- Uma credencial viva que não serve para nada e que ninguém revoga, porque não
-- dá para saber o que ela quebraria.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_t uuid; recusou boolean := false;
BEGIN
  INSERT INTO tenants (name) VALUES ('Chaves 75b') RETURNING id INTO v_t;
  BEGIN
    INSERT INTO api_keys (tenant_id, name, prefix, secret_hmac, scopes)
    VALUES (v_t, 'Vazia', 'eeeeeeeeeeee', 'x', ARRAY[]::text[]);
  EXCEPTION WHEN check_violation THEN recusou := true;
  END;
  IF NOT recusou THEN RAISE EXCEPTION 'chave sem escopo foi aceita'; END IF;
  RAISE NOTICE 'OK 2 — chave sem escopo e recusada';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — a chave não é apagável, e revogar exige motivo
--
-- A chave que rodou seis meses aparece na trilha de tudo que ela fez; apagá-la
-- deixaria aquele histórico apontando para nada.
-- ----------------------------------------------------------------------------
DO $$
DECLARE tem boolean; v_t uuid; recusou boolean := false;
BEGIN
  SELECT has_table_privilege('barbearia_app', 'api_keys', 'DELETE') INTO tem;
  IF tem THEN RAISE EXCEPTION 'a aplicacao pode apagar chave de API'; END IF;

  INSERT INTO tenants (name) VALUES ('Chaves 75c') RETURNING id INTO v_t;
  INSERT INTO api_keys (tenant_id, name, prefix, secret_hmac, scopes)
  VALUES (v_t, 'Uma', 'ffffffffffff', 'x', ARRAY['appointments.view']);

  BEGIN
    UPDATE api_keys SET revoked_at = now() WHERE prefix = 'ffffffffffff';
  EXCEPTION WHEN check_violation THEN recusou := true;
  END;
  IF NOT recusou THEN RAISE EXCEPTION 'revogacao sem motivo foi aceita'; END IF;

  RAISE NOTICE 'OK 3 — chave nao e apagavel, e revogar exige motivo';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — a chave da vizinha não é lida nem revogada de dentro da barbearia
--
-- A leitura sem tenant existe porque a autenticação acontece antes de haver
-- tenant no contexto. **Com** tenant, a política separa as barbearias.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_a uuid; v_b uuid; visiveis integer; escreveu integer;
BEGIN
  INSERT INTO tenants (name) VALUES ('Casa A 75d') RETURNING id INTO v_a;
  INSERT INTO tenants (name) VALUES ('Casa B 75d') RETURNING id INTO v_b;
  INSERT INTO api_keys (tenant_id, name, prefix, secret_hmac, scopes)
  VALUES (v_b, 'Da vizinha', '111111111111', 'segredo-da-vizinha', ARRAY['appointments.view']);

  SET LOCAL ROLE barbearia_app;
  PERFORM set_config('app.tenant_id', v_a::text, true);

  -- A consulta roda **sem filtro** de propósito: quem filtra é a política.
  SELECT count(*) INTO visiveis FROM api_keys WHERE prefix = '111111111111';
  IF visiveis <> 0 THEN RAISE EXCEPTION 'a casa A leu a chave da casa B'; END IF;

  UPDATE api_keys SET revoked_at = now(), revoke_reason = 'sabotagem'
   WHERE prefix = '111111111111';
  GET DIAGNOSTICS escreveu = ROW_COUNT;
  IF escreveu <> 0 THEN RAISE EXCEPTION 'a casa A revogou a chave da casa B'; END IF;

  -- E sem tenant, que é como a autenticação roda, ela é encontrada.
  PERFORM set_config('app.tenant_id', '', true);
  SELECT count(*) INTO visiveis FROM api_keys WHERE prefix = '111111111111';
  IF visiveis <> 1 THEN RAISE EXCEPTION 'a autenticacao nao acha a chave sem tenant'; END IF;

  RESET ROLE;
  RAISE NOTICE 'OK 4 — a chave da vizinha nao e lida nem revogada';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — o teto é por chave, e uma linha por minuto
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_t uuid; v_k uuid; total integer;
BEGIN
  INSERT INTO tenants (name) VALUES ('Chaves 75e') RETURNING id INTO v_t;
  INSERT INTO api_keys (tenant_id, name, prefix, secret_hmac, scopes)
  VALUES (v_t, 'Uma', '222222222222', 'x', ARRAY['appointments.view']) RETURNING id INTO v_k;

  INSERT INTO api_key_usage (api_key_id, minuto, chamadas)
  VALUES (v_k, date_trunc('minute', now()), 1)
  ON CONFLICT (api_key_id, minuto) DO UPDATE SET chamadas = api_key_usage.chamadas + 1;

  INSERT INTO api_key_usage (api_key_id, minuto, chamadas)
  VALUES (v_k, date_trunc('minute', now()), 1)
  ON CONFLICT (api_key_id, minuto) DO UPDATE SET chamadas = api_key_usage.chamadas + 1;

  SELECT chamadas INTO total FROM api_key_usage
   WHERE api_key_id = v_k AND minuto = date_trunc('minute', now());
  IF total <> 2 THEN RAISE EXCEPTION 'o contador do minuto marcou %, esperava 2', total; END IF;

  RAISE NOTICE 'OK 5 — o teto e por chave, uma linha por minuto';
END $$;

-- ----------------------------------------------------------------------------
-- 6 — o segredo não tem coluna
--
-- Só o prefixo em claro e o HMAC. Uma coluna de segredo seria o banco vazado
-- entregando credencial viva — é o precedente do token do cartão e do
-- certificado digital.
-- ----------------------------------------------------------------------------
DO $$
DECLARE achada text;
BEGIN
  SELECT c.column_name INTO achada
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'api_keys'
     AND c.column_name ~* '(secret|token|password|segredo)'
     AND c.column_name <> 'secret_hmac'
   LIMIT 1;

  IF achada IS NOT NULL THEN
    RAISE EXCEPTION 'api_keys guarda credencial em claro: %', achada;
  END IF;
  RAISE NOTICE 'OK 6 — so o prefixo e o HMAC';
END $$;
