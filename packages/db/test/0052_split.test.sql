-- ============================================================================
-- Invariantes do split de pagamento (bloco 49).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('52525252-0000-0000-0000-000000000001', 'Domari');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('52525252-1111-0000-0000-000000000001',
   '52525252-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia');

INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
  ('52525252-2222-0000-0000-000000000001',
   '52525252-0000-0000-0000-000000000001',
   '52525252-1111-0000-0000-000000000001', 'Ruan');

INSERT INTO orders (id, tenant_id, location_id, status, business_day, closed_at)
VALUES ('52525252-7777-0000-0000-000000000001',
        '52525252-0000-0000-0000-000000000001',
        '52525252-1111-0000-0000-000000000001', 'paid', current_date, now());

INSERT INTO order_charges
  (id, tenant_id, location_id, order_id, method, amount_cents, status, created_by_name, paid_at, psp_payment_id)
VALUES ('52525252-8888-0000-0000-000000000001',
        '52525252-0000-0000-0000-000000000001',
        '52525252-1111-0000-0000-000000000001',
        '52525252-7777-0000-0000-000000000001', 'pix', 10000, 'pago', 'Matheus', now(), 'pay_teste_52');

-- ----------------------------------------------------------------------------
-- 1 — o split nasce desligado, e a alíquota da plataforma em zero
--
-- *"Arquitetura preparada desde o início, mesmo que ativada só no Release 3."*
-- Ligado por omissão, toda barbearia já instalada veria a próxima venda ser
-- repartida sem ninguém ter decidido nada — e o profissional receberia direto do
-- adquirente uma quantia que a casa achava que ia pagar no fim do mês.
-- ----------------------------------------------------------------------------
DO $$
DECLARE ligado boolean; taxa integer;
BEGIN
  SELECT split_enabled INTO ligado
    FROM tenants WHERE id = '52525252-0000-0000-0000-000000000001';
  SELECT platform_fee_bps INTO taxa
    FROM tenant_platform WHERE tenant_id = '52525252-0000-0000-0000-000000000001';
  IF ligado OR coalesce(taxa, 0) <> 0 THEN
    RAISE EXCEPTION 'barbearia nova nasceu com split ligado (% / %)', ligado, taxa;
  END IF;
  RAISE NOTICE 'OK 1 — o split nasce desligado e sem alíquota';
END $$;

-- ----------------------------------------------------------------------------
-- 1b — a alíquota da plataforma **não** mora em `tenants`
--
-- Achado da `/security-review`: com a coluna ali, a rota do painel da barbearia
-- a escrevia — o cliente definindo o preço que paga, e zerá-la desligava a
-- receita do produto sem nada falhar. Ela é termo comercial da plataforma, e
-- mora onde os outros já moram, numa tabela que a barbearia nem enxerga.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'tenants' AND column_name = 'platform_fee_bps'
  ) THEN
    RAISE EXCEPTION 'a alíquota da plataforma voltou para tenants';
  END IF;
  RAISE NOTICE 'OK 1b — a alíquota da plataforma é da plataforma';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — parte de profissional tem dono; as outras não têm
--
-- Uma parte da plataforma com profissional preenchido apareceria no extrato do
-- barbeiro como dinheiro que ele não recebeu; uma parte de profissional sem dono
-- seria repasse para ninguém.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO payment_splits (tenant_id, order_id, charge_id, party, amount_cents)
    VALUES ('52525252-0000-0000-0000-000000000001',
            '52525252-7777-0000-0000-000000000001',
            '52525252-8888-0000-0000-000000000001', 'profissional', 4000);
    RAISE EXCEPTION 'aceitou parte de profissional sem profissional';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2a — parte de profissional tem dono';
  END;

  BEGIN
    INSERT INTO payment_splits
      (tenant_id, order_id, charge_id, party, professional_id, amount_cents)
    VALUES ('52525252-0000-0000-0000-000000000001',
            '52525252-7777-0000-0000-000000000001',
            '52525252-8888-0000-0000-000000000001', 'plataforma',
            '52525252-2222-0000-0000-000000000001', 500);
    RAISE EXCEPTION 'aceitou parte da plataforma com profissional';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2b — só a parte do profissional tem dono';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — uma parte por cobrança, por papel e por profissional
--
-- O webhook do adquirente reentrega por desenho. Sem este índice a mesma
-- confirmação criaria a segunda cópia de cada parte, o profissional receberia
-- duas vezes, e a soma das partes deixaria de ser o pagamento.
-- ----------------------------------------------------------------------------
INSERT INTO payment_splits
  (tenant_id, order_id, charge_id, party, professional_id, amount_cents, status)
VALUES ('52525252-0000-0000-0000-000000000001',
        '52525252-7777-0000-0000-000000000001',
        '52525252-8888-0000-0000-000000000001', 'profissional',
        '52525252-2222-0000-0000-000000000001', 4000, 'pendente');

DO $$
BEGIN
  BEGIN
    INSERT INTO payment_splits
      (tenant_id, order_id, charge_id, party, professional_id, amount_cents)
    VALUES ('52525252-0000-0000-0000-000000000001',
            '52525252-7777-0000-0000-000000000001',
            '52525252-8888-0000-0000-000000000001', 'profissional',
            '52525252-2222-0000-0000-000000000001', 4000);
    RAISE EXCEPTION 'aceitou a mesma parte duas vezes';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 3 — uma parte por cobrança, papel e profissional';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — parte liquidada tem data, e o contrário também
--
-- "Repassado" sem data é uma linha que responde "sim" para "o Ruan recebeu?" e
-- nada para "quando?" — que é a pergunta que chega quando ele não achou no
-- extrato do banco.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE payment_splits SET status = 'liquidado'
     WHERE charge_id = '52525252-8888-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou repasse liquidado sem data';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 4 — repasse liquidado tem data';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 5 — o repasse não é apagável
--
-- A linha é registro de dinheiro que saiu para conta de terceiro. Desfazer é
-- estado (`estornado`), com valor e data intactos — nunca `DELETE`.
-- ----------------------------------------------------------------------------
DO $$
DECLARE pode boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    SELECT has_table_privilege('barbearia_app', 'payment_splits', 'DELETE') INTO pode;
    IF pode THEN
      RAISE EXCEPTION 'a aplicação pode apagar repasse';
    END IF;
    RAISE NOTICE 'OK 5 — o repasse é append-only para a aplicação';
  ELSE
    RAISE NOTICE 'PULADO 5 — sem o role da aplicação neste banco';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — não existe tabela de percentual de split
--
-- *"Split é derivado da comissão, nunca configurado em paralelo — duas fontes de
-- verdade para o mesmo número é bug garantido."* O dia em que alguém achar que
-- "seria prático guardar a porcentagem do barbeiro aqui também", este teste
-- reprova. É a mesma forma da varredura que recusa coluna de cartão.
-- ----------------------------------------------------------------------------
DO $$
DECLARE suspeitas text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO suspeitas
    FROM information_schema.columns
   WHERE table_name = 'payment_splits'
     AND (column_name LIKE '%percent%' OR column_name LIKE '%_bps'
          OR column_name LIKE '%rate%' OR column_name LIKE '%aliquota%');

  IF suspeitas IS NOT NULL THEN
    RAISE EXCEPTION 'o split ganhou alíquota própria: %', suspeitas;
  END IF;
  RAISE NOTICE 'OK 6 — o split não tem alíquota própria; ele deriva da comissão';
END $$;

-- ----------------------------------------------------------------------------
-- 7 — a alíquota da plataforma tem teto
--
-- 3000 pontos-base é 30%, e acima disso é erro de digitação: a segunda receita
-- da SPEC §9.1 é um percentual sobre a transação, não a transação.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE tenant_platform SET platform_fee_bps = 5000
     WHERE tenant_id = '52525252-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou alíquota de plataforma acima do teto';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 7 — a alíquota da plataforma tem teto';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 8 — RLS forçada
-- ----------------------------------------------------------------------------
DO $$
DECLARE forcada boolean;
BEGIN
  SELECT relrowsecurity AND relforcerowsecurity INTO forcada
    FROM pg_class WHERE relname = 'payment_splits';
  IF NOT coalesce(forcada, false) THEN
    RAISE EXCEPTION 'payment_splits sem RLS forçada';
  END IF;
  RAISE NOTICE 'OK 8 — payment_splits com RLS forçada';
END $$;

-- ----------------------------------------------------------------------------
-- 9 — apagar a venda não apaga o repasse
--
-- `payment_splits` tem `REVOKE DELETE`, e ação referencial roda com os direitos
-- do **dono da tabela**: ela não passa pela revogação. Um `CASCADE` aqui seria a
-- porta lateral que o bloco 43 já achou em `reviews` — apagar a venda levaria
-- junto o registro do dinheiro que saiu para a conta de um terceiro, sem trilha
-- e sem erro. Achado da `/security-review` deste bloco.
--
-- A varredura é de catálogo, e não uma lista escrita: a chave estrangeira nova
-- que alguém adicionar amanhã nasce coberta.
-- ----------------------------------------------------------------------------
DO $$
DECLARE ruins text;
BEGIN
  SELECT string_agg(conname, ', ') INTO ruins
    FROM pg_constraint
   WHERE conrelid = 'payment_splits'::regclass
     AND contype = 'f'
     AND confdeltype = 'c'
     /*
       `tenant_id` é a exceção, e é a mesma de toda tabela de negócio deste
       schema: apagar a barbearia apaga o que é dela, e não existe "repasse órfão
       de barbearia inexistente". O que a varredura procura é o caminho lateral —
       apagar a **venda** e levar o dinheiro junto.
     */
     AND conname <> 'payment_splits_tenant_id_fkey';

  IF ruins IS NOT NULL THEN
    RAISE EXCEPTION 'o repasse tem chave estrangeira com CASCADE: %', ruins;
  END IF;
  RAISE NOTICE 'OK 9 — nenhuma chave do repasse destrói a linha em cascata';
END $$;

ROLLBACK;
