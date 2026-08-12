-- ============================================================================
-- 0055 — Vale, estorno de venda e transferência de pacote (bloco 52, SPEC §3.10)
--
-- O DRE não tem schema: ele é **derivado** do que já existe — venda, comissão,
-- movimento de estoque, taxa do adquirente e conta paga do bloco 51. Uma tabela
-- de resultado seria um número que alguém sobrescreve, e a pergunta que chega
-- é sempre "por que caiu?". Mesma decisão do saldo de estoque e do saldo de
-- fidelidade.
--
-- O que este arquivo entrega são as três coisas que **faltavam ser fato**:
--
--  1. o vale, que é dinheiro adiantado ao profissional e descontado da comissão;
--  2. o estado `refunded` da venda, sem o qual "esta venda foi desfeita" não
--     tem onde ser escrito;
--  3. a transferência de pacote, que move as unidades restantes sem tocar na
--     receita já reconhecida.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Vale / adiantamento (SPEC §3.10)
--
-- *"Adiantamento ao profissional, descontado da comissão do período. Também
-- presente no incumbente e usado de verdade."*
--
-- Ele é um **empréstimo**, não uma despesa: o dinheiro sai da gaveta hoje e
-- volta como desconto no fechamento. Por isso não entra no DRE como custo — o
-- custo é a comissão inteira, e o vale só muda quando ela é paga. Tratá-lo como
-- despesa contaria o mesmo dinheiro duas vezes.
-- ---------------------------------------------------------------------------

CREATE TYPE advance_status AS ENUM ('aberto', 'descontado', 'cancelado');

CREATE TABLE professional_advances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE RESTRICT,

  amount_cents    integer NOT NULL,
  /**
   * O dia **da unidade**, não o instante.
   *
   * É ele que decide de qual fechamento o vale é descontado, e é a mesma
   * decisão de `orders.business_day`: `created_at` responde "que instante", não
   * "de que período é este adiantamento".
   */
  granted_on      date NOT NULL,
  reason          text,

  status          advance_status NOT NULL DEFAULT 'aberto',
  /**
   * O fechamento que o consumiu. `RESTRICT` porque o vale descontado é parte da
   * folha paga: apagar o fechamento por baixo dele deixaria um adiantamento
   * "descontado" de nada.
   */
  closure_id      uuid REFERENCES commission_closures(id) ON DELETE RESTRICT,

  /** Cancelar exige motivo: é dinheiro que saiu e voltou sem passar pela folha. */
  cancel_reason   text,

  /**
   * O movimento de caixa, quando o vale saiu da gaveta.
   *
   * Mesma conciliação do bloco 51: as duas linhas apontam uma para a outra em
   * vez de dois números que alguém compara na tela. Um vale pago por
   * transferência bancária não tem movimento, e isso é normal.
   */
  cash_movement_id uuid REFERENCES cash_movements(id) ON DELETE SET NULL,

  /**
   * Dois vales iguais no mesmo dia são caso legítimo — R$ 100 de manhã e R$ 100
   * à tarde acontecem —, e por isso o toque duplo precisa de chave: não há
   * estado que distinga o segundo da repetição do primeiro.
   */
  idempotency_key text,

  created_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_by_name text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT professional_advances_valor_positivo CHECK (amount_cents > 0),
  -- Descontado é sempre por um fechamento; aberto e cancelado, nunca.
  CONSTRAINT professional_advances_desconto_coerente CHECK (
    (status = 'descontado') = (closure_id IS NOT NULL)
  ),
  CONSTRAINT professional_advances_cancelamento_com_motivo CHECK (
    (status = 'cancelado') = (cancel_reason IS NOT NULL)
      AND (cancel_reason IS NULL OR length(btrim(cancel_reason)) >= 3)
  )
);

ALTER TABLE professional_advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_advances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON professional_advances
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * "Quanto o Ruan já pegou este mês?" — a pergunta do fechamento.
 *
 * Índice parcial no que está aberto: vale descontado é histórico, e depois de
 * dois anos ele é a esmagadora maioria das linhas.
 */
CREATE INDEX professional_advances_abertos_idx
  ON professional_advances (professional_id, granted_on)
  WHERE status = 'aberto';

CREATE UNIQUE INDEX professional_advances_idempotencia
  ON professional_advances (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX professional_advances_por_fechamento_idx
  ON professional_advances (closure_id)
  WHERE closure_id IS NOT NULL;

/**
 * Vale descontado é imutável.
 *
 * Ele virou linha da folha que já foi paga — mexer nele mudaria o valor de um
 * período fechado, que é o que a SPEC §3.4 proíbe em letras. É o mesmo gatilho
 * da comissão fechada, pela mesma razão.
 */
CREATE OR REPLACE FUNCTION professional_advances_congelado() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'descontado' THEN
    RAISE EXCEPTION 'vale já descontado num fechamento não muda';
  END IF;
  IF OLD.status = 'cancelado' AND NEW.status <> 'cancelado' THEN
    RAISE EXCEPTION 'vale cancelado não volta';
  END IF;
  IF OLD.professional_id <> NEW.professional_id OR OLD.amount_cents <> NEW.amount_cents THEN
    RAISE EXCEPTION 'de quem é o vale e quanto ele vale são congelados';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER professional_advances_congelado_trg
  BEFORE UPDATE ON professional_advances
  FOR EACH ROW EXECUTE FUNCTION professional_advances_congelado();

/**
 * O que o profissional **recebe** no acerto, depois do vale.
 *
 * Congelado na linha do fechamento, e não derivado na leitura: o vale
 * descontado em agosto não pode mudar porque alguém lançou outro em setembro.
 * É a mesma razão de `base_cents` e `amount_cents` já serem congelados ali.
 *
 * `advance_cents` é positivo e **abate**: guardar o desconto com sinal negativo
 * faria "quanto de vale ele pegou" precisar de um `abs()` em toda leitura, e a
 * primeira que esquecesse mostraria o número ao contrário na tela do barbeiro.
 */
ALTER TABLE commission_closure_lines
  ADD COLUMN advance_cents integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT commission_closure_lines_vale_nao_negativo CHECK (advance_cents >= 0);

-- ---------------------------------------------------------------------------
-- A venda desfeita
--
-- As duas consequências já existiam e estavam testadas desde os blocos 19 e 50
-- — comissão negativa no período aberto e repasse desfeito. O que faltava era o
-- **fato**: nenhuma coluna dizia "esta venda foi desfeita", e por isso ela
-- continuava somando no faturamento do dia, no DRE e no ticket médio.
--
-- `refunded` e não `cancelled`: a comanda cancelada é a que nunca foi cobrada;
-- a estornada foi cobrada, o dinheiro entrou e voltou. Confundi-las apagaria a
-- diferença entre "desistiu antes de pagar" e "pagou e foi devolvido", que é
-- exatamente o que o dono quer separar quando abre o relatório.
-- ---------------------------------------------------------------------------

ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'refunded' AFTER 'paid';

ALTER TABLE orders
  ADD COLUMN refunded_at      timestamptz,
  ADD COLUMN refunded_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN refunded_by_name text,
  /** Sem motivo escrito, "por que devolveram os R$ 90 do sábado?" não tem resposta. */
  ADD COLUMN refund_reason    text;

ALTER TABLE orders ADD CONSTRAINT orders_estorno_coerente CHECK (
  (status = 'refunded') = (refunded_at IS NOT NULL)
);

ALTER TABLE orders ADD CONSTRAINT orders_estorno_com_motivo CHECK (
  refunded_at IS NULL OR length(btrim(coalesce(refund_reason, ''))) >= 3
);

/**
 * O relatório lê o que **valeu**, e por isso o índice é parcial em `paid`.
 *
 * A venda estornada continua na tabela e continua encontrável pelo id — ela é
 * prova de que o dinheiro entrou e voltou —, mas some de toda soma de
 * faturamento, que é o ponto inteiro do estado novo.
 */
CREATE INDEX orders_pagas_do_dia_idx ON orders (location_id, business_day)
  WHERE status = 'paid';

-- ---------------------------------------------------------------------------
-- Transferência de pacote (SPEC §4.7)
--
-- O que se move são as **unidades restantes**, e só elas. A receita já
-- reconhecida em `package_uses` fica com o primeiro dono, com a data em que foi
-- reconhecida: ela é fato consumado, e reatribuí-la reescreveria o resultado de
-- um mês que já fechou.
--
-- Quem transfere é o balcão, com permissão própria e motivo escrito. A prova de
-- que a outra pessoa concorda é o registro de quem autorizou — exigir aceite
-- digital de quem está na cadeira ao lado seria desenhar para um caso que não
-- acontece: pacote transferível é presente de pai para filho e de marido para
-- mulher, combinado ali na hora.
-- ---------------------------------------------------------------------------

CREATE TABLE package_transfers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_package_id uuid NOT NULL REFERENCES customer_packages(id) ON DELETE RESTRICT,

  from_customer_id    uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  to_customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  /** Quantas sobravam quando ela aconteceu. É o que a trilha precisa dizer. */
  units_moved         smallint NOT NULL,
  reason              text NOT NULL,

  created_by          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_by_name     text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT package_transfers_pessoas_diferentes CHECK (from_customer_id <> to_customer_id),
  CONSTRAINT package_transfers_unidades_positivas CHECK (units_moved > 0),
  CONSTRAINT package_transfers_motivo_escrito CHECK (length(btrim(reason)) >= 3)
);

ALTER TABLE package_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON package_transfers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX package_transfers_por_pacote_idx
  ON package_transfers (customer_package_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Grants
--
-- `REVOKE DELETE` em tudo, pela razão de sempre. O vale aceita `UPDATE` porque
-- descontar e cancelar são **estado**; a transferência não aceita nem isso, que
-- é o mesmo tratamento da transferência entre contas do bloco 51.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON professional_advances TO barbearia_app;
    GRANT SELECT, INSERT ON package_transfers TO barbearia_app;
    REVOKE DELETE ON professional_advances FROM barbearia_app;
    REVOKE UPDATE, DELETE ON package_transfers FROM barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- As permissões novas no catálogo do banco
-- ---------------------------------------------------------------------------

ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_conhecida;

ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_conhecida CHECK (permission IN (
  'appointments.view', 'appointments.create', 'appointments.cancel',
  'appointments.reschedule', 'appointments.view_all_professionals',
  'appointments.attend',
  'cashier.open', 'cashier.close', 'cashier.withdraw',
  'finance.view', 'finance.view_profit', 'finance.export', 'finance.discount',
  'finance.deposit', 'finance.loyalty_adjust', 'finance.package_refund',
  'finance.subscription_manage', 'finance.split_manage',
  'finance.bills_manage', 'finance.credit_limit',
  'finance.advance', 'finance.order_refund', 'finance.package_transfer',
  'commission.view_own', 'commission.view_all', 'commission.edit_rules',
  'customers.view', 'customers.edit', 'customers.export',
  'customers.view_photos', 'customers.view_notes', 'customers.edit_notes',
  'customers.anonymize', 'customers.reliability_override',
  'feedback.view', 'feedback.manage',
  'reviews.view', 'reviews.recover',
  'reports.finance', 'reports.operational',
  'inventory.view', 'inventory.adjust',
  'marketing.send', 'settings.manage', 'team.manage'
));
