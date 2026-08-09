-- ============================================================================
-- 0031 — O adquirente: meio de pagamento, webhook, conciliação e estorno
--        (bloco 29, SPEC §9.1)
--
-- O bloco 28 deixou a régua inteira operando sobre uma abstração
-- (`CobrancaProvider`) cuja única implementação em produção nunca aprovava
-- nada: quem quitava fatura era gente registrando o que viu no extrato. Este
-- bloco liga o outro lado.
--
-- ## Três decisões que o schema tem que impor, não pedir
--
-- 1. **Nada de número de cartão.** O que entra aqui é identificador do
--    provedor e os quatro últimos dígitos — o suficiente para o dono
--    reconhecer o cartão dele na tela e nada além. Há `CHECK` no formato de
--    `last4`, e não existe coluna para PAN, CVV ou validade completa: coluna
--    que não existe não é preenchida por engano.
--
-- 2. **Entrega duplicada não cobra duas vezes.** O adquirente reentrega
--    webhook por desenho — é assim que ele garante entrega ao menos uma vez.
--    Quem carrega essa garantia no caminho normal é a máquina de estados da
--    fatura (`pagarFatura` só age sobre `open`; a recusa limpa a amarração);
--    `psp_events` é a trilha do que ele disse e a trava para a entrega
--    **concorrente**, em que as duas passariam pela consulta antes de qualquer
--    uma escrever. A trava é a chave primária, e não um `SELECT` antes do
--    `INSERT`, que tem janela de corrida.
--
-- 3. **O webhook é a fonte da verdade; o polling é a rede.** As duas escrevem
--    o mesmo estado pelo mesmo caminho, e por isso a segunda não pode
--    "corrigir" o que a primeira já fez. Quem garante é a mesma chave: a
--    conciliação registra um evento sintético com id derivado da cobrança e do
--    estado, e o `ON CONFLICT DO NOTHING` faz o resto.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- O meio de pagamento da barbearia
-- ---------------------------------------------------------------------------

CREATE TABLE billing_customers (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,

  /** O identificador do cliente no adquirente. Opaco para nós. */
  psp_customer_id text NOT NULL,
  /** O do meio de pagamento salvo. Nulo enquanto ninguém cadastrou cartão. */
  psp_method_id   text,

  /**
   * O que a tela mostra, e só isso.
   *
   * `brand` e `last4` existem para o dono reconhecer qual cartão está na conta
   * — "Visa •••• 4242". Guardar mais do que isso não melhora nenhuma tela e
   * transforma esta tabela em alvo. O mês e o ano de validade entram porque a
   * régua precisa avisar antes de o cartão vencer, e um cartão vencido produz
   * exatamente a inadimplência que o bloco 28 existe para tratar.
   */
  brand           text,
  last4           text,
  exp_month       smallint,
  exp_year        smallint,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Quatro dígitos. Um número inteiro aqui aceitaria dezesseis e o erro só
  -- apareceria num dump.
  CONSTRAINT billing_customers_last4_formato CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
  CONSTRAINT billing_customers_mes_valido CHECK (
    exp_month IS NULL OR (exp_month BETWEEN 1 AND 12)
  ),
  CONSTRAINT billing_customers_ano_valido CHECK (
    exp_year IS NULL OR (exp_year BETWEEN 2024 AND 2100)
  ),
  /** Marca e final andam juntos: um sem o outro é meia informação na tela. */
  CONSTRAINT billing_customers_cartao_completo CHECK (
    (psp_method_id IS NULL) = (last4 IS NULL)
  )
);

ALTER TABLE billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_customers FORCE ROW LEVEL SECURITY;

/**
 * Mesma forma de `invoices`: a barbearia lê o próprio, a plataforma lê todos,
 * e só a plataforma escreve.
 *
 * Ler o próprio é necessário — a tela do plano diz qual cartão está na conta. E
 * o `NULLIF` no segundo ramo é o mesmo cuidado do bloco 28: `OR` não garante
 * curto-circuito, e sem ele `''::uuid` levanta `22P02` conforme o plano.
 */
CREATE POLICY billing_customers_leitura ON billing_customers FOR SELECT USING (
  NULLIF(current_setting('app.tenant_id', true), '') IS NULL
  OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY billing_customers_escrita ON billing_customers FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

-- ---------------------------------------------------------------------------
-- O evento do adquirente
-- ---------------------------------------------------------------------------

/**
 * O que o adquirente disse, e quando.
 *
 * `event_id` é **do provedor** e é a chave primária — a trava para duas
 * entregas concorrentes do mesmo evento, que é o caso que a máquina de estados
 * da fatura não cobre sozinha.
 *
 * É também a trilha que se abre quando um valor não bate: "o webhook do dia 12
 * dizia o quê?" não tem outra resposta.
 *
 * `payload` guarda o evento como chegou, para conferência quando um número não
 * bater. Ele não tem dado de pessoa: o que vem de um evento de cobrança é id,
 * valor, estado e os quatro últimos dígitos.
 */
CREATE TABLE psp_events (
  event_id     text PRIMARY KEY,
  type         text NOT NULL,
  /** A que barbearia e fatura o evento se refere, quando dá para saber. */
  tenant_id    uuid REFERENCES tenants(id) ON DELETE SET NULL,
  invoice_id   uuid REFERENCES invoices(id) ON DELETE SET NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,

  received_at  timestamptz NOT NULL DEFAULT now(),
  /** Nulo é "chegou e ainda não foi aplicado" — a conciliação olha para cá. */
  processed_at timestamptz,
  /** O que o evento produziu, em uma palavra: `paid`, `failed`, `ignored`. */
  outcome      text
);

ALTER TABLE psp_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE psp_events FORCE ROW LEVEL SECURITY;

/**
 * Infraestrutura de cobrança: nenhuma barbearia lê nem escreve.
 *
 * Mais fechada que `invoices` de propósito. O extrato é da barbearia; o evento
 * bruto do adquirente é nosso, e expô-lo entregaria identificadores do
 * provedor que não servem para nada do lado dela.
 */
CREATE POLICY psp_events_plataforma ON psp_events FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

/** "O que chegou e ainda não foi aplicado?" — a pergunta da rede de segurança. */
CREATE INDEX psp_events_pendentes ON psp_events (received_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- A cobrança na fatura
-- ---------------------------------------------------------------------------

/**
 * O identificador da cobrança no adquirente.
 *
 * É por ele que a conciliação pergunta "e essa, foi?" e é por ele que o evento
 * do webhook encontra a fatura. Único: duas faturas apontando para a mesma
 * cobrança fariam um pagamento quitar as duas.
 */
ALTER TABLE invoices ADD COLUMN psp_charge_id text;
CREATE UNIQUE INDEX invoices_psp_charge ON invoices (psp_charge_id)
  WHERE psp_charge_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- O estorno
-- ---------------------------------------------------------------------------

/**
 * A devolução em dinheiro do crédito que a descida de plano gerou.
 *
 * O bloco 28 guardou esse crédito em `subscriptions.credit_cents` e o abateu da
 * próxima mensalidade, porque devolver exige adquirente. Agora existe — e o
 * estorno vira **lançamento**, não uma subtração no saldo: quem já viu um
 * sistema em que "o saldo baixou e ninguém sabe por quê" sabe por quê.
 *
 * É o mesmo desenho da comissão fechada do bloco 19: o histórico é a lista de
 * lançamentos, e o saldo é derivado dela.
 */
CREATE TABLE refunds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  reason        text NOT NULL,
  /** Quem mandou devolver. Nulo seria a régua, e a régua não estorna. */
  admin_id      uuid REFERENCES platform_admins(id) ON DELETE SET NULL,

  psp_refund_id text,
  /** `pending` foi pedido ao adquirente; `done` ele confirmou; `failed` recusou. */
  status        text NOT NULL DEFAULT 'pending',
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,

  CONSTRAINT refunds_motivo_escrito CHECK (length(btrim(reason)) >= 3),
  CONSTRAINT refunds_status_conhecido CHECK (status IN ('pending', 'done', 'failed')),
  CONSTRAINT refunds_confirmado_tem_data CHECK ((status = 'done') = (settled_at IS NOT NULL))
);

ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds FORCE ROW LEVEL SECURITY;

-- A barbearia lê o próprio estorno — ela precisa saber que o dinheiro voltou.
CREATE POLICY refunds_leitura ON refunds FOR SELECT USING (
  NULLIF(current_setting('app.tenant_id', true), '') IS NULL
  OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY refunds_escrita ON refunds FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

CREATE INDEX refunds_por_barbearia ON refunds (tenant_id, created_at DESC);

/**
 * O estorno é imutável no que importa, e escrevível só no que falta.
 *
 * "Append-only" puro não serve aqui, e a diferença é real: o lançamento nasce
 * `pending` porque o pedido ao adquirente sai **depois** do commit — segurar
 * uma transação esperando rede é o jeito clássico de esgotar o pool. Alguém
 * precisa gravar o desfecho depois.
 *
 * A saída é `GRANT` por coluna, que o Postgres suporta e quase ninguém usa:
 * valor, motivo, barbearia e autor ficam intocáveis pela aplicação, e só as
 * três colunas do desfecho aceitam escrita. Um `UPDATE ... SET amount_cents`
 * é recusado pelo banco, não por revisão de código.
 *
 * `DELETE` continua fora para todo mundo: trilha de dinheiro que some não é
 * trilha, e é a mesma regra de `audit_log`, `platform_audit` e da comissão
 * fechada do bloco 19.
 */
REVOKE UPDATE, DELETE ON refunds FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON billing_customers, psp_events TO barbearia_app;
    GRANT SELECT, INSERT ON refunds TO barbearia_app;
    REVOKE UPDATE, DELETE ON refunds FROM barbearia_app;
    GRANT UPDATE (psp_refund_id, status, settled_at) ON refunds TO barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- A quebra por meio de pagamento
-- ---------------------------------------------------------------------------

/**
 * "Quanto entrou por Pix?" — a pergunta da SPEC §8 que o agregado não sabia
 * responder.
 *
 * `revenue_cents` do bloco 25 é o total da comanda paga; a quebra por meio vive
 * em `order_payments`, e somá-la na tela obrigaria a plataforma a ler tabela de
 * negócio com RLS — o que devolve zero linhas, como o bloco 20 descobriu. A
 * saída é a mesma de sempre: a **própria barbearia** apura e escreve, por
 * dentro do próprio tenant.
 *
 * Quatro colunas e não uma tabela filha: os meios são um enum de sete valores
 * que muda uma vez por década, e as três perguntas reais são "quanto em Pix",
 * "quanto em cartão" e "quanto em dinheiro". `outros` recolhe link, transferência
 * e fiado — que não é receita recebida e por isso nunca entra nas três primeiras.
 */
ALTER TABLE tenant_metrics_daily
  ADD COLUMN revenue_pix_cents   bigint NOT NULL DEFAULT 0 CHECK (revenue_pix_cents >= 0),
  ADD COLUMN revenue_card_cents  bigint NOT NULL DEFAULT 0 CHECK (revenue_card_cents >= 0),
  ADD COLUMN revenue_cash_cents  bigint NOT NULL DEFAULT 0 CHECK (revenue_cash_cents >= 0),
  ADD COLUMN revenue_other_cents bigint NOT NULL DEFAULT 0 CHECK (revenue_other_cents >= 0);
