-- ============================================================================
-- 0018 — Comanda, caixa, fiado e segundo fator
--
-- A fronteira entre agenda e dinheiro. Até aqui o produto sabia quem vem e
-- quando; a partir daqui sabe quanto entrou, quanto ficou na gaveta e quem
-- ficou devendo.
--
-- Cinco decisões que merecem explicação:
--
-- 1. **Preço e executor ficam no item, não na comanda.** A SPEC §3.1 é
--    explícita: a comissão é por item. Corte com um barbeiro e barba com outro
--    é caso real, e guardar só o dono da comanda tornaria o fechamento do mês
--    uma discussão sem fonte.
--
-- 2. **O preço é copiado, não referenciado.** `order_items.unit_price_cents` é
--    o valor praticado naquele dia. Ler o preço do catálogo no relatório
--    reescreveria o passado toda vez que a barbearia reajustasse a tabela.
--
-- 3. **Fiado é forma de pagamento, não estado da comanda.** A comanda fecha; o
--    que fica em aberto é a **conta do cliente**. Modelar como comanda aberta
--    faria o faturamento do dia esperar o cliente voltar.
--
-- 4. **O caixa é por sessão, não por dia.** Duas pessoas no mesmo dia são duas
--    gavetas, cada uma com seu operador e sua divergência — que é justamente o
--    que a SPEC §3.10 quer poder atribuir.
--
-- 5. **Segredo de segundo fator entra cifrado.** A coluna guarda o texto do
--    AES-256-GCM; a chave vive no ambiente. Em claro, um dump entregaria o
--    segundo fator junto com o primeiro.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Segundo fator
-- ---------------------------------------------------------------------------

ALTER TABLE staff_users
  -- Texto do AES-256-GCM (nonce.tag.dados), nunca o segredo em claro.
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_confirmed_at timestamptz,
  -- Último passo TOTP consumido. Sem isto o mesmo código vale duas vezes na
  -- janela de trinta segundos, que é tempo de sobra para quem espiou o visor.
  ADD COLUMN totp_last_step bigint,
  -- Hashes scrypt dos códigos de recuperação; o usado é removido do array.
  ADD COLUMN recovery_codes text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN staff_users.totp_secret IS 'Segredo TOTP cifrado (AES-256-GCM).';

/**
 * Quando **esta sessão** provou o segundo fator.
 *
 * Fica na sessão e não no usuário de propósito. Segundo fator conferido só no
 * login protegeria o momento de entrar e nada depois: o notebook do balcão fica
 * aberto o dia inteiro, e é exatamente ali que alguém encosta para dar uma
 * sangria. Aqui a exigência é por sessão e com validade curta, então mexer em
 * dinheiro pede o código de novo mesmo com a sessão viva.
 */
ALTER TABLE staff_sessions ADD COLUMN mfa_verified_at timestamptz;

-- ---------------------------------------------------------------------------
-- Conta do cliente: fiado e crédito
-- ---------------------------------------------------------------------------

ALTER TABLE customers
  -- Negativo é dívida, positivo é crédito. Um número com sinal, não duas
  -- colunas: duas permitiriam a mesma pessoa dever e ter crédito ao mesmo
  -- tempo, e a conversa no balcão é sempre "quanto o senhor deve".
  ADD COLUMN balance_cents integer NOT NULL DEFAULT 0,
  -- Quanto esta pessoa pode dever. Zero é o padrão: **não fia**. Fiar é decisão
  -- de confiança, por cliente, e o padrão seguro é não.
  ADD COLUMN credit_limit_cents integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT customers_credit_limit_non_negative CHECK (credit_limit_cents >= 0);

-- ---------------------------------------------------------------------------
-- Caixa
-- ---------------------------------------------------------------------------

CREATE TYPE cash_session_status AS ENUM ('open', 'closed');

CREATE TABLE cash_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,

  status            cash_session_status NOT NULL DEFAULT 'open',
  opened_by         uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  opened_by_name    text NOT NULL,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  opening_cents     integer NOT NULL,

  closed_by         uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  closed_by_name    text,
  closed_at         timestamptz,
  -- O que o operador contou, e o que o sistema esperava. A divergência é
  -- gravada **inclusive quando é zero**: guardar só a diferente tornaria
  -- impossível distinguir "conferiu e bateu" de "ninguém conferiu".
  counted_cents     integer,
  expected_cents    integer,
  difference_cents  integer,
  notes             text,

  CONSTRAINT cash_sessions_opening_non_negative CHECK (opening_cents >= 0),
  CONSTRAINT cash_sessions_closed_completo CHECK (
    status <> 'closed' OR (
      closed_at IS NOT NULL AND counted_cents IS NOT NULL
      AND expected_cents IS NOT NULL AND difference_cents IS NOT NULL
    )
  )
);

ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cash_sessions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Um caixa aberto por unidade. Dois abertos ao mesmo tempo tornariam
-- indefinido em qual gaveta a venda entra — e a divergência deixaria de ter
-- dono, que é justamente o que o controle existe para dar.
CREATE UNIQUE INDEX cash_sessions_um_aberto_por_unidade
  ON cash_sessions (location_id) WHERE status = 'open';

CREATE INDEX cash_sessions_historico_idx ON cash_sessions (location_id, opened_at DESC);

CREATE TYPE cash_movement_type AS ENUM (
  'opening', 'sale', 'withdrawal', 'supply', 'adjustment', 'debt_payment'
);

CREATE TABLE cash_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id    uuid NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
  kind          cash_movement_type NOT NULL,
  -- Positivo entra, negativo sai. Sangria é negativa; suprimento é positivo.
  amount_cents  integer NOT NULL,
  reason        text,
  order_id      uuid,
  created_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_by_name text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cash_movements_sinal_coerente CHECK (
    (kind IN ('opening', 'sale', 'supply', 'debt_payment') AND amount_cents >= 0)
    OR (kind = 'withdrawal' AND amount_cents <= 0)
    OR kind = 'adjustment'
  )
);

ALTER TABLE cash_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cash_movements
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX cash_movements_sessao_idx ON cash_movements (session_id, created_at);

-- ---------------------------------------------------------------------------
-- Comanda
-- ---------------------------------------------------------------------------

CREATE TYPE order_status AS ENUM ('open', 'paid', 'cancelled');
CREATE TYPE order_item_type AS ENUM ('service', 'product', 'consumable');
CREATE TYPE payment_method AS ENUM (
  'cash', 'pix', 'debit', 'credit', 'link', 'transfer', 'fiado'
);

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
  -- A comanda nasce do agendamento quando existe um (SPEC §3.1), mas venda
  -- avulsa de produto não tem agendamento nenhum.
  appointment_id  uuid REFERENCES appointments(id) ON DELETE SET NULL,
  -- Em qual gaveta a venda entrou. Nulo enquanto a comanda está aberta.
  session_id      uuid REFERENCES cash_sessions(id) ON DELETE SET NULL,

  status          order_status NOT NULL DEFAULT 'open',
  opened_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,

  -- Totais congelados no fechamento. Recalcular a partir dos itens no
  -- relatório reabriria a conta toda vez que o catálogo mudasse.
  subtotal_cents  integer NOT NULL DEFAULT 0,
  discount_cents  integer NOT NULL DEFAULT 0,
  tip_cents       integer NOT NULL DEFAULT 0,
  total_cents     integer NOT NULL DEFAULT 0,
  change_cents    integer NOT NULL DEFAULT 0,
  discount_reason text,

  -- Duas chaves porque são duas operações com efeitos diferentes: abrir a
  -- comanda e cobrá-la. Uma só faria o duplo toque no "Receber" ser confundido
  -- com o duplo toque no "Cobrar", e a segunda chamada devolveria a comanda
  -- errada.
  idempotency_key text,
  close_idempotency_key text,

  CONSTRAINT orders_valores_non_negative CHECK (
    subtotal_cents >= 0 AND discount_cents >= 0 AND tip_cents >= 0
    AND total_cents >= 0 AND change_cents >= 0
  ),
  CONSTRAINT orders_desconto_ate_o_subtotal CHECK (discount_cents <= subtotal_cents),
  CONSTRAINT orders_paga_tem_hora CHECK (status <> 'paid' OR closed_at IS NOT NULL)
);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Uma comanda aberta por agendamento. Duas seriam duas cobranças do mesmo
-- corte, e a segunda passaria despercebida até o cliente reclamar.
CREATE UNIQUE INDEX orders_uma_aberta_por_agendamento
  ON orders (appointment_id) WHERE status = 'open' AND appointment_id IS NOT NULL;

CREATE UNIQUE INDEX orders_idempotency_idx
  ON orders (tenant_id, location_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX orders_close_idempotency_idx
  ON orders (tenant_id, location_id, close_idempotency_key)
  WHERE close_idempotency_key IS NOT NULL;

CREATE INDEX orders_abertas_idx ON orders (location_id, opened_at) WHERE status = 'open';
-- O faturamento do dia lê as pagas de uma faixa. Índice parcial porque comanda
-- aberta nunca aparece nesse relatório.
CREATE INDEX orders_pagas_idx ON orders (location_id, closed_at) WHERE status = 'paid';

CREATE TABLE order_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind              order_item_type NOT NULL,
  -- Referência ao catálogo quando existe; nula em item avulso ("consumação").
  service_id        uuid REFERENCES services(id) ON DELETE SET NULL,
  description       text NOT NULL,
  quantity          smallint NOT NULL DEFAULT 1,
  -- Copiado do catálogo no momento da venda. Ver decisão 2 no topo.
  unit_price_cents  integer NOT NULL,
  -- Quem executou **este item**. É a base da comissão do bloco 19.
  professional_id   uuid REFERENCES professionals(id) ON DELETE SET NULL,
  position          smallint NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_items_quantidade_positiva CHECK (quantity >= 1),
  -- Zero é cortesia e é legítimo. Negativo não: desconto tem campo próprio, e
  -- preço negativo o esconderia do relatório que separa receita de desconto.
  CONSTRAINT order_items_preco_non_negative CHECK (unit_price_cents >= 0),
  CONSTRAINT order_items_descricao_preenchida CHECK (length(btrim(description)) > 0)
);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX order_items_order_idx ON order_items (order_id, position);
-- A comissão do bloco 19 lê por profissional e período.
CREATE INDEX order_items_professional_idx
  ON order_items (professional_id, created_at) WHERE professional_id IS NOT NULL;

CREATE TABLE order_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method        payment_method NOT NULL,
  amount_cents  integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_payments_valor_positivo CHECK (amount_cents > 0)
);

ALTER TABLE order_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_payments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX order_payments_order_idx ON order_payments (order_id);

-- ---------------------------------------------------------------------------
-- Extrato da conta do cliente
-- ---------------------------------------------------------------------------

CREATE TYPE customer_ledger_kind AS ENUM ('fiado', 'payment', 'credit', 'adjustment');

-- O saldo em `customers.balance_cents` é o **acumulado**; esta tabela é o
-- porquê dele. Sem o extrato, "o senhor deve R$ 80" é uma afirmação sem prova,
-- e a primeira discussão no balcão não tem como ser resolvida.
CREATE TABLE customer_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind          customer_ledger_kind NOT NULL,
  -- Negativo aumenta a dívida; positivo abate. Mesmo sinal do saldo.
  amount_cents  integer NOT NULL,
  balance_after_cents integer NOT NULL,
  order_id      uuid REFERENCES orders(id) ON DELETE SET NULL,
  session_id    uuid REFERENCES cash_sessions(id) ON DELETE SET NULL,
  note          text,
  created_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_by_name text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE customer_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_ledger
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX customer_ledger_customer_idx ON customer_ledger (customer_id, created_at DESC);
-- A tela de cobrança lê quem está devendo. Índice parcial: quem está zerado é
-- a maioria e nunca aparece nessa lista.
CREATE INDEX customers_devendo_idx ON customers (tenant_id, balance_cents)
  WHERE balance_cents < 0;

-- O extrato é prova, e prova que a aplicação reescreve não prova nada — mesma
-- razão do `audit_log` do bloco 12.
REVOKE UPDATE, DELETE ON customer_ledger FROM barbearia_app;
