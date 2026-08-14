-- ============================================================================
-- Invariantes de 0073 — franquia (bloco 76)
--
-- O que só o banco prova, e o que uma revisão de código não pegaria.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1 — uma franqueadora por franquia
--
-- Duas seriam duas mãos publicando o mesmo cardápio, e a última a salvar
-- venceria em silêncio.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_f uuid; v_a uuid; v_b uuid; recusou boolean := false;
BEGIN
  INSERT INTO tenants (name) VALUES ('Franqueadora 73') RETURNING id INTO v_a;
  INSERT INTO tenants (name) VALUES ('Outra 73') RETURNING id INTO v_b;
  INSERT INTO franchises (name) VALUES ('Rede 73') RETURNING id INTO v_f;

  INSERT INTO franchise_tenants (tenant_id, franchise_id, role)
  VALUES (v_a, v_f, 'franqueadora');

  BEGIN
    INSERT INTO franchise_tenants (tenant_id, franchise_id, role)
    VALUES (v_b, v_f, 'franqueadora');
  EXCEPTION WHEN unique_violation THEN recusou := true;
  END;

  IF NOT recusou THEN
    RAISE EXCEPTION 'duas franqueadoras na mesma franquia';
  END IF;
  RAISE NOTICE 'OK 1 — uma franqueadora por franquia';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — a franqueada não escreve o padrão, e quem recusa é a política
--
-- Sem isto a garantia seria uma checagem de rota: a franqueada que chamasse a
-- rota da franqueadora reescreveria o padrão da rede inteira.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_f uuid; v_dona uuid; v_filha uuid; v_item uuid; escreveu integer;
BEGIN
  INSERT INTO tenants (name) VALUES ('Dona 73b') RETURNING id INTO v_dona;
  INSERT INTO tenants (name) VALUES ('Filha 73b') RETURNING id INTO v_filha;
  INSERT INTO franchises (name) VALUES ('Rede 73b') RETURNING id INTO v_f;
  INSERT INTO franchise_tenants (tenant_id, franchise_id, role)
  VALUES (v_dona, v_f, 'franqueadora'), (v_filha, v_f, 'franqueada');

  INSERT INTO franchise_services (franchise_id, name, reference_price_cents, duration_minutes)
  VALUES (v_f, 'Corte padrão', 5500, 30) RETURNING id INTO v_item;

  SET LOCAL ROLE barbearia_app;

  PERFORM set_config('app.tenant_id', v_filha::text, true);
  UPDATE franchise_services SET reference_price_cents = 100 WHERE id = v_item;
  GET DIAGNOSTICS escreveu = ROW_COUNT;
  IF escreveu <> 0 THEN
    RAISE EXCEPTION 'a franqueada reescreveu o padrao da rede';
  END IF;

  PERFORM set_config('app.tenant_id', v_dona::text, true);
  UPDATE franchise_services SET reference_price_cents = 6000 WHERE id = v_item;
  GET DIAGNOSTICS escreveu = ROW_COUNT;
  IF escreveu <> 1 THEN
    RAISE EXCEPTION 'a franqueadora nao conseguiu publicar';
  END IF;

  RESET ROLE;
  PERFORM set_config('app.tenant_id', '', true);
  RAISE NOTICE 'OK 2 — so a franqueadora escreve o padrao';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — o padrão de uma franquia não vaza para outra
--
-- A consulta roda **sem filtro** de propósito: quem filtra é a política, e um
-- `WHERE` repetido aqui mascararia política ausente.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_f1 uuid; v_f2 uuid; v_t1 uuid; v_t2 uuid; visiveis integer;
BEGIN
  INSERT INTO tenants (name) VALUES ('Rede A 73c') RETURNING id INTO v_t1;
  INSERT INTO tenants (name) VALUES ('Rede B 73c') RETURNING id INTO v_t2;
  INSERT INTO franchises (name) VALUES ('A 73c') RETURNING id INTO v_f1;
  INSERT INTO franchises (name) VALUES ('B 73c') RETURNING id INTO v_f2;
  INSERT INTO franchise_tenants (tenant_id, franchise_id, role)
  VALUES (v_t1, v_f1, 'franqueadora'), (v_t2, v_f2, 'franqueadora');

  INSERT INTO franchise_services (franchise_id, name, reference_price_cents, duration_minutes)
  VALUES (v_f1, 'So da A', 5500, 30), (v_f2, 'So da B', 4500, 30);

  SET LOCAL ROLE barbearia_app;
  PERFORM set_config('app.tenant_id', v_t1::text, true);

  SELECT count(*) INTO visiveis FROM franchise_services WHERE name = 'So da B';
  IF visiveis <> 0 THEN
    RAISE EXCEPTION 'a franquia A leu o padrao da franquia B';
  END IF;

  SELECT count(*) INTO visiveis FROM franchise_services WHERE name = 'So da A';
  IF visiveis <> 1 THEN
    RAISE EXCEPTION 'a franquia A nao leu o proprio padrao';
  END IF;

  RESET ROLE;
  PERFORM set_config('app.tenant_id', '', true);
  RAISE NOTICE 'OK 3 — o padrao nao atravessa franquias';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — o item do padrão não é apagável pela aplicação
--
-- Quem adotou continua vendendo. Tirar do padrão é estado.
-- ----------------------------------------------------------------------------
DO $$
DECLARE tem boolean;
BEGIN
  SELECT has_table_privilege('barbearia_app', 'franchise_services', 'DELETE') INTO tem;
  IF tem THEN
    RAISE EXCEPTION 'a aplicacao pode apagar item do padrao';
  END IF;
  RAISE NOTICE 'OK 4 — item do padrao nao e apagavel';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — a chave estrangeira para o padrão é `SET NULL`
--
-- `CASCADE` roda com os direitos do dono e levaria junto o serviço que a
-- franqueada vende há dois anos — com `appointment_services` apontando para
-- ele. É a mesma regra do bloco 46.
-- ----------------------------------------------------------------------------
DO $$
DECLARE acao text;
BEGIN
  SELECT c.confdeltype INTO acao
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_class f ON f.oid = c.confrelid
   WHERE t.relname = 'services' AND f.relname = 'franchise_services' AND c.contype = 'f';

  IF acao IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION 'services.franchise_service_id nao e SET NULL: %', acao;
  END IF;
  RAISE NOTICE 'OK 5 — o vinculo se desfaz, o servico fica';
END $$;

-- ----------------------------------------------------------------------------
-- 6 — não existe coluna que imponha preço a outra empresa
--
-- O preço de referência mora em `franchise_services`, e é o único lugar. Uma
-- coluna de preço da franqueadora dentro de `services` seria o caminho pelo
-- qual o número dela vira o número cobrado sem ninguém da franqueada mandar —
-- imposição de preço de revenda com outro nome (Lei 12.529/2011 art. 36 §3º IX).
-- ----------------------------------------------------------------------------
DO $$
DECLARE achada text;
BEGIN
  SELECT c.table_name || '.' || c.column_name INTO achada
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.column_name ~* '(reference_price|franchise_price|preco_padrao)'
     AND c.table_name <> 'franchise_services'
   LIMIT 1;

  IF achada IS NOT NULL THEN
    RAISE EXCEPTION 'preco da franqueadora fora de franchise_services: %', achada;
  END IF;
  RAISE NOTICE 'OK 6 — o preco de referencia mora em um lugar so';
END $$;

-- ----------------------------------------------------------------------------
-- 6b — a barbearia não escreve a própria participação
--
-- É a tabela que decide **de qual franquia cada casa é e em que papel**, e é
-- dela que as duas funções `SECURITY DEFINER` derivam a política do padrão:
-- escrever nela é escrever a própria política.
--
-- A primeira versão a deixou sem RLS, com um `GRANT SELECT` como única defesa —
-- e aquele `GRANT` não defendia nada, porque a 0002 já dá os quatro por
-- `ALTER DEFAULT PRIVILEGES` e conceder não revoga. Achado da revisão do
-- bloco 76.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_f uuid; v_dona uuid; v_alheia uuid; escreveu integer; recusou boolean := false;
BEGIN
  INSERT INTO tenants (name) VALUES ('Dona 73g') RETURNING id INTO v_dona;
  INSERT INTO tenants (name) VALUES ('Alheia 73g') RETURNING id INTO v_alheia;
  INSERT INTO franchises (name) VALUES ('Rede 73g') RETURNING id INTO v_f;
  INSERT INTO franchise_tenants (tenant_id, franchise_id, role)
  VALUES (v_dona, v_f, 'franqueadora');

  SET LOCAL ROLE barbearia_app;
  PERFORM set_config('app.tenant_id', v_alheia::text, true);

  -- Ler a participação alheia: zero linhas, e a consulta roda **sem** filtro
  -- de propósito — quem filtra é a política.
  IF (SELECT count(*) FROM franchise_tenants) <> 0 THEN
    RAISE EXCEPTION 'a barbearia leu o mapa de participacao de outra';
  END IF;

  -- Pôr-se como franqueadora de uma rede alheia.
  BEGIN
    INSERT INTO franchise_tenants (tenant_id, franchise_id, role)
    VALUES (v_alheia, v_f, 'franqueadora');
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN recusou := true;
  END;
  IF NOT recusou THEN
    RAISE EXCEPTION 'a barbearia se pos como franqueadora de uma rede alheia';
  END IF;

  -- Expulsar a franqueadora de verdade.
  DELETE FROM franchise_tenants WHERE tenant_id = v_dona;
  GET DIAGNOSTICS escreveu = ROW_COUNT;
  IF escreveu <> 0 THEN
    RAISE EXCEPTION 'a barbearia expulsou a franqueadora da rede';
  END IF;

  -- E a marca não é renomeável por quem lê.
  UPDATE franchises SET name = 'sequestrada' WHERE id = v_f;
  GET DIAGNOSTICS escreveu = ROW_COUNT;
  IF escreveu <> 0 THEN
    RAISE EXCEPTION 'a barbearia renomeou uma franquia';
  END IF;

  RESET ROLE;
  PERFORM set_config('app.tenant_id', '', true);
  -- E ela é `FORCE`, como todas as outras: sem isso a proteção passaria a
  -- depender de `barbearia_app` nunca ser dona de tabela — um fato do
  -- provisionamento, não da tabela.
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity
            FROM pg_class WHERE relname = 'franchise_tenants') THEN
    RAISE EXCEPTION 'franchise_tenants sem RLS FORCE';
  END IF;

  RAISE NOTICE 'OK 6b — a participacao so e escrita sem tenant, pela plataforma';
END $$;

-- ----------------------------------------------------------------------------
-- 6c — e a plataforma, que roda sem tenant, continua conseguindo montar
--
-- Uma política que travasse os dois lados não é isolamento, é cegueira: as
-- rotas do Super Admin existiriam e nunca funcionariam.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_f uuid; v_t uuid; escreveu integer;
BEGIN
  INSERT INTO tenants (name) VALUES ('Nova 73i') RETURNING id INTO v_t;
  INSERT INTO franchises (name) VALUES ('Rede 73i') RETURNING id INTO v_f;

  SET LOCAL ROLE barbearia_app;
  PERFORM set_config('app.tenant_id', '', true);

  INSERT INTO franchise_tenants (tenant_id, franchise_id, role)
  VALUES (v_t, v_f, 'franqueada');
  GET DIAGNOSTICS escreveu = ROW_COUNT;
  IF escreveu <> 1 THEN
    RAISE EXCEPTION 'a plataforma nao conseguiu montar a franquia';
  END IF;

  RESET ROLE;
  RAISE NOTICE 'OK 6c — a plataforma monta, sem tenant no contexto';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — RLS FORCE com USING e WITH CHECK no padrão
-- ----------------------------------------------------------------------------
DO $$
DECLARE forcada boolean; usando integer; checando integer;
BEGIN
  SELECT relrowsecurity AND relforcerowsecurity INTO forcada
    FROM pg_class WHERE relname = 'franchise_services';
  SELECT count(*) INTO usando FROM pg_policies
   WHERE tablename = 'franchise_services' AND qual IS NOT NULL;
  SELECT count(*) INTO checando FROM pg_policies
   WHERE tablename = 'franchise_services' AND with_check IS NOT NULL;

  IF NOT forcada OR usando = 0 OR checando = 0 THEN
    RAISE EXCEPTION 'franchise_services sem RLS FORCE completa (% % %)', forcada, usando, checando;
  END IF;
  RAISE NOTICE 'OK 7 — RLS FORCE com USING e WITH CHECK';
END $$;

-- ----------------------------------------------------------------------------
-- 8 — a permissão nova é aceita, e uma inventada continua sendo recusada
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_t uuid; recusou boolean := false;
BEGIN
  INSERT INTO tenants (name) VALUES ('Papeis 73h') RETURNING id INTO v_t;
  INSERT INTO role_permissions (tenant_id, role, permission)
  VALUES (v_t, 'owner', 'franchise.manage');

  BEGIN
    INSERT INTO role_permissions (tenant_id, role, permission)
    VALUES (v_t, 'owner', 'franchise.impose_price');
  EXCEPTION WHEN check_violation THEN recusou := true;
  END;

  IF NOT recusou THEN
    RAISE EXCEPTION 'permissao inventada foi aceita';
  END IF;
  RAISE NOTICE 'OK 8 — franchise.manage entrou no catalogo do banco';
END $$;
