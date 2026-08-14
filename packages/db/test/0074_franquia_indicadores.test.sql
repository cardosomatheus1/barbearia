-- ============================================================================
-- Invariantes de 0074 — indicadores consolidados da rede (bloco 77)
--
-- Esta é a única função do produto que atravessa a RLS de outro tenant de
-- propósito. O que estes testes provam é o **limite** dela.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1 — a franquia é a do contexto, e o parâmetro não escolhe
--
-- Se a assinatura aceitasse um id de franquia, o relatório da rede concorrente
-- sairia com um `uuid` escrito à mão. A função só recebe datas.
-- ----------------------------------------------------------------------------
DO $$
DECLARE args text;
BEGIN
  SELECT pg_get_function_identity_arguments(p.oid) INTO args
    FROM pg_proc p WHERE p.proname = 'indicadores_da_franquia';

  IF args IS DISTINCT FROM 'p_de date, p_ate date' THEN
    RAISE EXCEPTION 'indicadores_da_franquia aceita mais que datas: %', args;
  END IF;
  RAISE NOTICE 'OK 1 — a franquia vem do contexto, nunca do parametro';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — sem tenant no contexto ela não devolve nada
--
-- A plataforma não lê faturamento de barbearia por esta porta. É a mesma
-- postura de `tenant_platform`: o que a plataforma vê é plano e bloqueio.
-- ----------------------------------------------------------------------------
DO $$
DECLARE quantas integer;
BEGIN
  SET LOCAL ROLE barbearia_app;
  PERFORM set_config('app.tenant_id', '', true);
  SELECT count(*) INTO quantas FROM indicadores_da_franquia(current_date, current_date);
  IF quantas <> 0 THEN
    RAISE EXCEPTION 'a funcao devolveu % linhas sem tenant no contexto', quantas;
  END IF;
  RESET ROLE;
  RAISE NOTICE 'OK 2 — sem tenant, sem linha';
END $$;

-- ----------------------------------------------------------------------------
-- 3 — a soma atravessa; a identidade é redigida para a franqueada
--
-- A franqueadora recebe a rede nomeada — é o contrato de franquia, e royalty é
-- percentual sobre receita. A franqueada recebe números sem nome: as partes são
-- empresas concorrentes entre si dentro da mesma marca.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_f uuid; v_dona uuid; v_a uuid; v_b uuid; v_loc uuid;
  nomeados integer; anonimos integer;
BEGIN
  INSERT INTO tenants (name) VALUES ('Dona 74') RETURNING id INTO v_dona;
  INSERT INTO tenants (name) VALUES ('Filha A 74') RETURNING id INTO v_a;
  INSERT INTO tenants (name) VALUES ('Filha B 74') RETURNING id INTO v_b;
  INSERT INTO franchises (name) VALUES ('Rede 74') RETURNING id INTO v_f;
  INSERT INTO franchise_tenants (tenant_id, franchise_id, role) VALUES
    (v_dona, v_f, 'franqueadora'), (v_a, v_f, 'franqueada'), (v_b, v_f, 'franqueada');

  INSERT INTO locations (tenant_id, name, timezone)
  VALUES (v_a, 'Matriz', 'America/Bahia') RETURNING id INTO v_loc;
  INSERT INTO orders (tenant_id, location_id, status, subtotal_cents, total_cents,
                      business_day, opened_at, closed_at)
  VALUES (v_a, v_loc, 'paid', 50000, 50000, current_date, now(), now());

  SET LOCAL ROLE barbearia_app;

  -- A franqueadora: as duas nomeadas.
  PERFORM set_config('app.tenant_id', v_dona::text, true);
  SELECT count(*) INTO nomeados
    FROM indicadores_da_franquia(current_date - 1, current_date + 1) WHERE nome IS NOT NULL;
  IF nomeados <> 2 THEN
    RAISE EXCEPTION 'a franqueadora viu % linhas nomeadas, esperava 2', nomeados;
  END IF;

  -- A franqueada A: a dela nomeada, a vizinha anônima — e o número da vizinha
  -- **existe**, porque a mediana da rede sai dele. O que não sai é de quem é.
  PERFORM set_config('app.tenant_id', v_a::text, true);
  SELECT count(*) INTO nomeados
    FROM indicadores_da_franquia(current_date - 1, current_date + 1) WHERE nome IS NOT NULL;
  SELECT count(*) INTO anonimos
    FROM indicadores_da_franquia(current_date - 1, current_date + 1) WHERE nome IS NULL;
  IF nomeados <> 1 OR anonimos <> 1 THEN
    RAISE EXCEPTION 'redacao errada para a franqueada: % nomeadas, % anonimas', nomeados, anonimos;
  END IF;

  RESET ROLE;
  PERFORM set_config('app.tenant_id', '', true);
  RAISE NOTICE 'OK 3 — a soma atravessa, a identidade nao';
END $$;

-- ----------------------------------------------------------------------------
-- 4 — o que atravessa é a soma, e mais nada
--
-- O cadastro do cliente da franqueada continua atrás da RLS. Se a franqueadora
-- alcançasse `customers`, o bloco teria trocado a lei do contrato de franquia
-- por um vazamento de base.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_f uuid; v_dona uuid; v_a uuid; vistos integer;
BEGIN
  INSERT INTO tenants (name) VALUES ('Dona 74d') RETURNING id INTO v_dona;
  INSERT INTO tenants (name) VALUES ('Filha 74d') RETURNING id INTO v_a;
  INSERT INTO franchises (name) VALUES ('Rede 74d') RETURNING id INTO v_f;
  INSERT INTO franchise_tenants (tenant_id, franchise_id, role) VALUES
    (v_dona, v_f, 'franqueadora'), (v_a, v_f, 'franqueada');
  INSERT INTO customers (tenant_id, name, phone_e164)
  VALUES (v_a, 'Cliente da Franqueada', '+5571988880074');

  SET LOCAL ROLE barbearia_app;
  PERFORM set_config('app.tenant_id', v_dona::text, true);

  SELECT count(*) INTO vistos FROM customers;
  IF vistos <> 0 THEN
    RAISE EXCEPTION 'a franqueadora leu % clientes da franqueada', vistos;
  END IF;
  SELECT count(*) INTO vistos FROM orders;
  IF vistos <> 0 THEN
    RAISE EXCEPTION 'a franqueadora leu comanda da franqueada';
  END IF;

  RESET ROLE;
  PERFORM set_config('app.tenant_id', '', true);
  RAISE NOTICE 'OK 4 — so a soma atravessa; cliente e comanda ficam';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — a meta é escrita pela franqueadora, e lida por quem é dela
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_f uuid; v_dona uuid; v_a uuid; v_b uuid; escreveu integer; recusou boolean := false;
BEGIN
  INSERT INTO tenants (name) VALUES ('Dona 74e') RETURNING id INTO v_dona;
  INSERT INTO tenants (name) VALUES ('Filha A 74e') RETURNING id INTO v_a;
  INSERT INTO tenants (name) VALUES ('Filha B 74e') RETURNING id INTO v_b;
  INSERT INTO franchises (name) VALUES ('Rede 74e') RETURNING id INTO v_f;
  INSERT INTO franchise_tenants (tenant_id, franchise_id, role) VALUES
    (v_dona, v_f, 'franqueadora'), (v_a, v_f, 'franqueada'), (v_b, v_f, 'franqueada');

  SET LOCAL ROLE barbearia_app;

  PERFORM set_config('app.tenant_id', v_dona::text, true);
  INSERT INTO franchise_goals (franchise_id, tenant_id, month, revenue_cents)
  VALUES (v_f, v_a, date_trunc('month', current_date)::date, 200000),
         (v_f, v_b, date_trunc('month', current_date)::date, 90000);

  -- A franqueada A: vê a dela e só a dela. A consulta roda **sem filtro** de
  -- proposito — quem filtra é a política.
  PERFORM set_config('app.tenant_id', v_a::text, true);
  SELECT count(*) INTO escreveu FROM franchise_goals;
  IF escreveu <> 1 THEN
    RAISE EXCEPTION 'a franqueada viu % metas, esperava 1', escreveu;
  END IF;

  -- E não escreve a própria.
  BEGIN
    INSERT INTO franchise_goals (franchise_id, tenant_id, month, revenue_cents)
    VALUES (v_f, v_a, (date_trunc('month', current_date) + interval '1 month')::date, 1);
  EXCEPTION WHEN insufficient_privilege THEN recusou := true;
  END;
  IF NOT recusou THEN
    RAISE EXCEPTION 'a franqueada escreveu a propria meta';
  END IF;

  RESET ROLE;
  PERFORM set_config('app.tenant_id', '', true);
  RAISE NOTICE 'OK 5 — meta escrita pela franqueadora, lida por quem e dela';
END $$;

-- ----------------------------------------------------------------------------
-- 6 — indicador não é tabela
--
-- Mesma decisão do DRE, do saldo de estoque e do de fidelidade: um número que
-- alguém sobrescreve responde "quanto deu" e não *"por que caiu?"*.
-- ----------------------------------------------------------------------------
DO $$
DECLARE achada text;
BEGIN
  SELECT c.table_name INTO achada
    FROM information_schema.tables c
   WHERE c.table_schema = 'public'
     AND c.table_name ~* 'franchise.*(metric|indicador|consolidad|resultado)'
   LIMIT 1;

  IF achada IS NOT NULL THEN
    RAISE EXCEPTION 'indicador da rede virou tabela: %', achada;
  END IF;
  RAISE NOTICE 'OK 6 — o indicador da rede e derivado';
END $$;
