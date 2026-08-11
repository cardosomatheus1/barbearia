-- ============================================================================
-- 0044 — Fidelidade: pontos, visitas ou cashback (bloco 41, SPEC §4.8)
--
-- ## Um modelo, nunca três
--
-- A SPEC é explícita, e o motivo é o cliente: "você tem 340 pontos, 3 visitas e
-- R$ 12 de cashback" é uma frase que ninguém entende no balcão. O schema impõe
-- a escolha — **uma linha de programa por barbearia**, com o modo dentro dela.
-- Não é validação de aplicação: é a chave primária.
--
-- ## Por que um livro-razão e não uma coluna de saldo
--
-- Saldo é um número que alguém sobrescreve, e a pergunta que a barbearia recebe
-- é "por que caiu?". Um número não responde. Cada acúmulo, resgate, expiração e
-- ajuste é uma linha append-only; o saldo é derivado por FIFO no domínio. É a
-- mesma decisão de `customer_ledger` e de `commission_entries`.
--
-- ## Por que o modo é congelado em cada lançamento
--
-- A barbearia troca de pontos para cashback em maio. As linhas de abril
-- continuam sendo pontos — reinterpretá-las com a regra nova transformaria 300
-- pontos em R$ 300 de crédito. O modo mora na linha; o programa só diz o que
-- vale de hoje em diante. Mesmo precedente da regra de comissão copiada no
-- lançamento (bloco 19) e da taxa do adquirente congelada na venda (bloco 36).
--
-- ## Por que resgate é forma de pagamento e não desconto
--
-- Desconto é a casa abrindo mão de receita, e por isso tem permissão própria e
-- teto (`finance.discount`, `tenants.max_discount_bps`). Resgate é o cliente
-- gastando um crédito que já é dele. Tratá-lo como desconto faria o relatório
-- de descontos concedidos incluir dinheiro que a barbearia já tinha provisionado
-- — e faria o teto de desconto do bloco 30 barrar o cliente de usar o próprio
-- saldo.
-- ============================================================================

CREATE TYPE loyalty_mode AS ENUM ('nenhum', 'pontos', 'visitas', 'cashback');

CREATE TABLE loyalty_programs (
  -- Chave primária no tenant: é o que torna "um modelo por barbearia" um fato
  -- do schema em vez de uma regra que alguém precisa lembrar de aplicar.
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,

  mode                 loyalty_mode NOT NULL DEFAULT 'nenhum',

  -- Pontos por real gasto. A SPEC sugere 1.
  points_per_real      smallint NOT NULL DEFAULT 1,
  /**
   * Quanto vale um ponto no resgate, em centavos.
   *
   * Precisa existir. Com "R$ 1 = 1 ponto" na entrada e um ponto valendo um
   * real na saída, o programa devolveria cem por cento do que a pessoa gastou —
   * o que não é fidelidade, é a barbearia trabalhando de graça. Um centavo dá o
   * 1% que o mercado pratica, e a barbearia sobe se quiser.
   */
  point_value_cents    smallint NOT NULL DEFAULT 1,
  -- "A cada 10 cortes, 1 grátis" — o 10.
  visits_goal          smallint NOT NULL DEFAULT 10,
  -- 5% = 500. Pontos-base inteiros, nunca fração.
  cashback_bps         integer NOT NULL DEFAULT 500,
  -- Nulo é "não vence", e é escolha legítima da barbearia.
  expires_days         integer,

  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT loyalty_programs_pontos_validos CHECK (
    points_per_real > 0 AND point_value_cents > 0
  ),
  CONSTRAINT loyalty_programs_meta_valida CHECK (visits_goal BETWEEN 2 AND 100),
  -- Cem por cento de cashback é a casa pagando para atender. O teto de 50% é
  -- folgado para qualquer campanha real e barra o zero digitado a mais.
  CONSTRAINT loyalty_programs_cashback_valido CHECK (cashback_bps BETWEEN 0 AND 5000),
  CONSTRAINT loyalty_programs_validade_valida CHECK (
    expires_days IS NULL OR expires_days BETWEEN 30 AND 3650
  )
);

ALTER TABLE loyalty_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_programs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON loyalty_programs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- O extrato
-- ---------------------------------------------------------------------------

CREATE TYPE loyalty_entry_kind AS ENUM ('acumulo', 'resgate', 'expiracao', 'ajuste');

CREATE TABLE loyalty_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- A venda que gerou ou consumiu. Nulo em ajuste manual e em expiração.
  order_id      uuid REFERENCES orders(id) ON DELETE SET NULL,

  kind          loyalty_entry_kind NOT NULL,
  /**
   * O modo **congelado**. Ver o cabeçalho.
   *
   * `nenhum` não aparece aqui: um lançamento de um programa que não existe é
   * uma linha sem unidade, e é exatamente o que este campo evita.
   */
  mode          loyalty_mode NOT NULL,

  -- Com sinal. Positivo entra, negativo sai. A unidade é a do `mode`: pontos,
  -- visitas ou **centavos**.
  amount        integer NOT NULL,
  -- Sobre quanto o acúmulo foi calculado. É o que responde "por que só 30
  -- pontos numa conta de R$ 50?" — a resposta é o resgate que entrou junto.
  base_cents    integer,
  -- Nulo quando o programa não expira.
  expires_at    timestamptz,

  note          text,
  created_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT loyalty_entries_modo_real CHECK (mode <> 'nenhum'),
  -- Movimento zero é linha que não diz nada e polui o extrato que a pessoa lê.
  CONSTRAINT loyalty_entries_movimento CHECK (amount <> 0),
  CONSTRAINT loyalty_entries_entrada_positiva CHECK (kind <> 'acumulo' OR amount > 0),
  CONSTRAINT loyalty_entries_saida_negativa CHECK (
    kind NOT IN ('resgate', 'expiracao') OR amount < 0
  ),
  CONSTRAINT loyalty_entries_base_non_negative CHECK (base_cents IS NULL OR base_cents >= 0),
  -- Ajuste é a única linha que uma pessoa cria à mão, e sem motivo escrito ela
  -- é indefensável na primeira pergunta do dono.
  CONSTRAINT loyalty_entries_ajuste_tem_motivo CHECK (
    kind <> 'ajuste' OR length(btrim(coalesce(note, ''))) >= 10
  )
);

ALTER TABLE loyalty_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON loyalty_entries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Um acúmulo por venda.
 *
 * O fechamento da comanda é idempotente por chave, mas a cadeia do webhook do
 * Pix pode reentrar por outro caminho. Sem este índice, a reentrega dobraria o
 * saldo do cliente — e saldo dobrado vira dinheiro no balcão.
 */
CREATE UNIQUE INDEX loyalty_entries_um_acumulo_por_venda
  ON loyalty_entries (order_id)
  WHERE kind = 'acumulo' AND order_id IS NOT NULL;

-- O extrato do cliente e o saldo, que é a leitura mais frequente do bloco.
CREATE INDEX loyalty_entries_por_cliente_idx
  ON loyalty_entries (customer_id, created_at);

/**
 * A varredura de expiração: toda **entrada** com prazo.
 *
 * `amount > 0` e não `kind = 'acumulo'`: o ajuste manual positivo também vence,
 * e recortar por tipo faria o saldo ajustado sumir da leitura sem nunca aparecer
 * no extrato. O filtro da aplicação e o índice parcial dizem a mesma coisa — é a
 * convenção que o bloco 39 pagou para aprender.
 */
CREATE INDEX loyalty_entries_vencendo_idx
  ON loyalty_entries (expires_at)
  WHERE expires_at IS NOT NULL AND amount > 0;

/**
 * Append-only, como o extrato do cliente e a trilha.
 *
 * Corrigir um saldo é **inserir um ajuste** com motivo escrito, nunca reescrever
 * a linha antiga. Sem isto, "meus pontos sumiram" não tem resposta — e a
 * resposta é o próprio extrato.
 */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON loyalty_programs TO barbearia_app;
    GRANT SELECT, INSERT ON loyalty_entries TO barbearia_app;
    REVOKE UPDATE, DELETE ON loyalty_entries FROM barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Resgate é forma de pagamento
--
-- Ver o cabeçalho: desconto é a casa abrindo mão de receita; resgate é o cliente
-- gastando crédito que já é dele. Como forma de pagamento ele entra na comanda
-- pelo caminho que já existe, respeita o mesmo fechamento e aparece no relatório
-- separado do que a barbearia deu de desconto.
--
-- **Não gera taxa de adquirente**: não passa por maquininha nenhuma. A linha
-- ausente em `acquirer_fees` já significa zero, e é o comportamento certo aqui.
-- ---------------------------------------------------------------------------

ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'fidelidade';

-- ---------------------------------------------------------------------------
-- A permissão de mexer no saldo à mão
--
-- Prefixo `finance.` de propósito: `PERMISSOES_DE_DINHEIRO` deriva o segundo
-- fator do prefixo, e criar saldo de fidelidade **é** criar dinheiro — ele vira
-- pagamento no balcão na operação seguinte. Uma permissão fora do grupo faria a
-- rota que mais se parece com "imprimir dinheiro" ser a única sem segundo fator.
--
-- Configurar o programa continua sendo `settings.manage`: escolher o modelo é
-- decisão de negócio, não movimento de saldo.
-- ---------------------------------------------------------------------------

ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_conhecida;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_conhecida CHECK (permission IN (
  'appointments.view', 'appointments.create', 'appointments.cancel',
  'appointments.reschedule', 'appointments.view_all_professionals',
  'appointments.attend',
  'cashier.open', 'cashier.close', 'cashier.withdraw',
  'finance.view', 'finance.view_profit', 'finance.export', 'finance.discount',
  'finance.deposit', 'finance.loyalty_adjust',
  'commission.view_own', 'commission.view_all', 'commission.edit_rules',
  'customers.view', 'customers.edit', 'customers.export',
  'customers.view_photos', 'customers.view_notes', 'customers.edit_notes',
  'customers.anonymize', 'customers.reliability_override',
  'feedback.view', 'feedback.manage',
  'reports.finance', 'reports.operational',
  'inventory.view', 'inventory.adjust',
  'marketing.send', 'settings.manage', 'team.manage'
));
