-- ============================================================================
-- 0054 — Financeiro: contas a pagar e a receber, transferências, conciliação
--        (bloco 51, SPEC §3.10)
--
-- *"Módulos: caixa · contas a pagar · contas a receber · transferências ·
-- conciliação · categorias financeiras · centros de custo · DRE gerencial"*
--
-- O caixa existe desde o bloco 18 e o DRE é do 52. Este bloco entrega o meio: o
-- que a barbearia **deve** e o que **tem a receber** fora da comanda.
--
-- ## Uma tabela para as duas contas, e a direção é coluna
--
-- A SPEC lista "contas a pagar" e "contas a receber" como dois módulos, e a
-- tentação é criar duas tabelas. Elas têm exatamente a mesma forma — vencimento,
-- valor, categoria, quem, pago ou não —, e duas tabelas iguais significam duas
-- consultas para "o que vence esta semana", dois lugares para conciliar e dois
-- para esquecer de mexer no bloco seguinte.
--
-- A direção é `bill_direction`, e o que muda é a leitura. É a mesma escolha que
-- `cash_movements` faz desde o bloco 18 com o sinal do valor, e o oposto do que
-- `subscriptions` e `club_subscriptions` fizeram — lá são dois **fatos**
-- diferentes com o mesmo nome de negócio; aqui é o mesmo fato em dois sentidos.
--
-- ## A conta é onde o dinheiro está, e a transferência move entre elas
--
-- Sem `financial_accounts`, "transferência" não tem de onde nem para onde. A
-- gaveta é uma conta como o banco é: quem faz sangria para depositar está
-- transferindo, e hoje isso é uma saída de caixa que some — o dinheiro sai da
-- gaveta e não entra em lugar nenhum no produto.
-- ============================================================================

CREATE TYPE bill_direction AS ENUM ('pagar', 'receber');
CREATE TYPE bill_status AS ENUM ('aberta', 'paga', 'cancelada');

/**
 * Categoria financeira.
 *
 * Sem ela o DRE do bloco 52 não tem como agrupar despesa — e a barbearia
 * descobre que gastou R$ 4.000 no mês sem saber em quê. A categoria tem
 * **direção** porque "aluguel" nunca é receita, e uma lista única obrigaria a
 * tela a mostrar as duas metades em todo seletor.
 */
CREATE TABLE financial_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  direction   bill_direction NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT financial_categories_nome_preenchido CHECK (length(btrim(name)) > 0)
);

ALTER TABLE financial_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON financial_categories
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Duas categorias com o mesmo nome e a mesma direção são erro de digitação.
CREATE UNIQUE INDEX financial_categories_sem_repetida
  ON financial_categories (tenant_id, direction, lower(btrim(name)));

/**
 * Onde o dinheiro está.
 *
 * A gaveta é uma conta como o banco é. `is_cash` marca a que a sessão de caixa
 * alimenta, e ela exige unidade: gaveta é de uma unidade, e uma barbearia com
 * duas lojas tem duas gavetas que fecham sozinhas. A conta bancária não tem
 * unidade — é uma só para o negócio, e forçar uma escolha ali obrigaria a
 * duplicá-la por loja para um dinheiro que é o mesmo.
 */
CREATE TABLE financial_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  is_cash     boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT financial_accounts_nome_preenchido CHECK (length(btrim(name)) > 0),
  CONSTRAINT financial_accounts_gaveta_tem_unidade CHECK (
    NOT is_cash OR location_id IS NOT NULL
  )
);

ALTER TABLE financial_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON financial_accounts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE UNIQUE INDEX financial_accounts_sem_repetida
  ON financial_accounts (tenant_id, lower(btrim(name)));

-- Uma gaveta por unidade: duas fariam o fechamento ter dois donos, que é
-- exatamente o que o bloco 18 existe para impedir.
CREATE UNIQUE INDEX financial_accounts_uma_gaveta_por_unidade
  ON financial_accounts (location_id) WHERE is_cash;

-- ---------------------------------------------------------------------------
-- O que entra e o que sai da gaveta por causa de uma conta
--
-- Pagar o motoboy pela gaveta é dinheiro que sai de verdade, e o fechamento tem
-- que enxergá-lo — senão a conferência acusa falta e alguém procura ladrão onde
-- houve pagamento. Os dois tipos são novos em vez de reaproveitar `withdrawal`
-- e `supply` porque o extrato do caixa é lido por gente: "sangria" e "pagamento
-- de conta" saem da gaveta do mesmo jeito e significam coisas diferentes para
-- quem confere.
-- ---------------------------------------------------------------------------

ALTER TYPE cash_movement_type ADD VALUE IF NOT EXISTS 'bill_payment' AFTER 'debt_payment';
ALTER TYPE cash_movement_type ADD VALUE IF NOT EXISTS 'bill_receipt' AFTER 'bill_payment';

ALTER TABLE cash_movements DROP CONSTRAINT cash_movements_sinal_coerente;
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_sinal_coerente CHECK (
  (kind IN ('opening', 'sale', 'supply', 'debt_payment', 'bill_receipt') AND amount_cents >= 0)
  OR (kind IN ('withdrawal', 'bill_payment') AND amount_cents <= 0)
  OR kind = 'adjustment'
);

-- ---------------------------------------------------------------------------
-- A conta a pagar e a receber
-- ---------------------------------------------------------------------------

CREATE TABLE bills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  /**
   * A unidade, e não a barbearia: uma rede com duas lojas paga dois aluguéis, e
   * o DRE do bloco 52 vai perguntar de qual delas é cada despesa.
   *
   * `RESTRICT` e não `CASCADE`: ação referencial roda com os direitos do **dono
   * da tabela** e não passa pelo `REVOKE DELETE` logo abaixo — apagar uma
   * unidade levaria junto o registro de tudo o que ela pagou, sem trilha e sem
   * erro, pela porta que a revogação existe para fechar. `tenant_id` continua
   * sendo a única exceção, porque apagar a barbearia é apagar tudo dela por
   * definição.
   */
  location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,

  direction     bill_direction NOT NULL,
  -- "Aluguel do salão", "Distribuidora São Paulo". Quem, em uma linha.
  description   text NOT NULL,
  /**
   * `SET NULL` e não `CASCADE`: apagar uma categoria não pode apagar a conta que
   * ela classificava. A conta é registro de dinheiro; a categoria é etiqueta.
   */
  category_id   uuid REFERENCES financial_categories(id) ON DELETE SET NULL,
  account_id    uuid REFERENCES financial_accounts(id) ON DELETE SET NULL,

  amount_cents  integer NOT NULL,
  -- O dia em que ela vence, no calendário — não um instante.
  due_on        date NOT NULL,
  status        bill_status NOT NULL DEFAULT 'aberta',

  paid_on       date,
  paid_cents    integer,
  /**
   * O movimento de caixa que a quitou, quando ela foi paga pela gaveta.
   *
   * É a conciliação da SPEC: a conta e o movimento apontando um para o outro em
   * vez de dois números que alguém compara na tela. `SET NULL` porque
   * `cash_movements` pertence a uma sessão que pode ser apagada com a unidade, e
   * a conta paga continua sendo verdade.
   */
  cash_movement_id uuid REFERENCES cash_movements(id) ON DELETE SET NULL,

  note          text,
  created_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_by_name text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bills_valor_positivo CHECK (amount_cents > 0),
  CONSTRAINT bills_descricao_preenchida CHECK (length(btrim(description)) > 0),
  /**
   * Paga tem dia e valor; o que não está pago não tem nenhum dos dois.
   *
   * "Paga" sem dia é uma linha que responde "sim" para "já pagamos?" e nada para
   * "quando?" — e é a segunda pergunta que aparece quando o fornecedor liga
   * cobrando de novo.
   */
  CONSTRAINT bills_pagamento_coerente CHECK (
    (status = 'paga') = (paid_on IS NOT NULL AND paid_cents IS NOT NULL)
  ),
  CONSTRAINT bills_valor_pago_positivo CHECK (paid_cents IS NULL OR paid_cents > 0),
  -- Movimento de caixa sem pagamento é dinheiro que saiu da gaveta por uma conta
  -- que continua em aberto: o fornecedor cobraria de novo e o balcão pagaria.
  CONSTRAINT bills_movimento_so_com_pagamento CHECK (
    cash_movement_id IS NULL OR status = 'paga'
  )
);

ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bills
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * "O que vence esta semana?" — a pergunta que a tela abre para responder.
 *
 * Índice parcial no que está em aberto: conta paga é histórico, e o histórico
 * de uma barbearia com dois anos de operação é a esmagadora maioria das linhas.
 */
CREATE INDEX bills_abertas_idx ON bills (location_id, due_on, direction)
  WHERE status = 'aberta';

-- O DRE do bloco 52 lê por período e por categoria, e ele lê o que foi **pago**.
CREATE INDEX bills_pagas_idx ON bills (location_id, paid_on DESC, category_id)
  WHERE status = 'paga';

/**
 * A conta paga pela gaveta não volta atrás.
 *
 * O dinheiro saiu e o `cash_movements` registrou — que é append-only desde o
 * bloco 18. Deixar a conta voltar a "aberta" faria o extrato do caixa e a lista
 * do financeiro contarem histórias diferentes sobre a mesma nota de cem, e a
 * conferência do dia fechar com falta que ninguém explica. O caminho para
 * desfazer é o que o produto já tem: um `adjustment` no caixa, com motivo, ao
 * lado do erro.
 *
 * Quem pagou por fora da gaveta pode desfazer: ali não há segundo registro para
 * contradizer, e um clique errado numa lista de trinta linhas é o erro mais
 * comum desta tela.
 */
CREATE OR REPLACE FUNCTION bills_congelada() RETURNS trigger AS $$
BEGIN
  IF OLD.direction <> NEW.direction THEN
    RAISE EXCEPTION 'a direção de uma conta é congelada';
  END IF;

  IF OLD.status = 'cancelada' AND NEW.status <> 'cancelada' THEN
    RAISE EXCEPTION 'conta cancelada não volta';
  END IF;

  IF OLD.status = 'paga' AND NEW.status <> 'paga'
     AND OLD.cash_movement_id IS NOT NULL THEN
    RAISE EXCEPTION 'conta paga pela gaveta não volta: ajuste o caixa';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER bills_congelada_trg
  BEFORE UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION bills_congelada();

-- ---------------------------------------------------------------------------
-- A transferência entre contas
--
-- Duas colunas e não dois lançamentos com sinal: a transferência é **um** fato,
-- e parti-la em dois deixaria a pergunta "de onde veio este dinheiro?" com duas
-- respostas independentes que alguém pode dessincronizar. O saldo de cada conta
-- é derivado da soma, como o estoque desde o bloco 44.
-- ---------------------------------------------------------------------------

CREATE TABLE account_transfers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- `RESTRICT` pela mesma razão de `bills`: a cascata não passa pelo `REVOKE`.
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,

  /**
   * `RESTRICT` e não `SET NULL`: uma transferência sem origem ou sem destino é
   * uma linha que diz que o dinheiro andou e não diz para onde — pior que
   * nenhuma, porque quem procura o dinheiro a lê como se explicasse alguma
   * coisa. Conta que já moveu dinheiro não se apaga; desativa-se.
   */
  from_account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  to_account_id   uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  amount_cents    integer NOT NULL,
  happened_on     date NOT NULL,
  note            text,
  -- Quando a origem é a gaveta, a saída também é movimento de caixa: sem isso o
  -- depósito no banco apareceria como falta no fechamento.
  cash_movement_id uuid REFERENCES cash_movements(id) ON DELETE SET NULL,

  /**
   * Duas transferências iguais no mesmo dia são um caso legítimo — dois
   * depósitos de R$ 500 acontecem —, e por isso aqui a proteção contra o toque
   * duplo **precisa** de chave: não há estado que distinga a segunda da
   * repetição da primeira, ao contrário da conta, que sai de `aberta`.
   */
  idempotency_key text,

  created_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_by_name text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT account_transfers_valor_positivo CHECK (amount_cents > 0),
  /**
   * Não se transfere para a mesma conta.
   *
   * É erro de digitação, e sem a recusa ele vira uma linha que não move nada e
   * some no meio do extrato — o pior tipo, porque quem procura o dinheiro
   * perdido a lê como se explicasse alguma coisa.
   */
  CONSTRAINT account_transfers_contas_diferentes CHECK (from_account_id <> to_account_id)
);

ALTER TABLE account_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON account_transfers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX account_transfers_por_dia_idx
  ON account_transfers (location_id, happened_on DESC);

CREATE UNIQUE INDEX account_transfers_idempotencia
  ON account_transfers (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Grants
--
-- `REVOKE DELETE` em tudo, pela razão de sempre: são registros de dinheiro.
-- Cancelar uma conta é **estado**; desfazer uma transferência é a transferência
-- inversa, com data própria — e é assim que o extrato conta o que aconteceu em
-- vez de o que sobrou.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON financial_categories TO barbearia_app;
    GRANT SELECT, INSERT, UPDATE ON financial_accounts TO barbearia_app;
    GRANT SELECT, INSERT, UPDATE ON bills TO barbearia_app;
    GRANT SELECT, INSERT ON account_transfers TO barbearia_app;
    REVOKE DELETE ON financial_categories FROM barbearia_app;
    REVOKE DELETE ON financial_accounts FROM barbearia_app;
    REVOKE DELETE ON bills FROM barbearia_app;
    REVOKE UPDATE, DELETE ON account_transfers FROM barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- As permissões novas no catálogo do banco
--
-- `role_permissions` tem `CHECK` com a lista inteira desde o bloco 16, e há
-- teste que a compara com `packages/core`. Sem estas linhas a permissão existe
-- no código e é recusada pelo banco — e a tela de papéis não consegue
-- concedê-la.
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
