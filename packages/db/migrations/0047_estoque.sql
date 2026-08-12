-- ============================================================================
-- 0047 — Produtos, estoque, ficha técnica e CMV (bloco 44, SPEC §3.7 e §3.8)
--
-- ## Estoque é saldo derivado, nunca coluna
--
-- A SPEC escreve em uma linha: *"Toda movimentação é imutável e auditada.
-- Estoque é **saldo derivado** do movimento, nunca campo editado direto."*
--
-- Por isso não existe `products.stock`. Um contador responde "quantos tem" e
-- nada mais, e a pergunta que chega no balcão é *"por que só tem 12 se eu
-- comprei 20?"* — que só tem resposta se cada entrada, venda, consumo e perda
-- for uma linha. É a mesma decisão de `package_uses` e do razão do cliente.
--
-- ## Revenda e consumo interno
--
-- A pomada que o cliente leva baixa na venda; o shampoo que o barbeiro usa baixa
-- por ficha técnica. Sem a distinção não existe margem real — o shampoo viraria
-- receita zero e custo nenhum, e o corte pareceria render mais do que rende.
-- ============================================================================

CREATE TYPE product_kind AS ENUM ('resale', 'internal');
CREATE TYPE stock_movement_kind AS ENUM (
  'entrada', 'saida', 'venda', 'consumo', 'perda', 'ajuste', 'transferencia'
);

CREATE TABLE products (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  sku              text,
  barcode          text,
  name             text NOT NULL,
  category         text,
  supplier         text,

  kind             product_kind NOT NULL,
  /**
   * O custo **atual** de reposição, para a ficha técnica e a sugestão de compra.
   *
   * Não é o custo do CMV: aquele é congelado em cada movimento, porque a pomada
   * comprada a R$ 12 em janeiro e a R$ 18 em março não é a mesma pomada para
   * efeito de margem. Recalcular a margem de janeiro com o preço de março faria
   * o resultado de um mês fechado mudar sozinho.
   */
  cost_cents       integer NOT NULL DEFAULT 0,
  -- Nulo em `internal`: shampoo de uso interno não tem preço de venda, e um
  -- zero ali seria "vendo de graça" em vez de "não vendo".
  price_cents      integer,
  min_stock        integer NOT NULL DEFAULT 0,
  -- A unidade em que a ficha técnica conta: 'un', 'ml', 'g'.
  unit             text NOT NULL DEFAULT 'un',
  expires_on       date,

  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT products_nome_preenchido CHECK (length(btrim(name)) > 0),
  CONSTRAINT products_custo_nao_negativo CHECK (cost_cents >= 0),
  CONSTRAINT products_preco_nao_negativo CHECK (price_cents IS NULL OR price_cents >= 0),
  CONSTRAINT products_minimo_nao_negativo CHECK (min_stock >= 0),
  /**
   * Produto de revenda precisa de preço.
   *
   * Sem ele a recepção o encontra na busca da comanda e o acrescenta por zero —
   * uma venda que não entra no caixa e some do CMV. O de uso interno é o
   * contrário: preço nele seria um número que ninguém cobra.
   */
  CONSTRAINT products_revenda_tem_preco CHECK (
    (kind = 'resale' AND price_cents IS NOT NULL) OR
    (kind = 'internal' AND price_cents IS NULL)
  )
);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON products
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- O código de barras é o que a recepção bipa, e dois produtos com o mesmo
-- código fariam a leitura escolher um ao acaso.
CREATE UNIQUE INDEX products_barcode_unico ON products (tenant_id, barcode)
  WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX products_sku_unico ON products (tenant_id, sku)
  WHERE sku IS NOT NULL;

CREATE INDEX products_ativos_idx ON products (kind, name) WHERE active;
-- A varredura de validade.
CREATE INDEX products_vencendo_idx ON products (expires_on)
  WHERE expires_on IS NOT NULL AND active;

-- ---------------------------------------------------------------------------
-- O movimento
--
-- Imutável e auditado, palavra por palavra da SPEC. Não existe UPDATE nem
-- DELETE para a aplicação: corrigir uma contagem errada é lançar um `ajuste`,
-- que exige motivo escrito e fica no histórico ao lado do erro.
-- ---------------------------------------------------------------------------

CREATE TABLE stock_movements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  location_id      uuid REFERENCES locations(id) ON DELETE SET NULL,

  kind             stock_movement_kind NOT NULL,
  /**
   * Com sinal, e é o sinal que decide.
   *
   * `ajuste` e `transferencia` são os dois que andam nos dois sentidos. Os
   * outros cinco têm direção fixa, garantida pelo `CHECK` abaixo: uma "perda de
   * −3" seria uma perda que aumenta o estoque.
   */
  quantity         integer NOT NULL,

  /**
   * O custo unitário **congelado neste movimento**.
   *
   * É o que o CMV lê. `products.cost_cents` responde "quanto custa repor hoje";
   * esta coluna responde "quanto custou o que saiu naquele dia", e é a única das
   * duas que pode aparecer num relatório de mês fechado.
   */
  unit_cost_cents  integer NOT NULL DEFAULT 0,

  -- De onde o movimento veio, quando veio de algum lugar.
  order_id         uuid REFERENCES orders(id) ON DELETE SET NULL,
  appointment_id   uuid REFERENCES appointments(id) ON DELETE SET NULL,

  -- Obrigatório em `perda` e `ajuste`: são os dois em que o número muda sem
  -- nota fiscal nem venda, e "sumiu" não é registro de nada.
  reason           text,
  staff_user_id    uuid REFERENCES staff_users(id) ON DELETE SET NULL,

  business_day     date NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT stock_movements_quantidade_nao_zero CHECK (quantity <> 0),
  CONSTRAINT stock_movements_custo_nao_negativo CHECK (unit_cost_cents >= 0),
  CONSTRAINT stock_movements_direcao_coerente CHECK (
    kind IN ('ajuste', 'transferencia')
    OR (kind = 'entrada' AND quantity > 0)
    OR (kind IN ('saida', 'venda', 'consumo', 'perda') AND quantity < 0)
  ),
  CONSTRAINT stock_movements_motivo_escrito CHECK (
    kind NOT IN ('perda', 'ajuste') OR length(btrim(coalesce(reason, ''))) >= 3
  )
);

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_movements
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- O saldo de um produto é uma soma sobre este índice, e é a consulta mais
-- frequente do módulo: ela roda em toda abertura da tela de estoque.
CREATE INDEX stock_movements_do_produto_idx ON stock_movements (product_id, created_at DESC);
CREATE INDEX stock_movements_do_dia_idx ON stock_movements (business_day);
-- O CMV de uma comanda: quanto de insumo e de produto saiu por causa dela.
CREATE INDEX stock_movements_da_comanda_idx ON stock_movements (order_id)
  WHERE order_id IS NOT NULL;

/**
 * Uma baixa por comanda e por produto.
 *
 * O fechamento é idempotente por chave, mas a cadeia do webhook do Pix reentra
 * por outro caminho. Sem isto, a reentrega baixaria duas vezes o mesmo vidro de
 * pomada — e o estoque descolaria da prateleira sem ninguém saber por quê.
 */
CREATE UNIQUE INDEX stock_movements_uma_venda_por_comanda
  ON stock_movements (order_id, product_id, kind)
  WHERE order_id IS NOT NULL AND kind IN ('venda', 'consumo');

-- ---------------------------------------------------------------------------
-- A ficha técnica (SPEC §3.7)
--
--   Barba Premium consome:
--     óleo pré-barba    5 ml
--     pós-barba         2 ml
--     lâmina            1 un
-- ---------------------------------------------------------------------------

CREATE TABLE service_consumables (
  service_id       uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quantity         integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (service_id, product_id),
  CONSTRAINT service_consumables_quantidade_positiva CHECK (quantity > 0)
);

ALTER TABLE service_consumables ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_consumables FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON service_consumables
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX service_consumables_do_produto_idx ON service_consumables (product_id);

-- ---------------------------------------------------------------------------
-- O item da comanda aponta para o produto que ele vende
--
-- Mesma decisão de `order_items.package_id` no bloco 42, e pelo mesmo motivo:
-- com uma lista no corpo do fechamento, o que foi cobrado e o que baixou do
-- estoque seriam dois dados podendo discordar. Derivado do item, são um só.
-- ---------------------------------------------------------------------------

ALTER TABLE order_items
  ADD COLUMN product_id uuid REFERENCES products(id) ON DELETE SET NULL;

ALTER TABLE order_items ADD CONSTRAINT order_items_produto_coerente CHECK (
  (product_id IS NULL) OR (kind IN ('product', 'consumable'))
);

CREATE INDEX order_items_produto_idx ON order_items (product_id)
  WHERE product_id IS NOT NULL;

/**
 * O movimento é append-only.
 *
 * *"Toda movimentação é imutável e auditada"* é a SPEC, e aqui isso deixa de
 * depender de alguém lembrar. Corrigir uma contagem é lançar `ajuste`, que
 * exige motivo escrito e fica no histórico **ao lado** do erro — que é o que
 * responde "por que só tem 12 se eu comprei 20?".
 */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON products TO barbearia_app;
    GRANT SELECT, INSERT, DELETE ON service_consumables TO barbearia_app;
    GRANT SELECT, INSERT ON stock_movements TO barbearia_app;
    REVOKE UPDATE, DELETE ON stock_movements FROM barbearia_app;
  END IF;
END $$;

/**
 * O saldo nunca fica negativo.
 *
 * A aplicação confere antes de gravar, sob a trava da linha do produto. Este
 * gatilho é a segunda camada, pelo mesmo motivo do que impede consumir mais
 * unidades de pacote do que foram compradas: uma cláusula de trava é perdível
 * numa reescrita, e um estoque em −3 contamina o CMV do mês inteiro.
 *
 * `FOR UPDATE` na linha do produto serializa os concorrentes — sem ele, duas
 * vendas simultâneas do último vidro contariam antes de a outra gravar e as
 * duas passariam.
 */
CREATE OR REPLACE FUNCTION stock_movements_saldo_nao_negativo() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  saldo integer;
BEGIN
  PERFORM 1 FROM products WHERE id = NEW.product_id FOR UPDATE;

  SELECT coalesce(sum(quantity), 0) INTO saldo
    FROM stock_movements WHERE product_id = NEW.product_id;

  IF saldo + NEW.quantity < 0 THEN
    RAISE EXCEPTION 'estoque do produto % ficaria negativo (% + %)',
      NEW.product_id, saldo, NEW.quantity
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER stock_movements_saldo_nao_negativo
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_saldo_nao_negativo();
