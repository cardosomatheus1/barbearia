-- ============================================================================
-- 0056 — `FiscalProvider`: configuração, nota e fila (bloco 53, SPEC §3.11)
--
-- > *"**Decisão de arquitetura:** não implementar lógica municipal no core.
-- > Criar a abstração `FiscalProvider` e delegar a um emissor terceirizado.
-- > Motivo: são ~5.500 municípios com regras próprias."*
--
-- O que este arquivo guarda é o **cadastro** e o **estado**, nunca a regra
-- municipal. Se um dia aparecer aqui uma coluna dizendo como Salvador numera
-- RPS, a decisão de arquitetura já foi perdida.
--
-- ## O certificado digital não entra
--
-- O A1 e a senha dele ficam **no emissor**, que tem obrigação regulatória de
-- guardá-los. Deste lado fica a referência opaca, exatamente como o token do
-- cartão do bloco 47 e o id de recebedor do adquirente do bloco 50 — e há
-- invariante que reprova a coluna, porque o jeito de um segredo desses acabar
-- no banco é alguém achar que "só por enquanto" resolve.
-- ============================================================================

CREATE TYPE fiscal_regime AS ENUM ('simples', 'mei', 'salao_parceiro');
/**
 * `fiscal_invoice_status`, e não `invoice_status`.
 *
 * `invoice_status` já é da fatura que a **barbearia paga à plataforma** (bloco
 * 30), e `club_invoice_status` é da mensalidade que o **cliente paga à
 * barbearia** (bloco 50). São três coisas que a língua chama de "fatura" e que
 * não são a mesma — confundi-las no schema seria confundi-las em toda consulta
 * daqui para a frente.
 */
CREATE TYPE fiscal_invoice_status AS ENUM (
  'pendente', 'processando', 'autorizada', 'cancelando', 'rejeitada', 'cancelada'
);

/**
 * A configuração fiscal da barbearia.
 *
 * Uma por unidade e não por barbearia: inscrição municipal e alíquota de ISS são
 * da **cidade**, e uma rede com loja em Salvador e loja em Lauro de Freitas
 * recolhe em duas prefeituras com códigos diferentes. Guardar no tenant faria a
 * segunda loja emitir com o município da primeira — nota errada, imposto na
 * cidade errada.
 */
CREATE TABLE fiscal_settings (
  /**
   * `RESTRICT` e não `CASCADE`: a tabela tem `REVOKE DELETE`, e ação referencial
   * roda com os direitos do dono — a cascata seria a porta que a revogação
   * existe para fechar. É a mesma lição do bloco 51, e desta vez a varredura
   * cobre as **duas** tabelas novas.
   */
  location_id     uuid PRIMARY KEY REFERENCES locations(id) ON DELETE RESTRICT,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  /** Só dígitos. É assim que o emissor recebe e é a chave de comparação. */
  cnpj            text NOT NULL,
  regime          fiscal_regime NOT NULL,
  /** Código de serviço municipal — "14.01" em quase toda cidade, mas não em todas. */
  service_code    text NOT NULL,
  /** ISS em pontos-base. O teto é 500 (5%) por LC 116/2003. */
  iss_bps         integer NOT NULL DEFAULT 0,
  /** Código IBGE, nunca o nome: "Salvador" existe em três estados. */
  municipality_ibge text NOT NULL,
  /** Inscrição municipal, quando a cidade exige. Nem toda exige. */
  municipal_registration text,

  /**
   * A referência da conta no emissor terceirizado.
   *
   * Opaca, como o `psp_recipient_id` do bloco 50. Nunca o certificado, nunca a
   * senha dele: quem tem obrigação de guardá-los é o emissor.
   */
  provider_account_id text,

  /**
   * Emissão automática ao fechar a comanda.
   *
   * Nasce **desligada**, e é o padrão conservador de sempre: ligar a emissão sem
   * o cadastro conferido produziria uma fila de notas rejeitadas na primeira
   * tarde de uso, e cada rejeição é um número de RPS queimado na prefeitura.
   */
  auto_issue      boolean NOT NULL DEFAULT false,

  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,

  CONSTRAINT fiscal_settings_cnpj_so_digitos CHECK (cnpj ~ '^[0-9]{14}$'),
  CONSTRAINT fiscal_settings_iss_no_teto CHECK (iss_bps BETWEEN 0 AND 500),
  CONSTRAINT fiscal_settings_municipio_ibge CHECK (municipality_ibge ~ '^[0-9]{7}$'),
  CONSTRAINT fiscal_settings_codigo_preenchido CHECK (length(btrim(service_code)) >= 2)
);

ALTER TABLE fiscal_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_settings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- A nota
-- ---------------------------------------------------------------------------

CREATE TABLE fiscal_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  /**
   * `RESTRICT`: a nota é documento fiscal com guarda de cinco anos. Apagar a
   * comanda levaria junto o registro de um documento que a Receita pode pedir —
   * e ação referencial roda com os direitos do dono da tabela, sem passar pelo
   * `REVOKE DELETE` logo abaixo.
   */
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,

  status          fiscal_invoice_status NOT NULL DEFAULT 'pendente',
  /** O id **no emissor**. Nulo enquanto ela nem foi enviada. */
  provider_invoice_id text,
  /** Número e série saem quando a prefeitura autoriza. */
  number          text,
  pdf_url         text,
  rejection_reason text,

  /**
   * Tudo congelado na emissão.
   *
   * A alíquota de ISS muda por decreto municipal, o regime muda quando a
   * barbearia troca de contador, e a nota de março continua valendo o que valia
   * em março. Recalcular na leitura faria um documento fiscal mudar de valor —
   * é o mesmo precedente da regra de comissão copiada no lançamento.
   */
  regime          fiscal_regime NOT NULL,
  service_cents   integer NOT NULL,
  /**
   * A parcela do profissional no Salão-Parceiro (Lei 13.352/2016).
   *
   * Zero nos outros regimes. É **o mesmo dado do split** (SPEC §3.5): sai da
   * comissão, e por isso não existe alíquota de parceiro em lugar nenhum deste
   * schema — duas fontes de verdade para o número da nota dariam um documento
   * fiscal que não bate com o que o profissional declara.
   */
  partner_cents   integer NOT NULL DEFAULT 0,
  iss_bps         integer NOT NULL,
  service_code    text NOT NULL,
  municipality_ibge text NOT NULL,

  /** Do tomador. Nulo é nota ao consumidor, que é o caso comum na barbearia. */
  customer_name   text,
  customer_document text,

  requested_at    timestamptz NOT NULL DEFAULT now(),
  authorized_at   timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text,
  created_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_by_name text NOT NULL,

  CONSTRAINT fiscal_invoices_servico_positivo CHECK (service_cents > 0),
  CONSTRAINT fiscal_invoices_parceiro_cabe CHECK (
    partner_cents >= 0 AND partner_cents <= service_cents
  ),
  CONSTRAINT fiscal_invoices_iss_no_teto CHECK (iss_bps BETWEEN 0 AND 500),
  /**
   * Autorizada **tem** número e data. Implicação, não equivalência.
   *
   * A primeira versão era `(status = 'autorizada') = (...)`, e a prova pegou:
   * cancelar uma nota autorizada passava a exigir que ela **perdesse** o número
   * e a data da autorização. É o oposto do que se quer — a nota cancelada é
   * justamente a que precisa guardar qual número foi à prefeitura e quando, e é
   * esse par que o contador procura quando pergunta o que aconteceu com a
   * numeração.
   */
  CONSTRAINT fiscal_invoices_autorizacao_coerente CHECK (
    status <> 'autorizada' OR (authorized_at IS NOT NULL AND number IS NOT NULL)
  ),
  -- Implicação pela mesma razão: o motivo da recusa continua valendo depois.
  CONSTRAINT fiscal_invoices_rejeicao_com_motivo CHECK (
    status <> 'rejeitada' OR rejection_reason IS NOT NULL
  ),
  CONSTRAINT fiscal_invoices_cancelamento_coerente CHECK (
    status <> 'cancelada' OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)
  ),
  -- Só o parceiro tem parcela de parceiro.
  CONSTRAINT fiscal_invoices_parceiro_so_no_regime CHECK (
    regime = 'salao_parceiro' OR partner_cents = 0
  )
);

ALTER TABLE fiscal_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_invoices
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Uma nota viva por comanda.
 *
 * Índice **parcial** no que não é terminal: a nota rejeitada não impede a
 * segunda tentativa — é justamente ela que a barbearia corrige e reenvia. A
 * cancelada também não: cancelar e emitir de novo é o caminho quando o valor
 * saiu errado. O que não pode é duas notas autorizadas da mesma venda, que é
 * imposto pago em dobro.
 *
 * A lista abaixo é a mesma de `ESTADOS_QUE_OCUPAM_A_VENDA`, em
 * `packages/core/src/fiscal.ts`, e há teste que compara as duas. Escrita duas
 * vezes à mão, ela já divergiu: `cancelando` estava aqui e faltava lá, e o
 * pedido de nota durante um cancelamento em voo passava pelo domínio para
 * morrer nesta constraint.
 */
CREATE UNIQUE INDEX fiscal_invoices_uma_viva_por_comanda
  ON fiscal_invoices (order_id)
  WHERE status IN ('pendente', 'processando', 'autorizada', 'cancelando');

/**
 * A fila da varredura: quem ainda não recebeu resposta da prefeitura.
 *
 * Índice parcial pela razão de sempre — depois de um ano de operação a nota
 * autorizada é a esmagadora maioria das linhas, e ela nunca mais é varrida.
 */
CREATE INDEX fiscal_invoices_em_curso_idx
  ON fiscal_invoices (requested_at)
  WHERE status IN ('pendente', 'processando');

CREATE INDEX fiscal_invoices_por_dia_idx
  ON fiscal_invoices (location_id, requested_at DESC);

/**
 * A nota autorizada é imutável, menos para cancelar.
 *
 * Ela é documento fiscal: o número foi para a prefeitura e o cliente recebeu o
 * PDF. Reescrever valor ou regime deixaria o que está no banco diferente do que
 * está no órgão — e é o banco que a barbearia consulta quando o contador
 * pergunta. Cancelar é estado, e tem data e motivo próprios.
 */
CREATE OR REPLACE FUNCTION fiscal_invoices_congelada() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'autorizada' AND NEW.status NOT IN ('autorizada', 'cancelando') THEN
    RAISE EXCEPTION 'nota autorizada só pode ir para cancelamento';
  END IF;
  /**
   * `cancelando` é o estado **em voo**, e ele existe pela lição do bloco 50.
   *
   * A trava do `FOR UPDATE` cai no commit, e a chamada ao emissor acontece fora
   * da transação — uma viagem à prefeitura, que este próprio arquivo descreve
   * como "minutos, às vezes horas". Sem o estado, dois toques em "Cancelar" leem
   * `autorizada` os dois e mandam o cancelamento duas vezes; o segundo bate
   * contra um RPS já cancelado, e o operador recebe "falhou" sobre uma nota que
   * de fato foi cancelada.
   *
   * De `cancelando` só se sai para `cancelada` — ou de volta para `autorizada`,
   * quando o emissor recusa o cancelamento.
   */
  IF OLD.status = 'cancelando' AND NEW.status NOT IN ('cancelando', 'cancelada', 'autorizada') THEN
    RAISE EXCEPTION 'nota em cancelamento só conclui ou volta a autorizada';
  END IF;
  IF OLD.status = 'cancelada' AND NEW.status <> 'cancelada' THEN
    RAISE EXCEPTION 'nota cancelada não volta';
  END IF;
  IF OLD.status IN ('autorizada', 'cancelando', 'cancelada')
     AND (OLD.service_cents <> NEW.service_cents
          OR OLD.partner_cents <> NEW.partner_cents
          OR OLD.iss_bps <> NEW.iss_bps
          OR OLD.regime <> NEW.regime
          OR OLD.number IS DISTINCT FROM NEW.number) THEN
    RAISE EXCEPTION 'o valor e o número de uma nota emitida são congelados';
  END IF;
  IF OLD.order_id <> NEW.order_id THEN
    RAISE EXCEPTION 'de qual venda é a nota é congelado';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER fiscal_invoices_congelada_trg
  BEFORE UPDATE ON fiscal_invoices
  FOR EACH ROW EXECUTE FUNCTION fiscal_invoices_congelada();

-- ---------------------------------------------------------------------------
-- Grants
--
-- `REVOKE DELETE` nas duas: a nota é documento com guarda de cinco anos, e a
-- configuração é o que explica por que a nota de março saiu com 2% de ISS.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON fiscal_settings TO barbearia_app;
    GRANT SELECT, INSERT, UPDATE ON fiscal_invoices TO barbearia_app;
    REVOKE DELETE ON fiscal_settings FROM barbearia_app;
    REVOKE DELETE ON fiscal_invoices FROM barbearia_app;
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
  'fiscal.view', 'fiscal.issue', 'fiscal.settings',
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
