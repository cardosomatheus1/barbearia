-- ============================================================================
-- 0052 — Split de pagamento: a modelagem (bloco 49, SPEC §3.5)
--
-- ```
-- Pagamento           R$ 100,00
-- ├── Barbearia       R$  55,00
-- ├── Profissional    R$  40,00
-- └── Plataforma      R$   5,00
-- ```
--
-- ## A frase que decide o desenho inteiro
--
-- *"Split é **derivado da comissão**, nunca configurado em paralelo — duas
-- fontes de verdade para o mesmo número é bug garantido."*
--
-- É a mesma lei do bloco 42 (a venda de pacote sai dos itens da comanda, nunca
-- de uma lista no corpo) e a razão pela qual não existe aqui nenhuma tabela de
-- "percentual do split": o que o profissional recebe é a comissão dele, lida de
-- `commission_entries`. Se um dia os dois números divergirem, é porque alguém
-- criou a segunda fonte.
--
-- ## Por que a linha guarda o valor, se ele é derivado
--
-- Porque **saiu dinheiro**. Em toda parte deste código o valor é derivado da
-- base — comissão, faixa, modelo de assinatura —, e aqui é o contrário: o
-- adquirente já mandou os centavos para três contas diferentes, e o que a linha
-- registra é o que **de fato** foi transferido. Recalcular na leitura faria o
-- extrato divergir do banco do profissional, que é a única coisa que ele
-- confere.
--
-- ## A soma das partes é o pagamento, sempre
--
-- Não é preciosismo contábil: um centavo a mais é dinheiro que o adquirente não
-- tem, e a chamada inteira é recusada por ele. Um centavo a menos fica preso na
-- conta da plataforma para sempre. Há `CHECK` no banco e teste de domínio.
-- ============================================================================

/**
 * O estado de **cada parte**, e não do split inteiro.
 *
 * A SPEC pede isso em letras — *"`payment_splits` como tabela própria, com
 * status por parte"* — e o motivo aparece no primeiro dia de operação: o
 * profissional sem KYC aprovado não recebe, e a parte dele fica retida enquanto
 * as outras duas liquidam normalmente. *"Enquanto pendente, o pagamento cai
 * integralmente na barbearia e a comissão é paga fora, sem bloquear a venda."*
 */
CREATE TYPE split_status AS ENUM (
  'pendente',
  /** Sem recebedor no adquirente: o valor foi para a barbearia (bloco 50). */
  'retido',
  'liquidado',
  'falhou',
  'estornado'
);

CREATE TYPE split_party AS ENUM ('barbearia', 'profissional', 'plataforma');

CREATE TABLE payment_splits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  /**
   * `RESTRICT`, e não `CASCADE`.
   *
   * `payment_splits` tem `REVOKE DELETE` logo abaixo, e ação referencial roda
   * com os direitos do **dono da tabela**: ela não passa pela revogação. Um
   * `CASCADE` aqui seria a porta lateral que o bloco 43 já achou em `reviews` e
   * o 47 em `club_invoices` — apagar a venda levaria junto o registro do
   * dinheiro que já saiu para a conta de um terceiro, sem trilha e sem erro.
   *
   * Achado da `/security-review` deste bloco, e ele foi específico: `orders` é a
   * única das duas pontas em que a aplicação **de fato** tem `DELETE`.
   */
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  /**
   * A cobrança de onde o dinheiro veio.
   *
   * Obrigatória: split é repartição de um pagamento que passou pelo **nosso**
   * adquirente. Venda paga na maquininha da barbearia não tem o que repartir —
   * o dinheiro nunca esteve conosco — e é por isso que esta coluna não é nula
   * em vez de o split existir "para toda venda".
   */
  charge_id       uuid NOT NULL REFERENCES order_charges(id) ON DELETE RESTRICT,

  party           split_party NOT NULL,
  /** Preenchido só quando a parte é de um profissional. */
  professional_id uuid REFERENCES professionals(id) ON DELETE SET NULL,

  amount_cents    integer NOT NULL,
  status          split_status NOT NULL DEFAULT 'pendente',

  /** O id do repasse no adquirente, quando ele responde (bloco 50). */
  psp_transfer_id text,
  settled_at      timestamptz,
  /** O motivo da falha, para o balcão poder explicar. */
  last_error      text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_splits_valor_nao_negativo CHECK (amount_cents >= 0),
  /**
   * Parte de profissional tem profissional; as outras duas não têm.
   *
   * Sem isto, uma parte da plataforma com `professional_id` preenchido apareceria
   * no extrato do barbeiro como dinheiro que ele não recebeu — e o inverso, uma
   * parte de profissional sem dono, seria repasse para ninguém.
   */
  CONSTRAINT payment_splits_dono_coerente CHECK (
    (party = 'profissional') = (professional_id IS NOT NULL)
  ),
  /**
   * Liquidado tem data — mas a recíproca **não** vale.
   *
   * A primeira versão era uma equivalência, e ela quebrava no estorno: uma parte
   * repassada que depois é desfeita vira `estornado` e continua tendo a data em
   * que o dinheiro saiu. Esse fato não deixa de ser verdade porque a venda foi
   * desfeita — pelo contrário, é exatamente o que a dívida do bloco 50 precisa
   * saber ("saiu no dia 12"). Foi o teste do estorno que pegou.
   */
  CONSTRAINT payment_splits_liquidacao_coerente CHECK (
    status <> 'liquidado' OR settled_at IS NOT NULL
  ),
  CONSTRAINT payment_splits_transferencia_nao_vazia CHECK (
    psp_transfer_id IS NULL OR length(btrim(psp_transfer_id)) > 0
  )
);

ALTER TABLE payment_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_splits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_splits
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Uma parte por cobrança, por papel e por profissional.
 *
 * É o que torna a derivação idempotente: o webhook do adquirente reentrega, e
 * sem este índice a mesma confirmação criaria a segunda cópia de cada parte —
 * o profissional receberia duas vezes, e a soma das partes deixaria de ser o
 * pagamento.
 *
 * `coalesce` porque `professional_id` é nulo nas outras duas partes, e no
 * Postgres nulo não colide com nulo num índice único.
 */
CREATE UNIQUE INDEX payment_splits_uma_por_parte
  ON payment_splits (
    charge_id,
    party,
    coalesce(professional_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

/** A fila de liquidação do bloco 50: "o que ainda não foi repassado?". */
CREATE INDEX payment_splits_pendentes_idx ON payment_splits (created_at)
  WHERE status IN ('pendente', 'falhou');

/**
 * O extrato do profissional.
 *
 * Por `order_id` junto porque a leitura do período junta com `orders` para ler o
 * `business_day` — o dia de uma venda é o dia **da unidade**, e `created_at`
 * responde "que instante o adquirente confirmou", que às 22h de Salvador já é o
 * dia seguinte em UTC.
 */
CREATE INDEX payment_splits_do_profissional_idx
  ON payment_splits (professional_id, order_id)
  WHERE professional_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- O interruptor e a alíquota da plataforma
--
-- *"Arquitetura preparada desde o início, mesmo que ativada só no Release 3."*
-- O split nasce **desligado**, e é a regra deste código: padrão de configuração
-- que mexe em dinheiro é sempre o comportamento anterior. Ligado por omissão,
-- toda barbearia já instalada veria a próxima venda ser repartida sem ninguém
-- ter decidido nada — e o profissional receberia direto do adquirente uma
-- quantia que a casa achava que ia pagar no fim do mês.
-- ---------------------------------------------------------------------------

ALTER TABLE tenants
  ADD COLUMN split_enabled boolean NOT NULL DEFAULT false;

/**
 * A comissão da plataforma mora em `tenant_platform`, **não** em `tenants`.
 *
 * Achado da `/security-review` deste bloco, e a distinção é de princípio: quem
 * decide se o adquirente paga o barbeiro direto é a **barbearia** — é o dinheiro
 * dela, e `split_enabled` fica com ela. Quanto o produto cobra por transação é
 * termo comercial da **plataforma**, e a primeira versão o pôs numa coluna de
 * `tenants`, editável pela rota do painel da barbearia: o cliente definia o preço
 * que paga, e zerá-lo desligava a receita sem nada falhar.
 *
 * `tenant_platform` é onde os outros termos comerciais já moram (`plan_id`, o
 * bloqueio), é escrita só por `packages/platform` atrás da sessão de Super Admin,
 * e não tem RLS — a barbearia nem a enxerga. É a mesma separação que o
 * `@AgeNaConta` do bloco 33 faz na borda.
 */
ALTER TABLE tenant_platform
  ADD COLUMN platform_fee_bps integer NOT NULL DEFAULT 0;

ALTER TABLE tenant_platform ADD CONSTRAINT tenant_platform_taxa_valida CHECK (
  platform_fee_bps BETWEEN 0 AND 3000
);

-- ---------------------------------------------------------------------------
-- Grants
--
-- `REVOKE DELETE` pelo mesmo motivo de `commission_entries` e de
-- `club_invoices`: a linha é registro de dinheiro que saiu para a conta de
-- terceiro. Desfazer um repasse é **estado** (`estornado`), com o valor e a data
-- intactos — nunca `DELETE`.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON payment_splits TO barbearia_app;
    REVOKE DELETE ON payment_splits FROM barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- A permissão nova no catálogo do banco
--
-- `role_permissions` tem `CHECK` com a lista inteira desde o bloco 16, e há
-- teste que a compara com `packages/core`. Sem esta linha a permissão existe no
-- código e é recusada pelo banco — e a tela de papéis não consegue concedê-la.
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
