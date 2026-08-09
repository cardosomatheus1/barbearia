-- ============================================================================
-- Invariantes da assinatura (bloco 27).
--
-- Duas coisas são provadas aqui, e a segunda é a que o bloco existe para
-- resolver: **o teto de cadeiras recusa de verdade**, por todos os caminhos —
-- inclusive o que não passa por nenhum INSERT.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('29292929-0000-0000-0000-000000000001', 'Domari');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('a9292929-0000-0000-0000-000000000001', '29292929-0000-0000-0000-000000000001',
   'Matriz', 'America/Bahia');

-- ----------------------------------------------------------------------------
-- 1 — barbearia nova nasce em teste, sem a aplicação pedir
-- ----------------------------------------------------------------------------
DO $$
DECLARE linha subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO linha FROM subscriptions
   WHERE tenant_id = '29292929-0000-0000-0000-000000000001';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'barbearia nasceu sem assinatura — invisível para a cobrança';
  END IF;
  IF linha.status <> 'trialing' OR linha.trial_ends_at IS NULL THEN
    RAISE EXCEPTION 'nasceu em % sem prazo de teste', linha.status;
  END IF;
  IF linha.plan_code <> 'pro' THEN
    RAISE EXCEPTION 'nasceu no plano %, e o padrão é o pro', linha.plan_code;
  END IF;
  RAISE NOTICE 'OK 1 — barbearia nova nasce em teste no plano padrão, pelo banco';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — existe exatamente um plano padrão
--
-- Zero deixaria toda conta nova sem assinatura; dois fariam a escolha depender
-- da ordem da consulta, que é o tipo de decisão que ninguém tomou.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE plans SET is_default = true WHERE code = 'starter';
    RAISE EXCEPTION 'aceitou dois planos padrão';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 2 — só um plano pode ser o padrão';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — o preço da assinatura é congelado, não uma leitura do catálogo
--
-- Mesma decisão da comissão: reajustar a tabela não muda o que uma barbearia já
-- contratada paga sem alguém decidir isso.
-- ----------------------------------------------------------------------------
UPDATE plans SET price_cents = 19900 WHERE code = 'pro';

DO $$
DECLARE contratado int;
BEGIN
  SELECT price_cents INTO contratado FROM subscriptions
   WHERE tenant_id = '29292929-0000-0000-0000-000000000001';
  IF contratado <> 9900 THEN
    RAISE EXCEPTION 'o reajuste do catálogo mudou o preço contratado para %', contratado;
  END IF;
  RAISE NOTICE 'OK 3 — reajustar o catálogo não muda quem já contratou';
END $$;

UPDATE plans SET price_cents = 9900 WHERE code = 'pro';

-- ----------------------------------------------------------------------------
-- 4 — plano em uso não é apagado
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    DELETE FROM plans WHERE code = 'pro';
    RAISE EXCEPTION 'apagou plano com assinatura dentro';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'OK 4 — plano com assinatura dentro não some';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — o teto de cadeiras: cinco entram, a sexta não
-- ----------------------------------------------------------------------------
INSERT INTO professionals (tenant_id, location_id, name, kind)
SELECT '29292929-0000-0000-0000-000000000001', 'a9292929-0000-0000-0000-000000000001',
       'Barbeiro ' || n, 'professional'
FROM generate_series(1, 5) AS n;

DO $$
BEGIN
  BEGIN
    INSERT INTO professionals (tenant_id, location_id, name, kind)
    VALUES ('29292929-0000-0000-0000-000000000001',
            'a9292929-0000-0000-0000-000000000001', 'Sexto', 'professional');
    RAISE EXCEPTION 'a sexta cadeira entrou num plano de cinco';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 5 — a cadeira que passa do teto do plano é recusada';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — balcão e recurso não são cadeira
--
-- Cobrar por eles seria cobrar pela recepção — e a barbearia de cinco cadeiras
-- não conseguiria cadastrar o próprio balcão.
-- ----------------------------------------------------------------------------
INSERT INTO professionals (tenant_id, location_id, name, kind) VALUES
  ('29292929-0000-0000-0000-000000000001', 'a9292929-0000-0000-0000-000000000001',
   'Recepção', 'counter'),
  ('29292929-0000-0000-0000-000000000001', 'a9292929-0000-0000-0000-000000000001',
   'Cadeira de lavagem', 'resource_only');

DO $$
BEGIN
  RAISE NOTICE 'OK 6 — balcão e recurso entram sem ocupar vaga do plano';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — o desligado libera a vaga, e o religar dele é conferido
--
-- É o caminho que fura um teto escrito só no INSERT: desliga uma, cadastra
-- duas, religa a antiga. Sete cadeiras num plano de cinco sem nunca ter passado
-- por um INSERT que estourasse.
-- ----------------------------------------------------------------------------
UPDATE professionals SET active = false
 WHERE tenant_id = '29292929-0000-0000-0000-000000000001' AND name = 'Barbeiro 1';

INSERT INTO professionals (tenant_id, location_id, name, kind)
VALUES ('29292929-0000-0000-0000-000000000001',
        'a9292929-0000-0000-0000-000000000001', 'Substituto', 'professional');

DO $$
BEGIN
  BEGIN
    UPDATE professionals SET active = true
     WHERE tenant_id = '29292929-0000-0000-0000-000000000001' AND name = 'Barbeiro 1';
    RAISE EXCEPTION 'religou a sexta cadeira sem passar pelo teto';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 7 — religar quem estava desligado também passa pelo teto';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 8 — e mudar de plano muda o teto na hora
-- ----------------------------------------------------------------------------
UPDATE subscriptions SET plan_code = 'business'
 WHERE tenant_id = '29292929-0000-0000-0000-000000000001';

UPDATE professionals SET active = true
 WHERE tenant_id = '29292929-0000-0000-0000-000000000001' AND name = 'Barbeiro 1';

DO $$
DECLARE cadeiras int;
BEGIN
  SELECT count(*) INTO cadeiras FROM professionals
   WHERE tenant_id = '29292929-0000-0000-0000-000000000001'
     AND kind = 'professional' AND active;
  IF cadeiras <> 6 THEN
    RAISE EXCEPTION 'depois do upgrade a barbearia ficou com % cadeiras', cadeiras;
  END IF;
  RAISE NOTICE 'OK 8 — subir de plano libera a cadeira na requisição seguinte';
END $$;

-- ----------------------------------------------------------------------------
-- 9 — plano sem teto declarado não recusa ninguém
-- ----------------------------------------------------------------------------
UPDATE subscriptions SET plan_code = 'enterprise'
 WHERE tenant_id = '29292929-0000-0000-0000-000000000001';

INSERT INTO professionals (tenant_id, location_id, name, kind)
SELECT '29292929-0000-0000-0000-000000000001', 'a9292929-0000-0000-0000-000000000001',
       'Franquia ' || n, 'professional'
FROM generate_series(1, 30) AS n;

DO $$
BEGIN
  RAISE NOTICE 'OK 9 — `max_chairs` nulo é ilimitado, e não zero';
END $$;

-- ----------------------------------------------------------------------------
-- 9b — a contagem de cadeiras que a plataforma lê bate com a realidade
--
-- Ela é derivada e guardada porque `professionals` tem RLS e a plataforma lê
-- sem tenant: um `count(*)` de lá devolveria zero **em silêncio**, e a tela do
-- plano diria "0 de 5 cadeiras" para uma barbearia lotada. Guardar cria a
-- possibilidade de divergir, e é ela que este teste fecha.
-- ----------------------------------------------------------------------------
DO $$
DECLARE guardado int; real_ int;
BEGIN
  SELECT chairs_in_use INTO guardado FROM subscriptions
   WHERE tenant_id = '29292929-0000-0000-0000-000000000001';
  SELECT count(*) INTO real_ FROM professionals
   WHERE tenant_id = '29292929-0000-0000-0000-000000000001'
     AND kind = 'professional' AND active;

  IF guardado <> real_ THEN
    RAISE EXCEPTION 'o espelho diz % cadeiras e existem %', guardado, real_;
  END IF;
  RAISE NOTICE 'OK 9b — a contagem guardada acompanha o cadastro (% cadeiras)', guardado;
END $$;

-- E acompanha o desligamento, que é a metade que um gatilho só de INSERT perde.
UPDATE professionals SET active = false
 WHERE tenant_id = '29292929-0000-0000-0000-000000000001' AND name = 'Franquia 1';

DO $$
DECLARE guardado int; real_ int;
BEGIN
  SELECT chairs_in_use INTO guardado FROM subscriptions
   WHERE tenant_id = '29292929-0000-0000-0000-000000000001';
  SELECT count(*) INTO real_ FROM professionals
   WHERE tenant_id = '29292929-0000-0000-0000-000000000001'
     AND kind = 'professional' AND active;

  IF guardado <> real_ THEN
    RAISE EXCEPTION 'desligar não baixou o espelho: % contra %', guardado, real_;
  END IF;
  RAISE NOTICE 'OK 9c — desligar uma cadeira baixa a contagem';
END $$;

-- ----------------------------------------------------------------------------
-- 10 — a assinatura é da plataforma: a barbearia lê e não escreve
-- ----------------------------------------------------------------------------
SET LOCAL ROLE barbearia_app;
SELECT set_config('app.tenant_id', '29292929-0000-0000-0000-000000000001', true);

/**
 * A recusa aqui é **silenciosa**, e é assim que a RLS funciona no UPDATE.
 *
 * A primeira versão deste teste esperava `insufficient_privilege`. Esse erro
 * aparece quando falta GRANT ou quando um `WITH CHECK` é violado — não quando o
 * `USING` de um UPDATE simplesmente não casa: aí a linha não é vista e o
 * comando altera zero linhas, sem reclamar.
 *
 * Para o produto dá no mesmo (nenhum caminho da aplicação tenta escrever aqui),
 * mas o teste precisa provar o que de fato acontece — e o que importa é que o
 * plano continue o que era, não que um erro específico apareça.
 */
DO $$
DECLARE visivel int; alteradas int; plano text;
BEGIN
  SELECT count(*) INTO visivel FROM subscriptions;
  IF visivel < 1 THEN
    RAISE EXCEPTION 'a barbearia não consegue ver o próprio plano';
  END IF;

  UPDATE subscriptions SET plan_code = 'starter', price_cents = 0
   WHERE tenant_id = '29292929-0000-0000-0000-000000000001';
  GET DIAGNOSTICS alteradas = ROW_COUNT;

  SELECT plan_code INTO plano FROM subscriptions
   WHERE tenant_id = '29292929-0000-0000-0000-000000000001';

  IF alteradas <> 0 OR plano <> 'enterprise' THEN
    RAISE EXCEPTION 'a barbearia trocou o próprio plano para % (% linha[s])', plano, alteradas;
  END IF;
  RAISE NOTICE 'OK 10 — a barbearia lê a assinatura e não escreve nela';
END $$;

-- ----------------------------------------------------------------------------
-- 11 — e não cria uma assinatura para si mesma
--
-- No INSERT a recusa **é** barulhenta: `WITH CHECK` violado levanta erro. É o
-- caminho que criaria uma segunda barbearia num plano escolhido por ela.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO subscriptions (tenant_id, plan_code, price_cents, period_end)
    VALUES ('29292929-0000-0000-0000-000000000009', 'enterprise', 0, now() + interval '1 year');
    RAISE EXCEPTION 'a barbearia criou a própria assinatura';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 11 — a barbearia não cria assinatura';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 12 — tabela temporária não sequestra os gatilhos da assinatura
--
-- `search_path` sem `pg_temp` escrito **não** tira o esquema temporário do
-- caminho: o Postgres o procura primeiro quando ele não é nomeado, e a isenção
-- vale só para função e operador. Como criar tabela temporária é privilégio
-- padrão de qualquer role, a versão anterior destas funções (`SET search_path =
-- public`, nomes soltos) escrevia numa `subscriptions` plantada pela própria
-- barbearia — rodando como dono do banco, no caso da `SECURITY DEFINER`.
--
-- O teste planta as três armadilhas de uma vez e cobra o resultado nas tabelas
-- de verdade.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE subscriptions (tenant_id uuid, chairs_in_use integer, plan_code text);
CREATE TEMP TABLE professionals (id uuid, tenant_id uuid, kind text, active boolean);
CREATE TEMP TABLE plans (code text, max_chairs integer, name text, is_default boolean);

-- A isca: se o gatilho cair na temporária, é aqui que a escrita aparece.
INSERT INTO pg_temp.subscriptions VALUES
  ('29292929-0000-0000-0000-000000000001', -1, 'enterprise');

DO $$
DECLARE antes int; depois int; isca int;
BEGIN
  SELECT chairs_in_use INTO antes FROM public.subscriptions
   WHERE tenant_id = '29292929-0000-0000-0000-000000000001';

  INSERT INTO public.professionals (tenant_id, location_id, name, kind, active)
  VALUES ('29292929-0000-0000-0000-000000000001',
          'a9292929-0000-0000-0000-000000000001', 'Cadeira Sequestrada',
          'professional', true);

  SELECT chairs_in_use INTO depois FROM public.subscriptions
   WHERE tenant_id = '29292929-0000-0000-0000-000000000001';
  SELECT chairs_in_use INTO isca FROM pg_temp.subscriptions;

  IF depois <> antes + 1 THEN
    RAISE EXCEPTION 'o gatilho não achou a subscriptions de verdade: % -> %', antes, depois;
  END IF;
  IF isca <> -1 THEN
    RAISE EXCEPTION 'o gatilho escreveu na temporária da barbearia (isca = %)', isca;
  END IF;

  RAISE NOTICE 'OK 12 — temporária não sequestra o contador de cadeiras';
END $$;

-- ----------------------------------------------------------------------------
-- 12b — nem faz o teto de cadeiras evaporar
--
-- A conferência não é `SECURITY DEFINER`, então sequestrá-la não daria poder de
-- dono — daria coisa mais direta: uma `subscriptions` temporária vazia deixa
-- `teto` nulo, e nulo é "ilimitado". O teto de plano sumiria sem erro nenhum.
-- ----------------------------------------------------------------------------
RESET ROLE;
UPDATE public.subscriptions SET plan_code = 'starter', price_cents = 4900
 WHERE tenant_id = '29292929-0000-0000-0000-000000000001';
SET LOCAL ROLE barbearia_app;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.professionals (tenant_id, location_id, name, kind, active)
    VALUES ('29292929-0000-0000-0000-000000000001',
            'a9292929-0000-0000-0000-000000000001', 'Cadeira Além do Teto',
            'professional', true);
    RAISE EXCEPTION 'o teto do plano evaporou com uma tabela temporária';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 12b — temporária não apaga o teto de cadeiras';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 12c — e a barbearia não chama a função do gatilho na mão
--
-- `EXECUTE` nasce liberado para `PUBLIC`, e uma `SECURITY DEFINER` liberada
-- roda como dono do banco para quem quiser chamá-la. O gatilho continua
-- disparando (as invariantes 9b e 12 provam isso logo acima) porque a permissão
-- de executar é conferida em `CREATE TRIGGER`, não a cada disparo.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    PERFORM public.atualizar_cadeiras_em_uso();
    RAISE EXCEPTION 'a barbearia chamou a função SECURITY DEFINER direto';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK 12c — a função do gatilho não é chamável pela aplicação';
  END;
END $$;

ROLLBACK;
