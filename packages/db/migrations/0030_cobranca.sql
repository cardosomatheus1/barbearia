-- ============================================================================
-- 0030 — Fatura, régua de vencimento e o aviso que vem antes do bloqueio
--        (bloco 28, SPEC §9)
--
-- O bloco 27 deixou a assinatura com estado, período, preço contratado e
-- `past_due` no vocabulário — e nada que emitisse uma cobrança. Três lacunas
-- declaradas apontavam para cá, e as três são a mesma ausência vista de ângulos
-- diferentes: **o produto sabia quanto cobrar e não sabia cobrar**.
--
-- ## Por que fatura, e não um campo `pago_ate` na assinatura
--
-- Porque a pergunta que o dono faz não é "estou em dia?", é "por que me
-- cobraram isso?". Uma coluna de data responde à primeira e é muda na segunda.
-- A fatura guarda o período, o plano, o valor e o motivo — e o rateio da troca
-- de plano só existe como linha de fatura: sem ela, subir de plano no dia 16
-- viraria uma cobrança sem explicação no extrato do cartão.
--
-- É também o que torna o bloco 29 possível sem reescrever nada: o PSP concilia
-- contra um documento com identidade e valor, não contra o estado de uma
-- assinatura.
--
-- ## O bloqueio deixa de ser só manual
--
-- Até aqui a barbearia só saía do ar por decisão de alguém no painel. A régua
-- passa a bloquear sozinha 21 dias depois do vencimento — e é justamente por
-- ela existir que o aviso prévio passa a existir também. Bloqueio automático
-- sem aviso escrito seria o corte no dia seguinte ao boleto atrasado, que é o
-- comportamento que este produto vende contra.
-- ============================================================================

/**
 * `open` está em cobrança; `paid` foi quitada; `void` foi cancelada por quem
 * emitiu — erro de emissão, cortesia, acordo comercial.
 *
 * Não há `uncollectible`. Fatura que não foi paga em três semanas continua
 * `open` com a barbearia bloqueada: "incobrável" é uma decisão contábil que
 * ninguém tomou ainda, e inventar o estado agora produziria uma dívida que some
 * da tela sem ninguém ter perdoado nada.
 */
CREATE TYPE invoice_status AS ENUM ('open', 'paid', 'void');

/**
 * O que originou a fatura.
 *
 * `subscription` é a mensalidade do período; `proration` é o acerto da troca de
 * plano no meio do período. Separados porque só a primeira é recorrente — a
 * régua de vencimento e a retentativa valem para as duas, mas a emissão
 * automática do próximo período só olha a primeira.
 */
CREATE TYPE invoice_kind AS ENUM ('subscription', 'proration');

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  kind          invoice_kind NOT NULL DEFAULT 'subscription',
  status        invoice_status NOT NULL DEFAULT 'open',

  /**
   * O plano e o preço **da fatura**, copiados na emissão.
   *
   * Mesma decisão do preço congelado da assinatura (bloco 27) e da regra de
   * comissão (bloco 19): o documento guarda o que valia quando foi emitido.
   * Ler o plano da assinatura na hora de exibir faria a fatura de março mudar
   * de valor quando a barbearia trocasse de plano em abril.
   */
  plan_code     text NOT NULL REFERENCES plans(code) ON DELETE RESTRICT,
  amount_cents  integer NOT NULL CHECK (amount_cents >= 0),

  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  due_at        timestamptz NOT NULL,

  /**
   * O contador da régua.
   *
   * Começa em 1 porque a emissão **é** a primeira cobrança. A escada de
   * retentativa vive em `packages/core/src/cobranca.ts` e indexa por
   * `attempts - 1`; guardar o número aqui é o que permite a régua ser
   * reentrante — rodar duas vezes no mesmo dia não adianta a escada.
   */
  attempts      integer NOT NULL DEFAULT 1 CHECK (attempts >= 0),
  last_attempt_at timestamptz,

  /** Quando o aviso de vencimento próximo saiu. NULL = ainda não saiu. */
  notified_at   timestamptz,
  /** Quando a fatura passou de `open no prazo` para `open vencida`. */
  past_due_at   timestamptz,

  paid_at       timestamptz,
  /**
   * Como foi paga. Texto livre e curto porque o bloco 29 é quem traz o PSP;
   * até lá o valor real é `manual`, que é o que o Super Admin registra quando
   * confere o extrato.
   */
  paid_method   text,
  voided_at     timestamptz,
  void_reason   text,

  /**
   * A chave do `Idempotency-Key` que originou a cobrança, quando veio de um
   * POST.
   *
   * A régua não preenche: ela é idempotente pelo índice do período, e uma chave
   * ali não teria de onde vir. Quem preenche é a troca de plano pelo dono, que
   * é o POST deste bloco que move dinheiro.
   *
   * **Escopada por operador antes de chegar aqui.** A chave vem do cliente e é
   * livre; duas pessoas com `settings.manage` mandando `"1"` colidiriam, e a
   * segunda receberia de volta o acerto da primeira.
   */
  idempotency_key text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoices_periodo_valido CHECK (period_end > period_start),
  /**
   * O vencimento não pode ser antes do período que ele cobra.
   *
   * Sem isto, uma emissão com data errada nasceria vencida e a régua a levaria
   * ao bloqueio na primeira volta — a barbearia sairia do ar por um erro de
   * digitação de quem emitiu.
   */
  CONSTRAINT invoices_vencimento_valido CHECK (due_at >= period_start),
  /**
   * Estado terminal exige a data que o explica, e o contrário também.
   *
   * `paid` sem `paid_at` é uma fatura que ninguém sabe quando foi paga; e
   * `paid_at` preenchido com status `open` é o pior dos dois — a régua
   * continuaria cobrando algo que já foi pago.
   */
  CONSTRAINT invoices_paga_tem_data CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CONSTRAINT invoices_cancelada_tem_motivo CHECK (
    (status = 'void') = (voided_at IS NOT NULL AND void_reason IS NOT NULL)
  )
);

/**
 * Uma fatura de mensalidade por período, e é o que torna a emissão idempotente.
 *
 * A régua roda todo dia e pode rodar duas vezes no mesmo dia (worker
 * reiniciado, tarefa reentregue). Sem o índice, a segunda volta emitiria a
 * segunda fatura do mesmo mês — e a barbearia pagaria duas vezes. Quem garante
 * é o banco, não um `SELECT` antes do `INSERT`, que tem janela de corrida.
 *
 * Parcial em `subscription`: o acerto de rateio é por evento, e trocar de plano
 * duas vezes no mesmo período gera duas linhas legítimas.
 */
CREATE UNIQUE INDEX invoices_uma_por_periodo
  ON invoices (tenant_id, period_start) WHERE kind = 'subscription';

/**
 * A repetição do mesmo POST não vira a segunda cobrança.
 *
 * Por barbearia e não global: a chave vem do cliente e é livre, então
 * `(tenant_id, chave)` é o par que a torna única sem que uma barbearia consiga
 * bloquear a chave de outra escolhendo `"1"`.
 */
CREATE UNIQUE INDEX invoices_idempotencia
  ON invoices (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

/** A varredura da régua pergunta "o que está aberto e vence antes de quando?". */
CREATE INDEX invoices_em_cobranca ON invoices (due_at) WHERE status = 'open';

/** A tela do dono e a da plataforma listam por barbearia, da mais nova. */
CREATE INDEX invoices_por_barbearia ON invoices (tenant_id, created_at DESC);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;

/**
 * A barbearia lê **as próprias** faturas; a plataforma lê todas.
 *
 * Mais estrito do que `subscriptions`, que abriu `USING (true)` por não guardar
 * nada além de plano e preço de tabela. Aqui há histórico de pagamento com data
 * e método, e um extrato é informação de negócio de quem o recebeu — vazá-lo
 * para as outras barbearias do produto não custaria nada a mais para entregar e
 * é exatamente o tipo de coisa que ninguém consegue desfazer depois.
 *
 * Escrita só sem tenant: fatura é emitida pela plataforma. Uma barbearia que
 * pudesse escrever aqui se daria baixa sozinha.
 *
 * **O `NULLIF` no segundo ramo não é enfeite.** `OR` não garante curto-circuito
 * em SQL: o planejador pode avaliar o segundo lado primeiro, e sem o `NULLIF`
 * ele tenta `''::uuid` numa conexão sem tenant. O erro é `22P02` e aparece só
 * às vezes — conforme o plano —, que é a pior forma de um defeito aparecer. É a
 * mesma escrita da política `tenant_isolation` do bloco 1, e é por isso que ela
 * é escrita assim lá.
 */
CREATE POLICY invoices_leitura ON invoices FOR SELECT USING (
  NULLIF(current_setting('app.tenant_id', true), '') IS NULL
  OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY invoices_escrita ON invoices FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON invoices TO barbearia_app;
  END IF;
END $$;

/**
 * O crédito que sobra quando a barbearia desce de plano.
 *
 * Fica na assinatura e não numa fatura de valor negativo: fatura negativa é um
 * documento que ninguém sabe pagar, e o extrato do cartão não tem linha para
 * ela. O saldo abate a **próxima** emissão, que é como o dono espera que
 * funcione — "paguei o Business até o dia 20, desci para o Pro, o mês que vem
 * vem mais barato".
 *
 * Em centavos inteiros e nunca negativo, como todo dinheiro deste schema.
 */
ALTER TABLE subscriptions
  ADD COLUMN credit_cents integer NOT NULL DEFAULT 0 CHECK (credit_cents >= 0);

-- ---------------------------------------------------------------------------
-- A trilha da régua
-- ---------------------------------------------------------------------------

/**
 * `platform_audit.admin_id` é anulável desde o bloco 24, e é aqui que isso
 * ganha uso: a régua não tem gente por trás.
 *
 * Bloqueio automático **é** evento auditado — talvez o mais importante deles,
 * porque é o único que tira uma empresa do ar sem ninguém ter clicado. Sem a
 * linha, a resposta ao dono que liga perguntando por que a agenda sumiu seria
 * "não sei".
 *
 * Nada aqui além do comentário: a coluna já existe e a política já é a certa.
 * O que muda é que passa a haver quem escreva com `admin_id` nulo, e o índice
 * por tenant já cobre a consulta.
 */
