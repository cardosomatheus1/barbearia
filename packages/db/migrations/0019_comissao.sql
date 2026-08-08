-- ============================================================================
-- 0019 — Comissão e fechamento
--
-- O bloco 18 passou a gravar quem executou cada item. Aqui isso vira dinheiro
-- de alguém.
--
-- Quatro decisões que merecem explicação:
--
-- 1. **O lançamento guarda a base e a regra, nunca o valor pronto.** Faixa
--    progressiva depende do acumulado do período: a alíquota do corte de terça
--    só é conhecida no fim do mês, e um estorno no dia 28 pode derrubar a faixa
--    de tudo o que veio antes. Valor gravado teria que ser reescrito a cada
--    venda — e reescrever comissão é exatamente o que destrói a confiança no
--    sistema.
--
-- 2. **A regra é copiada para dentro do lançamento.** Mudar a alíquota em
--    outubro não pode alterar o que foi feito em setembro. É a mesma decisão do
--    preço em `order_items`: referenciar o catálogo reescreveria o passado.
--
-- 3. **Fechar é congelar.** O fechamento calcula, grava o valor por
--    profissional e carimba os lançamentos. Depois disso eles não entram em
--    conta nenhuma de novo — nem se a regra mudar, nem se a venda for
--    estornada. O estorno de uma venda já fechada vira lançamento **novo**, com
--    sinal negativo, no período aberto.
--
-- 4. **Estorno é linha nova, nunca `DELETE`.** A trilha de por que o barbeiro
--    recebeu o que recebeu é a única defesa do dono numa discussão de fim de
--    mês, e ela só existe se nada for apagado.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- O dia da barbearia
-- ---------------------------------------------------------------------------

/**
 * O dia **da unidade** em que a venda entrou.
 *
 * `closed_at` é `timestamptz` e responde "que instante"; esta coluna responde
 * "de que dia é este dinheiro", que é outra pergunta. Às 22h de Salvador o
 * servidor em UTC já virou a data, e a venda cairia no dia seguinte — no mês
 * errado do acerto do barbeiro.
 *
 * Existia uma segunda fonte para a mesma pergunta: `commission_entries.earned_on`
 * já guardava o dia da unidade, e o relatório de quem ficou sem regra filtrava
 * por `closed_at`. Dois relógios para o mesmo período, e a divergência aparecia
 * só perto da meia-noite — o horário em que barbearia fecha. Quem pegou foi um
 * teste de integração.
 */
ALTER TABLE orders ADD COLUMN business_day date;

CREATE INDEX orders_dia_da_barbearia_idx
  ON orders (location_id, business_day) WHERE status = 'paid';

-- ---------------------------------------------------------------------------
-- Configuração
-- ---------------------------------------------------------------------------

CREATE TYPE commission_base AS ENUM ('liquido', 'bruto');
CREATE TYPE commission_discount_treatment AS ENUM ('reduz_base', 'custo_da_casa');

/**
 * Uma linha por barbearia. As duas escolhas que a SPEC §3.4 exige que sejam
 * explícitas — e que, implícitas, viram a discussão de "por que caiu minha
 * comissão neste mês?".
 */
CREATE TABLE commission_settings (
  tenant_id           uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  base                commission_base NOT NULL DEFAULT 'liquido',
  discount_treatment  commission_discount_treatment NOT NULL DEFAULT 'reduz_base',
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE commission_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commission_settings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Regras
-- ---------------------------------------------------------------------------

CREATE TYPE commission_mode AS ENUM ('percent', 'fixed', 'tiers');

/**
 * As regras se sobrepõem de propósito: 40% no geral, 50% na barba, 45% na barba
 * do Ruan. Qual vale é decidido em `packages/core` pela mais específica — aqui
 * o banco só garante que cada combinação exista uma vez, senão "a mais
 * específica" teria empate e o resultado dependeria da ordem da consulta.
 */
CREATE TABLE commission_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  professional_id uuid REFERENCES professionals(id) ON DELETE CASCADE,
  service_id      uuid REFERENCES services(id) ON DELETE CASCADE,
  category_id     uuid REFERENCES service_categories(id) ON DELETE CASCADE,

  mode            commission_mode NOT NULL,
  -- Pontos-base em `percent` (4000 = 40%); centavos em `fixed`; ignorado em
  -- `tiers`. Inteiro sempre: a alíquota não podia ser a única porta de entrada
  -- de ponto flutuante num sistema que trata dinheiro como inteiro.
  value           integer NOT NULL DEFAULT 0,
  -- `[{"ateCents": 500000, "pontosBase": 4000}, {"ateCents": null, ...}]`
  tiers           jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT commission_rules_percent_ate_cem CHECK (
    mode <> 'percent' OR (value >= 0 AND value <= 10000)
  ),
  CONSTRAINT commission_rules_fixed_non_negative CHECK (mode <> 'fixed' OR value >= 0),
  CONSTRAINT commission_rules_tiers_preenchidas CHECK (
    mode <> 'tiers' OR jsonb_array_length(tiers) > 0
  )
);

ALTER TABLE commission_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commission_rules
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Uma regra por combinação. `NULLS NOT DISTINCT` porque nulo aqui **é** um
-- valor de negócio ("vale para qualquer um"), e sem isso duas regras gerais
-- conviveriam e empatariam.
CREATE UNIQUE INDEX commission_rules_combinacao_unica
  ON commission_rules (tenant_id, professional_id, service_id, category_id)
  NULLS NOT DISTINCT;

CREATE INDEX commission_rules_tenant_idx ON commission_rules (tenant_id);

-- ---------------------------------------------------------------------------
-- Fechamento
-- ---------------------------------------------------------------------------

CREATE TABLE commission_closures (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  starts_on      date NOT NULL,
  ends_on        date NOT NULL,
  closed_at      timestamptz NOT NULL DEFAULT now(),
  closed_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  closed_by_name text NOT NULL,
  notes          text,

  CONSTRAINT commission_closures_intervalo CHECK (ends_on >= starts_on)
);

ALTER TABLE commission_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_closures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commission_closures
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Dois fechamentos do mesmo período pagariam o mês duas vezes.
CREATE UNIQUE INDEX commission_closures_periodo_unico
  ON commission_closures (tenant_id, starts_on, ends_on);

/**
 * O valor congelado por profissional.
 *
 * É esta linha que responde "quanto o Ruan recebeu em setembro" — não uma soma
 * refeita sobre os lançamentos, que daria outro número no dia em que a regra
 * mudasse ou um estorno chegasse.
 */
CREATE TABLE commission_closure_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  closure_id      uuid NOT NULL REFERENCES commission_closures(id) ON DELETE CASCADE,
  professional_id uuid REFERENCES professionals(id) ON DELETE SET NULL,
  -- O nome vai junto: profissional desligado não pode apagar de quem era a
  -- comissão paga.
  professional_name text NOT NULL,
  base_cents      integer NOT NULL,
  amount_cents    integer NOT NULL
);

ALTER TABLE commission_closure_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_closure_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commission_closure_lines
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE UNIQUE INDEX commission_closure_lines_um_por_profissional
  ON commission_closure_lines (closure_id, professional_id);

-- ---------------------------------------------------------------------------
-- Lançamentos
-- ---------------------------------------------------------------------------

CREATE TABLE commission_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  order_id        uuid REFERENCES orders(id) ON DELETE SET NULL,
  order_item_id   uuid REFERENCES order_items(id) ON DELETE SET NULL,

  -- A data que decide o período. Para o estorno de uma venda antiga é **hoje**,
  -- e não a data da venda: mexer no que já foi fechado é o que a SPEC §3.4
  -- proíbe em letras.
  earned_on       date NOT NULL,

  -- Cópia da regra no momento do lançamento. Mudar a alíquota em outubro não
  -- reescreve setembro.
  rule_id         uuid REFERENCES commission_rules(id) ON DELETE SET NULL,
  mode            commission_mode NOT NULL,
  value           integer NOT NULL DEFAULT 0,
  tiers           jsonb NOT NULL DEFAULT '[]'::jsonb,

  base_cents      integer NOT NULL,
  -- 1 na venda, -1 no estorno. O valor em dinheiro é derivado, nunca gravado.
  sign            smallint NOT NULL DEFAULT 1,

  -- Nulo enquanto o período está aberto. Carimbado no fechamento, e é o que
  -- torna o lançamento imutável: quem calcula só olha os de carimbo nulo.
  closure_id      uuid REFERENCES commission_closures(id) ON DELETE RESTRICT,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT commission_entries_sinal CHECK (sign IN (1, -1)),
  CONSTRAINT commission_entries_base_non_negative CHECK (base_cents >= 0)
);

ALTER TABLE commission_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commission_entries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Um lançamento positivo por item vendido: fechar a mesma comanda duas vezes
-- não pode gerar comissão dobrada. É a mesma garantia que o bloco 18 dá para o
-- caixa, imposta pelo banco em vez de por um `if`.
CREATE UNIQUE INDEX commission_entries_um_por_item
  ON commission_entries (order_item_id) WHERE sign = 1 AND order_item_id IS NOT NULL;

-- E um estorno por item, pelo mesmo motivo.
CREATE UNIQUE INDEX commission_entries_um_estorno_por_item
  ON commission_entries (order_item_id) WHERE sign = -1 AND order_item_id IS NOT NULL;

-- A consulta que mais roda: o período aberto de um profissional.
CREATE INDEX commission_entries_abertos_idx
  ON commission_entries (tenant_id, professional_id, earned_on)
  WHERE closure_id IS NULL;

CREATE INDEX commission_entries_por_fechamento_idx
  ON commission_entries (closure_id) WHERE closure_id IS NOT NULL;

/**
 * O carimbo do fechamento é definitivo.
 *
 * `REVOKE` em vez de convenção: uma trigger poderia ser desativada e um
 * comentário não impede nada. Sem `UPDATE` e sem `DELETE`, "comissão fechada é
 * imutável" deixa de ser promessa e vira permissão — o mesmo mecanismo que
 * torna `audit_log` e `customer_ledger` append-only.
 *
 * Note que `commission_entries` **não** perde o `UPDATE`: o fechamento precisa
 * carimbar `closure_id`. O que protege o carimbo é a trigger abaixo, que recusa
 * mexer em linha já carimbada.
 */
REVOKE UPDATE, DELETE ON commission_closures FROM barbearia_app;
REVOKE UPDATE, DELETE ON commission_closure_lines FROM barbearia_app;
REVOKE DELETE ON commission_entries FROM barbearia_app;

CREATE OR REPLACE FUNCTION comissao_fechada_nao_muda() RETURNS trigger AS $$
BEGIN
  IF OLD.closure_id IS NOT NULL THEN
    RAISE EXCEPTION
      'lançamento de comissão já fechado (%). Ajuste vira lançamento novo no período aberto.',
      OLD.closure_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER commission_entries_imutavel_depois_de_fechado
  BEFORE UPDATE ON commission_entries
  FOR EACH ROW EXECUTE FUNCTION comissao_fechada_nao_muda();
