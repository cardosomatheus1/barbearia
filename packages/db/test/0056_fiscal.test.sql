-- ============================================================================
-- Invariantes do fiscal (bloco 53).
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('56565656-0000-0000-0000-000000000001', 'Domari');

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('56565656-1111-0000-0000-000000000001',
   '56565656-0000-0000-0000-000000000001', 'Matriz', 'America/Bahia');

INSERT INTO orders (id, tenant_id, location_id, status, business_day, closed_at, total_cents)
VALUES ('56565656-2222-0000-0000-000000000001',
        '56565656-0000-0000-0000-000000000001',
        '56565656-1111-0000-0000-000000000001', 'paid', current_date, now(), 9000);

-- ----------------------------------------------------------------------------
-- 1 — o certificado digital não tem onde morar
--
-- O A1 e a senha dele ficam **no emissor**, que tem obrigação regulatória de
-- guardá-los. Coluna que não existe não é preenchida por engano — e o jeito de
-- um segredo desses acabar no banco é alguém achar que "só por enquanto"
-- resolve. Varredura de catálogo, como a do dado bancário no bloco 50.
-- ----------------------------------------------------------------------------
DO $$
DECLARE suspeitas text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO suspeitas
    FROM information_schema.columns
   WHERE table_name = 'fiscal_settings'
     AND (column_name ~ 'certificad|certificate|senha|password|pfx|p12|private_key'
          OR column_name = 'secret');

  IF suspeitas IS NOT NULL THEN
    RAISE EXCEPTION 'a configuração fiscal ganhou coluna de certificado ou senha: %', suspeitas;
  END IF;
  RAISE NOTICE 'OK 1 — só a referência opaca do emissor';
END $$;

-- ----------------------------------------------------------------------------
-- 2 — o CNPJ é só dígitos, e o município é código IBGE
--
-- O emissor recebe assim, e é a chave de comparação. "Salvador" existe em três
-- estados; o código não.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO fiscal_settings
      (location_id, tenant_id, cnpj, regime, service_code, municipality_ibge)
    VALUES ('56565656-1111-0000-0000-000000000001',
            '56565656-0000-0000-0000-000000000001',
            '11.222.333/0001-81', 'simples', '14.01', '2927408');
    RAISE EXCEPTION 'aceitou CNPJ com pontuação';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2a — o CNPJ é só dígitos';
  END;

  BEGIN
    INSERT INTO fiscal_settings
      (location_id, tenant_id, cnpj, regime, service_code, municipality_ibge)
    VALUES ('56565656-1111-0000-0000-000000000001',
            '56565656-0000-0000-0000-000000000001',
            '11222333000181', 'simples', '14.01', 'Salvador');
    RAISE EXCEPTION 'aceitou município por nome';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2b — o município é código IBGE';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 3 — o ISS tem o teto da lei complementar
--
-- 5% é o máximo por LC 116/2003. Um `50` digitado no lugar de `5` passaria e
-- voltaria como rejeição da prefeitura, cujo motivo não diz "você digitou dez
-- vezes a alíquota".
-- ----------------------------------------------------------------------------
INSERT INTO fiscal_settings
  (location_id, tenant_id, cnpj, regime, service_code, iss_bps, municipality_ibge)
VALUES ('56565656-1111-0000-0000-000000000001',
        '56565656-0000-0000-0000-000000000001',
        '11222333000181', 'simples', '14.01', 200, '2927408');

DO $$
BEGIN
  BEGIN
    UPDATE fiscal_settings SET iss_bps = 5000
     WHERE location_id = '56565656-1111-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou ISS acima do teto legal';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 3 — o ISS respeita o teto de 5%%';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 4 — a emissão automática nasce desligada
--
-- Ligada sem o cadastro conferido, ela produziria uma fila de notas rejeitadas
-- na primeira tarde de uso — e cada rejeição queima um número de RPS na
-- prefeitura.
-- ----------------------------------------------------------------------------
DO $$
DECLARE ligada boolean;
BEGIN
  SELECT auto_issue INTO ligada FROM fiscal_settings
   WHERE location_id = '56565656-1111-0000-0000-000000000001';
  IF ligada THEN
    RAISE EXCEPTION 'a emissão automática nasceu ligada';
  END IF;
  RAISE NOTICE 'OK 4 — a emissão automática nasce desligada';
END $$;

-- ----------------------------------------------------------------------------
-- 5 — autorizada tem número e data; rejeitada tem motivo
--
-- "Autorizada" sem número é uma linha que diz que a nota saiu e não diz qual —
-- e é o número que o contador pede.
-- ----------------------------------------------------------------------------
INSERT INTO fiscal_invoices
  (id, tenant_id, location_id, order_id, regime, service_cents, iss_bps,
   service_code, municipality_ibge, created_by_name)
VALUES ('56565656-3333-0000-0000-000000000001',
        '56565656-0000-0000-0000-000000000001',
        '56565656-1111-0000-0000-000000000001',
        '56565656-2222-0000-0000-000000000001', 'simples', 9000, 200,
        '14.01', '2927408', 'Maria Recepção');

DO $$
BEGIN
  BEGIN
    UPDATE fiscal_invoices SET status = 'autorizada'
     WHERE id = '56565656-3333-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou nota autorizada sem número';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 5a — nota autorizada tem número e data';
  END;

  BEGIN
    UPDATE fiscal_invoices SET status = 'rejeitada'
     WHERE id = '56565656-3333-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou nota rejeitada sem motivo';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 5b — nota rejeitada tem motivo';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 6 — a parcela do parceiro só existe no regime que a permite, e cabe na nota
--
-- Fora do Salão-Parceiro ela é zero; dentro, ela nunca passa da base — a parte
-- da casa ficaria negativa e a prefeitura recusa a nota inteira.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE fiscal_invoices SET partner_cents = 4000
     WHERE id = '56565656-3333-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou parcela de parceiro fora do regime';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6a — só o Salão-Parceiro tem parcela de parceiro';
  END;

  BEGIN
    UPDATE fiscal_invoices SET regime = 'salao_parceiro', partner_cents = 9001
     WHERE id = '56565656-3333-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou parcela de parceiro maior que a nota';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 6b — a parcela do parceiro cabe na nota';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 7 — uma nota viva por comanda, e a rejeitada não bloqueia a segunda
--
-- Duas notas autorizadas da mesma venda é imposto pago em dobro. Mas a rejeitada
-- é justamente a que a barbearia corrige e reenvia, e a cancelada é o caminho
-- quando o valor saiu errado — nenhuma das duas pode travar a próxima.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO fiscal_invoices
      (tenant_id, location_id, order_id, regime, service_cents, iss_bps,
       service_code, municipality_ibge, created_by_name)
    VALUES ('56565656-0000-0000-0000-000000000001',
            '56565656-1111-0000-0000-000000000001',
            '56565656-2222-0000-0000-000000000001', 'simples', 9000, 200,
            '14.01', '2927408', 'Maria');
    RAISE EXCEPTION 'aceitou duas notas vivas da mesma comanda';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 7a — uma nota viva por comanda';
  END;

  UPDATE fiscal_invoices
     SET status = 'rejeitada', rejection_reason = 'Código de serviço não habilitado'
   WHERE id = '56565656-3333-0000-0000-000000000001';

  INSERT INTO fiscal_invoices
    (tenant_id, location_id, order_id, regime, service_cents, iss_bps,
     service_code, municipality_ibge, created_by_name)
  VALUES ('56565656-0000-0000-0000-000000000001',
          '56565656-1111-0000-0000-000000000001',
          '56565656-2222-0000-0000-000000000001', 'simples', 9000, 200,
          '14.01', '2927408', 'Maria');
  RAISE NOTICE 'OK 7b — a rejeitada não bloqueia a segunda tentativa';
END $$;

-- ----------------------------------------------------------------------------
-- 8 — a nota autorizada é imutável, menos para cancelar
--
-- O número foi para a prefeitura e o cliente recebeu o PDF. Reescrever valor ou
-- regime deixaria o banco diferente do órgão — e é o banco que a barbearia
-- consulta quando o contador pergunta.
-- ----------------------------------------------------------------------------
DO $$
DECLARE viva uuid;
BEGIN
  SELECT id INTO viva FROM fiscal_invoices WHERE status = 'pendente' LIMIT 1;

  UPDATE fiscal_invoices
     SET status = 'autorizada', number = '2026/431', authorized_at = now()
   WHERE id = viva;

  BEGIN
    UPDATE fiscal_invoices SET service_cents = 100 WHERE id = viva;
    RAISE EXCEPTION 'aceitou mexer no valor de uma nota autorizada';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'OK 8a — o valor de uma nota emitida é congelado';
  END;

  BEGIN
    UPDATE fiscal_invoices SET status = 'pendente', number = NULL, authorized_at = NULL
     WHERE id = viva;
    RAISE EXCEPTION 'aceitou desautorizar uma nota';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'OK 8b — nota autorizada só sai para cancelamento';
  END;

  /**
   * O cancelamento tem **dois passos**, e o do meio é o estado em voo.
   *
   * `cancelando` existe pela lição do bloco 50: a trava cai no commit e a viagem
   * à prefeitura acontece fora da transação. Sem ele, dois toques em "Cancelar"
   * mandam o cancelamento duas vezes, e o segundo bate contra um RPS já
   * cancelado. Achado da revisão deste bloco.
   */
  BEGIN
    UPDATE fiscal_invoices
       SET status = 'cancelada', cancelled_at = now(), cancel_reason = 'Valor errado'
     WHERE id = viva;
    RAISE EXCEPTION 'aceitou cancelar sem passar pelo estado em voo';
  EXCEPTION WHEN raise_exception THEN
    NULL;
  END;

  UPDATE fiscal_invoices SET status = 'cancelando' WHERE id = viva;
  UPDATE fiscal_invoices
     SET status = 'cancelada', cancelled_at = now(), cancel_reason = 'Valor errado'
   WHERE id = viva;

  /**
   * A nota cancelada **guarda** o número e a data da autorização.
   *
   * A primeira versão da restrição era uma equivalência e exigia o contrário:
   * cancelar apagaria o número que foi à prefeitura, que é exatamente o par que
   * o contador procura quando pergunta o que aconteceu com a numeração.
   */
  IF NOT EXISTS (
    SELECT 1 FROM fiscal_invoices
     WHERE id = viva AND number = '2026/431' AND authorized_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a nota cancelada perdeu o número da autorização';
  END IF;

  RAISE NOTICE 'OK 8c — cancelar mantém o número que foi à prefeitura';
END $$;

-- ----------------------------------------------------------------------------
-- 9 — a comanda não se apaga por baixo de uma nota
--
-- A nota é documento fiscal com guarda de cinco anos, e ação referencial roda
-- com os direitos do dono da tabela — sem passar pelo `REVOKE DELETE`.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    DELETE FROM orders WHERE id = '56565656-2222-0000-0000-000000000001';
    RAISE EXCEPTION 'aceitou apagar a comanda que tem nota';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'OK 9 — comanda com nota não se apaga';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- 10 — nenhuma chave destrói nota nem cadastro em cascata
--
-- As **duas** tabelas. A primeira versão varria só `fiscal_invoices`, e por isso
-- não enxergava o `CASCADE` que `fiscal_settings.location_id` tinha — a lista de
-- exceções (e o recorte) de uma varredura é o lugar mais perigoso do teste, e é
-- a segunda vez que isso aparece: o bloco 51 teve o mesmo defeito.
-- ----------------------------------------------------------------------------
DO $$
DECLARE ruins text;
BEGIN
  SELECT string_agg(conname, ', ') INTO ruins
    FROM pg_constraint
   WHERE conrelid IN ('fiscal_invoices'::regclass, 'fiscal_settings'::regclass)
     AND contype = 'f' AND confdeltype = 'c'
     AND conname NOT LIKE '%tenant_id_fkey';

  IF ruins IS NOT NULL THEN
    RAISE EXCEPTION 'o fiscal tem chave com CASCADE: %', ruins;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app')
     AND (has_table_privilege('barbearia_app', 'fiscal_invoices', 'DELETE')
          OR has_table_privilege('barbearia_app', 'fiscal_settings', 'DELETE')) THEN
    RAISE EXCEPTION 'a aplicação pode apagar nota ou cadastro fiscal';
  END IF;
  RAISE NOTICE 'OK 10 — o fiscal não se apaga, nem em cascata';
END $$;

-- ----------------------------------------------------------------------------
-- 11 — a configuração é por unidade
--
-- Inscrição municipal e ISS são da **cidade**: uma rede com loja em Salvador e
-- loja em Lauro de Freitas recolhe em duas prefeituras. No tenant, a segunda
-- loja emitiria com o município da primeira.
-- ----------------------------------------------------------------------------
DO $$
DECLARE chave text;
BEGIN
  SELECT string_agg(a.attname, ', ') INTO chave
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
   WHERE i.indrelid = 'fiscal_settings'::regclass AND i.indisprimary;

  IF chave <> 'location_id' THEN
    RAISE EXCEPTION 'a configuração fiscal não é por unidade: chave é %', chave;
  END IF;
  RAISE NOTICE 'OK 11 — a configuração fiscal é por unidade';
END $$;

-- ----------------------------------------------------------------------------
-- 12 — RLS forçada nas duas tabelas novas
-- ----------------------------------------------------------------------------
DO $$
DECLARE faltando text;
BEGIN
  SELECT string_agg(relname, ', ') INTO faltando
    FROM pg_class
   WHERE relname IN ('fiscal_settings', 'fiscal_invoices')
     AND NOT (relrowsecurity AND relforcerowsecurity);

  IF faltando IS NOT NULL THEN
    RAISE EXCEPTION 'sem RLS forçada: %', faltando;
  END IF;
  RAISE NOTICE 'OK 12 — RLS forçada no fiscal';
END $$;

ROLLBACK;
