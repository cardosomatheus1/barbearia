-- ============================================================================
-- 0050 — Cobrança recorrente do clube (bloco 47, SPEC §4.6)
--
-- O bloco 45 vendeu o plano e o 46 desenhou o benefício. Faltava a parte que
-- decide se o dinheiro entra: *"Retentativas automáticas em régua (D+1, D+3,
-- D+7). Suspensão de benefício é gradual e avisada — cortar o acesso no primeiro
-- erro de cartão gera cancelamento por raiva, não por preço."*
--
-- ## Por que a fatura é tabela, e não um `paid_until` na assinatura
--
-- Uma coluna de "pago até" responde *se*, e a pergunta que chega no balcão é
-- *por quê*: "por que o meu plano parou?", "vocês tentaram cobrar quantas
-- vezes?", "eu paguei em março?". Cada ciclo vira uma linha com o valor
-- **congelado na emissão**, e o histórico é o extrato.
--
-- É a mesma razão de `club_uses` ser tabela e não contador, e a mesma de
-- `package_uses`: o **quando** de cada fato é a informação.
--
-- ## O valor é congelado, como em toda parte deste produto
--
-- A barbearia sobe o Premium de R$ 149 para R$ 169 em março. A fatura de
-- fevereiro continua sendo de R$ 149 — recalculá-la na leitura mudaria um mês
-- fechado sozinho, que é o defeito que a regra de comissão copiada, a taxa do
-- adquirente congelada e o preço da adesão já evitam cada uma no seu canto.
-- ============================================================================

CREATE TYPE club_invoice_status AS ENUM ('aberta', 'paga', 'cancelada');

CREATE TABLE club_invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  /**
   * `RESTRICT`, e não `CASCADE`.
   *
   * A fatura é registro de dinheiro, e ela tem `REVOKE DELETE` logo abaixo. Um
   * `CASCADE` aqui seria a porta lateral que o bloco 43 já achou uma vez: apagar
   * o pai leva o filho junto **sem** passar pela permissão que protege o filho.
   * Se um dia alguém precisar apagar uma assinatura com fatura, é para dar erro.
   */
  subscription_id      uuid NOT NULL REFERENCES club_subscriptions(id) ON DELETE RESTRICT,

  -- O ciclo coberto, semiaberto [início, fim) como todo intervalo do produto.
  period_start         timestamptz NOT NULL,
  period_end           timestamptz NOT NULL,

  amount_cents         integer NOT NULL,
  status               club_invoice_status NOT NULL DEFAULT 'aberta',

  /**
   * O vencimento é o **primeiro dia do ciclo**, porque a cobrança é adiantada.
   *
   * Cobrar depois de entregar transformaria o mês inteiro em crédito: o cliente
   * corta quatro vezes, some, e a casa fica com uma fatura para perseguir. É o
   * mesmo raciocínio da régua da plataforma (bloco 28), onde escrever o inverso
   * produzia catorze dias grátis mais uma fatura pelos catorze dias.
   */
  due_at               timestamptz NOT NULL,

  /** Cobranças **feitas**, contando a do vencimento — ela não é retentativa. */
  attempts             smallint NOT NULL DEFAULT 0,
  last_attempt_at      timestamptz,
  /** O motivo da última recusa, para o balcão poder explicar. Sem PAN, sem CVV. */
  last_error           text,
  /**
   * Por que a casa perdoou esta mensalidade.
   *
   * Coluna própria, e não `last_error` reaproveitado — que foi a primeira versão
   * e um achado da `/security-review`. São dois fatos diferentes: um é o que o
   * adquirente respondeu, o outro é uma **anotação interna** escrita pelo balcão
   * sob permissão de dinheiro. `last_error` viaja para a tela do assinante no
   * self-service; esta não viaja para lugar nenhum além do balcão, e é por isso
   * que ela precisa de nome próprio: "perdoado, cliente ameaçou ir ao Procon" é
   * exatamente o tipo de frase que alguém escreve sem imaginar que o titular vai
   * lê-la.
   */
  void_reason          text,
  /**
   * A última recusa foi definitiva? (cartão cancelado, conta encerrada)
   *
   * Guardada porque a régua roda amanhã sem lembrar de hoje. Contra um cartão
   * que não existe mais, D+1, D+3 e D+7 são três chamadas que já sabem a
   * resposta — e cada recusa registrada piora a taxa de aprovação da conta da
   * barbearia, que é o número pelo qual o adquirente a precifica.
   */
  last_definitive      boolean NOT NULL DEFAULT false,

  marked_delinquent_at timestamptz,

  paid_at              timestamptz,
  paid_method          text,

  /**
   * A cobrança no adquirente, quando existe.
   *
   * Só é escrita enquanto é nula, e string vazia não é nula: ela amarraria a
   * fatura a nada para sempre. É a lição da migração 0036, e a `CHECK` abaixo é
   * a mesma.
   */
  psp_charge_id        text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT club_invoices_valor_positivo CHECK (amount_cents > 0),
  CONSTRAINT club_invoices_ciclo_valido CHECK (period_end > period_start),
  CONSTRAINT club_invoices_tentativas_nao_negativas CHECK (attempts >= 0),
  CONSTRAINT club_invoices_pagamento_coerente CHECK (
    (status = 'paga') = (paid_at IS NOT NULL)
  ),
  CONSTRAINT club_invoices_charge_nao_vazio CHECK (
    psp_charge_id IS NULL OR length(btrim(psp_charge_id)) > 0
  )
);

ALTER TABLE club_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON club_invoices
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Uma fatura por ciclo.
 *
 * É o que torna a emissão idempotente sem chave de idempotência: o worker roda
 * a cada volta do laço, e sem este índice ele emitiria uma fatura por rodada —
 * cobrando o assinante dezenas de vezes pelo mesmo mês. A recusa é do banco e
 * não de um `SELECT` antes do `INSERT`, que tem janela de corrida.
 */
CREATE UNIQUE INDEX club_invoices_uma_por_ciclo
  ON club_invoices (subscription_id, period_start);

/** A varredura da régua: "quem venceu e ainda está em aberto?". */
CREATE INDEX club_invoices_abertas_idx ON club_invoices (due_at)
  WHERE status = 'aberta';

CREATE INDEX club_invoices_da_assinatura_idx
  ON club_invoices (subscription_id, period_start DESC);

-- ---------------------------------------------------------------------------
-- O cartão na assinatura
--
-- Token do provedor, bandeira e os quatro últimos — o mesmo que `billing_
-- customers` guarda desde o bloco 29, e pelo mesmo motivo: não existe coluna
-- para PAN nem para CVV, então elas não são preenchidas por engano.
--
-- A validade entra, e é uma **exceção escrita**: `order_charges` recusa
-- `exp_month`/`exp_year` porque lá o cartão é do cliente presente e a cobrança
-- termina em segundos. Aqui a validade é o dado que a SPEC pede em §4.6 —
-- *"aviso de cartão prestes a vencer, 15 dias antes"* —, e ela é o único motivo
-- de cancelamento involuntário que o cliente conserta em trinta segundos se
-- souber a tempo. Mês e ano não cobram nada sozinhos.
-- ---------------------------------------------------------------------------

ALTER TABLE club_subscriptions
  ADD COLUMN payment_token   text,
  ADD COLUMN card_brand      text,
  ADD COLUMN card_last4      text,
  ADD COLUMN card_exp_month  smallint,
  ADD COLUMN card_exp_year   smallint,
  ADD COLUMN card_warned_at  timestamptz,
  ADD COLUMN suspended_at    timestamptz;

ALTER TABLE club_subscriptions ADD CONSTRAINT club_subscriptions_cartao_valido CHECK (
  (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$')
  AND (card_exp_month IS NULL OR card_exp_month BETWEEN 1 AND 12)
  AND (card_exp_year IS NULL OR card_exp_year BETWEEN 2020 AND 2100)
  AND (payment_token IS NULL OR length(btrim(payment_token)) > 0)
);

ALTER TABLE club_subscriptions ADD CONSTRAINT club_subscriptions_suspensao_coerente CHECK (
  (status = 'suspensa') = (suspended_at IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- O cancelamento self-service
--
-- *"Cancelamento self-service obrigatório."* — SPEC §4.6, e não é gentileza: o
-- clube que só cancela por telefone é o clube que vira reclamação no Procon e
-- estorno no cartão, que custa mais que o mês que ele tentou segurar.
--
-- Duas colunas e não uma: **quando pediu** é o fato, e **até quando vale** é a
-- promessa. A segunda é congelada na hora do pedido porque o cliente vai ler a
-- mesma data amanhã — derivá-la na leitura faria "seu plano vale até 30/08"
-- virar outra data se alguém mexer na adesão.
--
-- O estado continua `ativa` até lá, e é isso que faz o benefício ser entregue
-- até o fim do ciclo pago: cortar no dia do pedido seria ficar com o dinheiro
-- do mês e não entregar o serviço.
-- ---------------------------------------------------------------------------

ALTER TABLE club_subscriptions
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN cancel_effective_at timestamptz;

ALTER TABLE club_subscriptions ADD CONSTRAINT club_subscriptions_cancelamento_agendado CHECK (
  (cancel_requested_at IS NULL) = (cancel_effective_at IS NULL)
);

-- ---------------------------------------------------------------------------
-- Grants
--
-- `REVOKE DELETE` na fatura pelo mesmo motivo de `club_uses` e do razão de
-- fidelidade: "por que vocês me cobraram em março?" é a pergunta, e a linha é a
-- resposta. Cancelar uma fatura é **estado** (`cancelada`), com o valor e a data
-- intactos — nunca `DELETE`.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON club_invoices TO barbearia_app;
    REVOKE DELETE ON club_invoices FROM barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- `anonimizar_cliente` apaga o cartão salvo junto com a assinatura
--
-- Achado da `/security-review` deste bloco. O resto da função é a do bloco 45
-- copiada sem alteração — a cópia é do arquivo, sempre.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION anonimizar_cliente(p_customer uuid, p_motivo text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  v_apelido text;
  v_telefone text;
BEGIN
  /**
   * Sem tenant no contexto a função não roda.
   *
   * É a diferença entre "anonimize este cliente da barbearia X" e "anonimize
   * este uuid, onde quer que ele esteja". A segunda seria uma porta para apagar
   * cadastro alheio conhecendo só o id — e `SECURITY DEFINER` a abriria de par
   * em par, porque aqui dentro a RLS pode não estar valendo.
   */
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'anonimizar_cliente exige app.tenant_id no contexto';
  END IF;

  IF length(btrim(coalesce(p_motivo, ''))) < 3 THEN
    RAISE EXCEPTION 'anonimizar_cliente exige motivo escrito';
  END IF;

  -- O `FOR UPDATE` fecha a corrida entre a varredura de retenção e alguém
  -- atendendo o pedido de exclusão pela tela no mesmo instante: a segunda
  -- transação espera, relê `anonymized_at` preenchido e devolve `false`.
  -- O telefone é lido **antes** de ser apagado: ele é a chave de
  -- `otp_challenges`, e sem guardá-lo aqui não haveria como limpar aquela linha
  -- depois.
  SELECT phone_e164 INTO v_telefone
    FROM public.customers
   WHERE id = p_customer AND tenant_id = v_tenant AND anonymized_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_apelido := 'cliente_anonimizado_' || substring(replace(p_customer::text, '-', '') from 1 for 4);

  UPDATE public.customers
     SET name = v_apelido,
         phone_e164 = NULL,
         birth_date = NULL,
         accepts_marketing = false,
         marketing_consent_ip = NULL,
         -- O par do IP, e ele ficava para trás. A invariante de catálogo que
         -- este bloco criou foi quem o encontrou: `accepts_marketing` já virava
         -- `false`, então o carimbo dizia "esta pessoa consentiu às 14h22" sobre
         -- um consentimento que não vale mais. A prova de verdade é o histórico
         -- append-only de `customer_consents`, que continua intacto — isto aqui
         -- é espelho derivado, e espelho de dado apagado é dado apagado.
         marketing_consent_at = NULL,
         marketing_consent_version = NULL,
         -- Bloco 37. O motivo do override é texto livre escrito por um gerente
         -- **sobre uma pessoa**, e os exemplos deste repositório são "faltou
         -- por internação" e "sumiu com a chave da barbearia": dado de saúde e
         -- imputação de crime. Sobreviver à anonimização faria a função apagar
         -- o nome e guardar a narrativa — com carimbo de hora, que sozinho já
         -- reidentifica. Achado da `/security-review` do bloco 37, e é o mesmo
         -- defeito que `otp_challenges` teve no bloco 32.
         reliability_override = NULL,
         reliability_override_reason = NULL,
         reliability_override_at = NULL,
         anonymized_at = now(),
         updated_at = now()
   WHERE id = p_customer AND tenant_id = v_tenant;

  UPDATE public.customer_consents
     SET ip = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  UPDATE public.customer_ledger
     SET note = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  UPDATE public.customer_preferences
     SET maquina_laterais = NULL, tipo_degrade = NULL, topo = NULL,
         barba_estilo = NULL, produtos_evitar = NULL, observacoes = NULL,
         updated_at = now()
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  UPDATE public.queue_entries
     SET notes = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  /**
   * A lista de espera fecha junto (bloco 38).
   *
   * Não é dado pessoal — são datas, uma faixa de horas e uma duração —, e por
   * isso a linha fica. O que não pode ficar é o estado **vivo**: uma entrada
   * `waiting` continuaria concorrendo a toda vaga que abrisse, e o balcão veria
   * "cliente_anonimizado_a3f1" na lista de quem chamar, sem telefone para
   * chamar. A pessoa pediu justamente para sair.
   *
   * Mora aqui e não na camada de cima porque o princípio desta função é ser o
   * caminho **único**: quem chamar o SQL direto — a varredura de retenção, uma
   * correção manual — também precisa fechar a lista.
   */
  UPDATE public.waitlist_entries
     SET status = 'left', closed_at = now(), updated_at = now()
   WHERE customer_id = p_customer AND tenant_id = v_tenant AND status = 'waiting';

  UPDATE public.appointments
     SET notes = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  UPDATE public.notifications
     SET phone_masked = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  /**
   * A sessão do navegador é credencial viva, não histórico.
   *
   * Apagada e não revogada: revogar deixaria `ip` e `user_agent` na tabela, que
   * são dado pessoal, e a linha não serve para nada depois disso — a trilha do
   * que essa pessoa fez está em `appointments` e `orders`.
   */
  DELETE FROM public.customer_sessions
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  /**
   * O desafio de OTP daquele número, inteiro.
   *
   * A tabela guarda o telefone em claro e o nome pendente, e `verifyOtp`
   * reaproveita o nome ao criar o cadastro. Deixá-la faria a pessoa entrar de
   * novo com o número antigo e reaparecer com o **nome verdadeiro**.
   */
  IF v_telefone IS NOT NULL THEN
    DELETE FROM public.otp_challenges
     WHERE tenant_id = v_tenant AND phone_e164 = v_telefone;
  END IF;

  /**
   * O recado perde o dono e continua existindo (bloco 40).
   *
   * As duas coisas são verdadeiras ao mesmo tempo: a pessoa tem direito a sair,
   * e a barbearia precisa continuar sabendo que a cadeira do fundo está bamba.
   * Apagar perderia a melhoria — e nem seria possível, porque a tabela não tem
   * `DELETE` para a aplicação. Manter o vínculo manteria a pessoa identificada
   * por um texto que ela mesma escreveu, e que pode dizer o nome dela.
   *
   * O que se desata é o vínculo. O texto fica órfão, e é o que se quer.
   */
  UPDATE public.feedbacks
     SET customer_id = NULL, updated_at = now()
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  /**
   * A avaliação perde o autor e o texto, e a nota fica (bloco 43).
   *
   * A nota é fato do negócio: a média da casa e o indicador do barbeiro foram
   * calculados com ela, e apagá-la reescreveria a história do trabalho de outra
   * pessoa — que não pediu para sair de lugar nenhum. O comentário sai junto do
   * vínculo porque é texto livre, e é onde a pessoa pode ter escrito o próprio
   * nome.
   *
   * É a mesma decisão do razão do cliente: a linha e os números ficam, a pessoa
   * sai de dentro deles. E o gatilho de imutabilidade não atrapalha: esta função
   * roda como dona da tabela, e o gatilho recusaria a mudança do comentário.
   */
  ALTER TABLE public.reviews DISABLE TRIGGER reviews_nota_imutavel;
  UPDATE public.reviews
     SET customer_id = NULL, comment = NULL
   WHERE customer_id = p_customer AND tenant_id = v_tenant;
  ALTER TABLE public.reviews ENABLE TRIGGER reviews_nota_imutavel;

  /**
   * A assinatura de quem saiu é cancelada (bloco 45).
   *
   * Ela não pode ficar viva: uma assinatura `ativa` continuaria contando no MRR
   * e dando cota de corte a um cadastro que a pessoa pediu para apagar — e a
   * cobrança recorrente do bloco 47 tentaria cobrar um cartão de alguém que não
   * é mais cliente.
   *
   * O **uso** fica, com o vínculo intacto: ele é fato do negócio, e a
   * rentabilidade do plano foi calculada com ele. Quem sai de dentro dele é o
   * cliente, pela chave estrangeira da assinatura.
   */
  UPDATE public.club_subscriptions
     SET status = 'cancelada', cancelled_at = now(),
         cancel_reason = 'anonimizacao do titular',
         /**
          * O cartão salvo sai junto, e é o conserto de um buraco de verdade.
          *
          * O comentário acima já dizia o que aconteceria — "a cobrança
          * recorrente do bloco 47 tentaria cobrar um cartão de alguém que não é
          * mais cliente" — e o bloco 47 criou as colunas sem fechar a ponta.
          * Achado da `/security-review`: a fatura já emitida continuava em
          * aberto, e a régua da madrugada apresentaria o token ao adquirente por
          * mais quinze dias. Sem ninguém saber, porque o telefone já foi apagado
          * e o aviso não teria para onde ir.
          *
          * Credencial de pagamento é como token de sessão: some com a pessoa.
          */
         payment_token = NULL, card_brand = NULL, card_last4 = NULL,
         card_exp_month = NULL, card_exp_year = NULL, card_warned_at = NULL,
         updated_at = now()
   WHERE customer_id = p_customer AND tenant_id = v_tenant AND status <> 'cancelada';

  RETURN true;
END $$;
