-- ============================================================================
-- 0069 — de quem é o cliente novo (bloco 72, SPEC §5.2)
--
-- > *"Comissão de marketplace incide exclusivamente sobre **cliente novo
-- > trazido pela plataforma**. Cliente que a barbearia já tinha na base nunca
-- > gera comissão, mesmo que agende pelo app do marketplace."*
-- >
-- > *"Cobrar sobre base própria é a principal fonte de revolta contra Fresha e
-- > Booksy — e é exatamente a brecha a explorar no discurso de venda."*
--
-- A promessa comercial do produto inteiro está nessas duas frases, e ela é uma
-- promessa **negativa**: o que se vende é o que a plataforma **não** cobra. Uma
-- regra assim não pode morar num relatório — ela precisa estar no schema, onde
-- a cobrança a encontra e onde ninguém a contorna sem aparecer no diff.
-- ============================================================================

/**
 * A comissão é cobrada numa fatura **própria**, e por isso o enum cresce.
 *
 * Somá-la ao valor da mensalidade faria a fatura de assinatura dizer R$ 258,00
 * sobre um plano de R$ 199,00, e a barbearia teria que acreditar na diferença.
 * Documento separado é o que permite a linha a linha: "estes seis clientes,
 * este valor". É a mesma razão de `proration` já ser um tipo em vez de um
 * ajuste no valor da mensalidade.
 *
 * `ALTER TYPE ... ADD VALUE` fora de bloco de transação de propósito: o `psql`
 * do `migrate.sh` roda instrução a instrução, então o novo rótulo já está
 * comitado quando o índice abaixo o cita. Dentro de um `BEGIN` o Postgres
 * recusaria o uso do valor recém-criado.
 */
ALTER TYPE invoice_kind ADD VALUE IF NOT EXISTS 'marketplace';

-- ----------------------------------------------------------------------------
-- Como o cliente chegou
-- ----------------------------------------------------------------------------

/**
 * A origem do cliente, congelada.
 *
 * `appointment_source` já é o vocabulário de canal deste produto desde o bloco
 * 1 (SPEC §2.11) — um enum novo aqui seria a segunda lista para a mesma coisa,
 * e a primeira divergência apareceria no dia em que alguém acrescentasse um
 * canal só de um lado.
 *
 * Nula é "chegou antes de existir esta coluna", e nunca vira marketplace: é a
 * base própria da barbearia, que é exatamente quem a promessa protege.
 */
ALTER TABLE customers
  ADD COLUMN acquired_via appointment_source,
  ADD COLUMN acquired_at  timestamptz;

COMMENT ON COLUMN customers.acquired_via IS
  'Canal que trouxe o cliente (bloco 72, SPEC §5.2). Escrito uma vez e '
  'congelado por gatilho: é a base da comissão de marketplace, e um UPDATE '
  'seria a barbearia decidindo o que paga. Nulo = base anterior ao bloco 72.';

/**
 * Congelada, e o gatilho é a garantia.
 *
 * Sem ele, `UPDATE customers SET acquired_via = 'website'` apaga a comissão que
 * a plataforma tem a receber, por uma rota de edição de cadastro qualquer. É a
 * mesma razão de `commission_entries` fechada ser imutável: o número que decide
 * dinheiro não se reescreve, e desatar para nulo também não.
 */
CREATE OR REPLACE FUNCTION customers_origem_congelada() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.acquired_via IS NOT NULL AND NEW.acquired_via IS DISTINCT FROM OLD.acquired_via THEN
    RAISE EXCEPTION 'A origem do cliente é congelada (%)', OLD.acquired_via
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customers_origem_congelada
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_origem_congelada();

-- ----------------------------------------------------------------------------
-- Quanto a plataforma cobra por um cliente novo
-- ----------------------------------------------------------------------------

/**
 * A alíquota é **termo comercial da plataforma**, e por isso mora aqui.
 *
 * `tenant_platform` é escrita só por `packages/platform` desde o bloco 49,
 * justamente porque uma coluna em `tenants` deixava a rota do painel da
 * barbearia definir o preço que ela paga — zerá-la desligava a receita sem nada
 * falhar. Achado da `/security-review` daquele bloco.
 *
 * Nasce **zero**, e isso é a regra do padrão de configuração que mexe em
 * dinheiro: o comportamento anterior é não cobrar. Ligada por padrão, toda
 * barbearia já instalada acordaria devendo comissão sobre clientes que ela não
 * contratou como sendo do marketplace.
 */
ALTER TABLE tenant_platform
  ADD COLUMN marketplace_fee_bps integer NOT NULL DEFAULT 0
    CHECK (marketplace_fee_bps BETWEEN 0 AND 5000);

COMMENT ON COLUMN tenant_platform.marketplace_fee_bps IS
  'Comissão do marketplace em pontos-base, só sobre cliente novo trazido pela '
  'plataforma (bloco 72, SPEC §5.2). Nasce zero: o padrão é o comportamento '
  'anterior, que é não cobrar.';

-- ----------------------------------------------------------------------------
-- O que a plataforma tem a receber
-- ----------------------------------------------------------------------------

CREATE TYPE marketplace_attribution_status AS ENUM ('pendente', 'faturada', 'cancelada');

CREATE TABLE marketplace_attributions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  /**
   * O cliente, e a **única** vez que ele gera comissão.
   *
   * O índice único é a promessa comercial escrita em SQL: a plataforma cobra
   * pelo cliente novo, não pelo agendamento. Quem voltou dez vezes é receita da
   * barbearia, e cobrar de novo seria cobrar sobre base própria — a frase que a
   * SPEC usa para descrever o concorrente.
   *
   * `RESTRICT` porque isto é registro de dinheiro: a anonimização do bloco 37
   * tira a pessoa de dentro do cadastro e deixa a linha e os centavos, que é
   * exatamente o que se quer aqui.
   */
  customer_id    uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,

  status         marketplace_attribution_status NOT NULL DEFAULT 'pendente',

  /**
   * A base e a alíquota **copiadas**, com o valor derivado delas.
   *
   * Mesma decisão do lançamento de comissão do bloco 19: guardar a regra que
   * valia, não só o resultado. Renegociar a alíquota em maio não pode mudar o
   * que foi cobrado em abril, e sem a base gravada ninguém consegue conferir a
   * conta depois que o agendamento mudou de preço.
   */
  base_cents     integer NOT NULL CHECK (base_cents >= 0),
  fee_bps        integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 5000),
  fee_cents      integer NOT NULL CHECK (fee_cents >= 0),

  /** A fatura que cobrou isto. Nula enquanto pendente. */
  invoice_id     uuid REFERENCES invoices(id) ON DELETE RESTRICT,

  /** Quando o atendimento que gerou a comissão aconteceu. */
  attributed_at  timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT marketplace_attributions_faturada_tem_fatura
    CHECK ((status = 'faturada') = (invoice_id IS NOT NULL))
);

-- Um cliente, uma comissão. É a promessa da SPEC §5.2 imposta pelo banco.
CREATE UNIQUE INDEX marketplace_attributions_uma_por_cliente
  ON marketplace_attributions (tenant_id, customer_id);

-- A varredura de faturamento pergunta "o que está pendente nesta barbearia".
CREATE INDEX marketplace_attributions_pendentes
  ON marketplace_attributions (tenant_id, attributed_at)
  WHERE status = 'pendente';

/**
 * Motivo escrito na contestação, e o banco cobra.
 *
 * Contestar reduz o que a plataforma recebe, e o índice único faz o efeito ser
 * **permanente**: aquele cliente nunca mais gera comissão. Uma renúncia dessa
 * natureza sem motivo escrito é indistinguível de evasão — é a mesma exigência
 * do `void_reason` da fatura e do override do score, que também têm piso na
 * borda, no domínio e por `CHECK`.
 */
ALTER TABLE marketplace_attributions
  ADD COLUMN contested_reason text,
  ADD CONSTRAINT marketplace_attributions_contestacao_com_motivo
    CHECK (status <> 'cancelada' OR length(btrim(coalesce(contested_reason, ''))) >= 10);

ALTER TABLE marketplace_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_attributions FORCE ROW LEVEL SECURITY;

/**
 * Leitura com **ou sem** tenant, como `invoices`.
 *
 * Sem o ramo do `IS NULL`, a plataforma — que lê `semTenant` — enxergava zero
 * linhas: ela não conseguiria auditar uma contestação, listar o que foi
 * renunciado, nem responder à barbearia que discorda. Uma tabela em que só um
 * dos dois lados do contrato enxerga o próprio contrato não é isolamento, é
 * cegueira. Achado da `/security-review` deste bloco.
 *
 * O `NULLIF` no segundo ramo não é enfeite: `OR` não garante curto-circuito em
 * SQL, e sem ele o planejador pode tentar `''::uuid` numa conexão sem tenant.
 */
CREATE POLICY marketplace_attributions_leitura ON marketplace_attributions FOR SELECT USING (
  NULLIF(current_setting('app.tenant_id', true), '') IS NULL
  OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY marketplace_attributions_escrita ON marketplace_attributions FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON marketplace_attributions TO barbearia_app;

/**
 * Sem `DELETE`, como todo registro de dinheiro deste produto.
 *
 * Uma atribuição errada é **cancelada** — estado, com o motivo do lado —, nunca
 * apagada: o que a barbearia contesta precisa continuar existindo para a
 * conversa ter documento.
 */
REVOKE DELETE ON marketplace_attributions FROM barbearia_app;

/**
 * Uma fatura de marketplace por período, como a de assinatura.
 *
 * É ela que torna a emissão idempotente: a régua roda a cada volta do laço, e
 * um `SELECT` antes do `INSERT` tem janela que cobra a barbearia duas vezes
 * pelo mesmo mês — a lição de `club_invoices` no bloco 50.
 */
CREATE UNIQUE INDEX invoices_marketplace_uma_por_periodo
  ON invoices (tenant_id, period_start) WHERE kind = 'marketplace';

COMMENT ON TABLE marketplace_attributions IS
  'Comissão do marketplace por cliente novo (bloco 72, SPEC §5.2). Uma por '
  'cliente, para sempre: a plataforma cobra pelo cliente que trouxe, nunca '
  'pela base própria da barbearia.';
