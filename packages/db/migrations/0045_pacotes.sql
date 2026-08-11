-- ============================================================================
-- 0045 — Pacotes: venda, consumo, validade e receita diferida (bloco 42, §4.7)
--
-- ## O que separa pacote de assinatura
--
-- A SPEC abre a seção assim: "compra única, sem recorrência". O cliente paga
-- R$ 250 por cinco cortes e leva meses usando — ou não usa. Assinatura é o
-- bloco 45 e cobra todo mês; aqui não há cobrança nenhuma depois da primeira.
--
-- ## A decisão que dá nome ao bloco
--
-- A venda entra R$ 250 no caixa e **não é receita de R$ 250**. É receita de
-- cinco cortes que ainda não aconteceram, reconhecida conforme o uso. A SPEC
-- escreve o motivo em uma linha: *"Sem isso, o DRE mostra um mês excelente
-- seguido de meses falsamente ruins."*
--
-- Por isso `package_uses` existe como tabela e não como contador: o **quando**
-- de cada reconhecimento é a informação, e um `usados = 3` não a tem.
--
-- ## Um serviço por pacote, e é decisão
--
-- "5 cortes por R$ 250" é o exemplo da SPEC, e é como a barbearia de bairro
-- vende. Um pacote misto — três cortes e duas barbas — exigiria decidir qual
-- unidade some quando o cliente usa uma barba, e a resposta muda o preço da
-- outra. Entra como modalidade nova e explícita se alguém pedir; não entra
-- como coluna opcional que ninguém preenche.
-- ============================================================================

CREATE TABLE packages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id       uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,

  name             text NOT NULL,
  quantity         smallint NOT NULL,
  price_cents      integer NOT NULL,
  -- Nulo é "não vence", e é escolha legítima da barbearia.
  validity_days    integer,
  /**
   * Transferível ou não — requisito escrito da SPEC §4.7.
   *
   * Nasce **falso**, que é o comportamento anterior (não existia pacote, logo
   * nada era transferível) e o mais conservador: um pacote transferível é um
   * vale ao portador, e a barbearia que quiser vender assim decide isso de
   * propósito.
   */
  transferable     boolean NOT NULL DEFAULT false,
  active           boolean NOT NULL DEFAULT true,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT packages_quantidade_valida CHECK (quantity BETWEEN 2 AND 100),
  CONSTRAINT packages_preco_positivo CHECK (price_cents > 0),
  CONSTRAINT packages_validade_valida CHECK (
    validity_days IS NULL OR validity_days BETWEEN 7 AND 3650
  ),
  CONSTRAINT packages_nome_preenchido CHECK (length(btrim(name)) > 0)
);

ALTER TABLE packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE packages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON packages
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX packages_ativos_idx ON packages (service_id) WHERE active;

-- ---------------------------------------------------------------------------
-- O pacote comprado
-- ---------------------------------------------------------------------------

CREATE TABLE customer_packages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- O catálogo pode mudar ou sair de linha; o que foi vendido não muda.
  package_id          uuid REFERENCES packages(id) ON DELETE SET NULL,
  -- A comanda em que foi vendido. É por onde o dinheiro entrou.
  order_id            uuid REFERENCES orders(id) ON DELETE SET NULL,

  /**
   * Tudo congelado na compra: serviço, quantidade, preço e validade.
   *
   * O corte avulso sobe para R$ 70 em março, e as cinco unidades compradas em
   * janeiro continuam valendo R$ 50 cada. Recalcular na leitura faria a receita
   * **já reconhecida** mudar de valor — é o mesmo precedente da regra de
   * comissão copiada no lançamento e da taxa do adquirente congelada na venda.
   */
  service_id          uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  quantity            smallint NOT NULL,
  price_cents         integer NOT NULL,
  unit_value_cents    integer NOT NULL,
  transferable        boolean NOT NULL DEFAULT false,

  purchased_at        timestamptz NOT NULL DEFAULT now(),
  -- Nulo quando o pacote não vence.
  expires_at          timestamptz,

  -- Reembolso proporcional (SPEC §4.7). O pacote não some: ele fica com a data.
  refunded_at         timestamptz,
  refunded_cents      integer,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT customer_packages_quantidade_valida CHECK (quantity BETWEEN 1 AND 100),
  CONSTRAINT customer_packages_preco_positivo CHECK (price_cents > 0),
  CONSTRAINT customer_packages_unidade_positiva CHECK (unit_value_cents > 0),
  -- A soma das unidades nunca passa do que foi pago. O centavo que não divide
  -- fica de fora e vira receita na primeira unidade — ver `packages/core`.
  CONSTRAINT customer_packages_unidade_cabe CHECK (
    unit_value_cents * quantity <= price_cents
  ),
  CONSTRAINT customer_packages_reembolso_coerente CHECK (
    (refunded_at IS NULL) = (refunded_cents IS NULL)
  ),
  CONSTRAINT customer_packages_reembolso_nao_negativo CHECK (
    refunded_cents IS NULL OR refunded_cents >= 0
  )
);

ALTER TABLE customer_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_packages
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- "Este cliente tem pacote que cubra este corte?", na abertura de toda comanda.
CREATE INDEX customer_packages_do_cliente_idx
  ON customer_packages (customer_id, service_id)
  WHERE refunded_at IS NULL;

-- A varredura de vencimento e o passivo em aberto.
CREATE INDEX customer_packages_vencendo_idx
  ON customer_packages (expires_at)
  WHERE expires_at IS NOT NULL AND refunded_at IS NULL;

-- ---------------------------------------------------------------------------
-- O consumo
--
-- Tabela e não contador: o **quando** de cada reconhecimento é a informação que
-- a receita diferida precisa, e um `usados = 3` não a tem. É a mesma decisão do
-- extrato de fidelidade e do razão do cliente.
-- ---------------------------------------------------------------------------

CREATE TABLE package_uses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_package_id   uuid NOT NULL REFERENCES customer_packages(id) ON DELETE CASCADE,
  -- A comanda em que a unidade foi consumida.
  order_id              uuid REFERENCES orders(id) ON DELETE SET NULL,
  appointment_id        uuid REFERENCES appointments(id) ON DELETE SET NULL,

  -- A receita reconhecida **neste** consumo. Congelada, como todo o resto.
  value_cents           integer NOT NULL,
  -- O dia da unidade, para o relatório. `created_at` responde "que instante",
  -- não "de que dia é esta receita" — mesma decisão de `orders.business_day`.
  business_day          date NOT NULL,

  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT package_uses_valor_positivo CHECK (value_cents > 0)
);

ALTER TABLE package_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_uses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON package_uses
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Um consumo por comanda e por pacote.
 *
 * O fechamento é idempotente por chave, mas a cadeia do webhook do Pix pode
 * reentrar por outro caminho. Sem isto, a reentrega consumiria duas unidades do
 * cliente pelo mesmo corte — e o produto tiraria dele um serviço que ele não
 * recebeu.
 */
CREATE UNIQUE INDEX package_uses_um_por_comanda
  ON package_uses (customer_package_id, order_id)
  WHERE order_id IS NOT NULL;

CREATE INDEX package_uses_por_pacote_idx ON package_uses (customer_package_id);
-- A receita reconhecida do dia, que é o número que este bloco existe para dar.
CREATE INDEX package_uses_do_dia_idx ON package_uses (business_day);

/**
 * O consumo é append-only.
 *
 * "Por que sumiu um corte do meu pacote?" é a pergunta, e o registro é a
 * resposta. Registro que pode ser reescrito não responde nada — mesma decisão do
 * razão do cliente, do extrato de fidelidade e da trilha.
 *
 * Devolver uma unidade consumida por engano é **inserir** um estorno, e o
 * caminho para isso é o reembolso proporcional.
 */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON packages TO barbearia_app;
    GRANT SELECT, INSERT, UPDATE ON customer_packages TO barbearia_app;
    GRANT SELECT, INSERT ON package_uses TO barbearia_app;
    REVOKE UPDATE, DELETE ON package_uses FROM barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- O pacote entra na comanda dos dois lados
--
-- **Vendido** como item: é assim que o dinheiro entra e que a venda aparece no
-- caixa do dia.
--
-- **Consumido** como forma de pagamento: o item do corte continua com o preço
-- congelado da unidade — é ele que dá base à comissão do barbeiro, que não pode
-- cair só porque o cliente pagou adiantado — e o pacote quita a conta.
-- ---------------------------------------------------------------------------

ALTER TYPE order_item_type ADD VALUE IF NOT EXISTS 'package';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'pacote';

-- ---------------------------------------------------------------------------
-- A permissão de reembolsar
--
-- Separada de `settings.manage`, que edita o **catálogo** e não move centavo
-- nenhum. Com uma permissão só, quem podia cadastrar "5 cortes por R$ 250"
-- podia devolver R$ 150 ao cliente sem passar por dinheiro — e portanto sem
-- segundo fator, que é derivado do prefixo `finance.`.
-- ---------------------------------------------------------------------------

ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_conhecida;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_conhecida CHECK (permission IN (
  'appointments.view', 'appointments.create', 'appointments.cancel',
  'appointments.reschedule', 'appointments.view_all_professionals',
  'appointments.attend',
  'cashier.open', 'cashier.close', 'cashier.withdraw',
  'finance.view', 'finance.view_profit', 'finance.export', 'finance.discount',
  'finance.deposit', 'finance.loyalty_adjust', 'finance.package_refund',
  'commission.view_own', 'commission.view_all', 'commission.edit_rules',
  'customers.view', 'customers.edit', 'customers.export',
  'customers.view_photos', 'customers.view_notes', 'customers.edit_notes',
  'customers.anonymize', 'customers.reliability_override',
  'feedback.view', 'feedback.manage',
  'reports.finance', 'reports.operational',
  'inventory.view', 'inventory.adjust',
  'marketing.send', 'settings.manage', 'team.manage'
));

-- ---------------------------------------------------------------------------
-- O pacote vendido é um item da comanda, e o item sabe qual pacote é
--
-- A primeira versão passava a lista de pacotes vendidos **no corpo do
-- fechamento**, separada dos itens que dão o preço. Duas fontes para o mesmo
-- fato: um item de R$ 1 e uma lista com o pacote de R$ 250 fechariam a conta
-- por um real e criariam cinco cortes de R$ 50 congelados — e nada ficaria
-- vermelho, porque cada metade estava internamente coerente.
--
-- Com a coluna, quem foi vendido é derivado do que foi cobrado. Não há lista a
-- divergir e não há id de pacote vindo da requisição no fechamento.
-- ---------------------------------------------------------------------------

ALTER TABLE order_items
  ADD COLUMN package_id uuid REFERENCES packages(id) ON DELETE SET NULL;

-- Item de pacote sem pacote é um item que ninguém sabe o que vende; pacote
-- pendurado num item de serviço venderia um pacote junto de um corte.
ALTER TABLE order_items ADD CONSTRAINT order_items_pacote_coerente CHECK (
  (package_id IS NULL) OR (kind = 'package')
);

CREATE INDEX order_items_pacote_idx ON order_items (package_id)
  WHERE package_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Nunca mais unidades consumidas do que compradas
--
-- O índice único acima é por **comanda**: ele impede a reentrega do webhook do
-- Pix de consumir duas vezes pelo mesmo corte, e não impede duas comandas
-- diferentes do mesmo cliente fechando ao mesmo tempo. As duas leem "usados =
-- 4", as duas concluem que resta uma unidade, e as duas gravam.
--
-- A aplicação trava a linha e isso resolve. Mas a garantia de que ninguém
-- recebe serviço que não pagou é grande demais para morar só numa cláusula que
-- uma reescrita pode perder: aqui ela é fato do schema, como o teto do desconto
-- e a imutabilidade da comissão fechada.
--
-- `FOR UPDATE` dentro do gatilho serializa os concorrentes na própria linha do
-- pacote — sem ele, duas transações contariam antes de a outra gravar e as duas
-- passariam, que é exatamente o furo que este gatilho existe para fechar.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION package_uses_cabe_no_pacote() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  comprados smallint;
  consumidos integer;
BEGIN
  SELECT quantity INTO comprados
    FROM customer_packages WHERE id = NEW.customer_package_id
     FOR UPDATE;

  SELECT count(*) INTO consumidos
    FROM package_uses WHERE customer_package_id = NEW.customer_package_id;

  IF consumidos >= comprados THEN
    RAISE EXCEPTION
      'pacote % já teve as % unidades consumidas', NEW.customer_package_id, comprados
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER package_uses_cabe_no_pacote
  BEFORE INSERT ON package_uses
  FOR EACH ROW EXECUTE FUNCTION package_uses_cabe_no_pacote();
