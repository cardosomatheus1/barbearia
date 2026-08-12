-- ============================================================================
-- 0048 — Assinaturas: planos, regras e cooldown (bloco 45, SPEC §4.6)
--
-- A SPEC chama isto de **a maior oportunidade estratégica**, e o argumento é do
-- setor: corte tem ciclo natural de 3–4 semanas, o que faz dele o serviço mais
-- assinável que existe.
--
-- ## O cooldown é o mecanismo, não um detalhe
--
-- *"Corte ilimitado, com mínimo de 7 dias entre cortes."* Sem o intervalo,
-- "ilimitado" é prejuízo garantido no primeiro assinante entusiasmado — e a
-- barbearia descobre isso no fim do mês, com a agenda cheia e o caixa igual.
--
-- ## Ilimitado é nulo, nunca um número grande
--
-- Um `9999` é uma cota disfarçada: ele responde "quantos faltam" com um número
-- sem sentido, e a tela teria que saber que aquele valor específico significa
-- outra coisa. Nulo é a ausência de cota, e a leitura é a mesma em todo lugar.
-- ============================================================================

/**
 * `club_subscription_status`, e não `subscription_status`.
 *
 * O nome curto já é da assinatura **da plataforma** (bloco 29): o que a
 * barbearia paga a nós. Esta é a assinatura do **clube**: o que o cliente paga à
 * barbearia. São duas coisas diferentes que a SPEC §8 chama pelo mesmo MRR, e
 * confundi-las no schema seria confundi-las em toda consulta daqui para a
 * frente.
 */
CREATE TYPE club_subscription_status AS ENUM (
  'ativa', 'pendente', 'inadimplente', 'suspensa', 'cancelada'
);

CREATE TABLE club_plans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  name               text NOT NULL,
  description        text,
  price_cents        integer NOT NULL,
  /**
   * Desconto em produto para o assinante, em pontos-base (SPEC §4.6: "10% em
   * produtos"). Inteiro sempre, como toda alíquota do produto.
   */
  product_discount_bps integer NOT NULL DEFAULT 0,

  active             boolean NOT NULL DEFAULT true,
  position           smallint NOT NULL DEFAULT 0,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT club_plans_nome_preenchido CHECK (length(btrim(name)) > 0),
  CONSTRAINT club_plans_preco_positivo CHECK (price_cents > 0),
  CONSTRAINT club_plans_desconto_valido CHECK (
    product_discount_bps BETWEEN 0 AND 5000
  )
);

ALTER TABLE club_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON club_plans
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX club_plans_ativos_idx ON club_plans (position, name)
  WHERE active;

-- ---------------------------------------------------------------------------
-- O que cada plano dá
-- ---------------------------------------------------------------------------

CREATE TABLE club_plan_benefits (
  plan_id        uuid NOT NULL REFERENCES club_plans(id) ON DELETE CASCADE,
  service_id     uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Nulo é ilimitado. Ver o cabeçalho.
  quantity       smallint,
  -- Dias mínimos entre dois usos. Zero é sem intervalo.
  cooldown_days  smallint NOT NULL DEFAULT 0,

  created_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (plan_id, service_id),
  CONSTRAINT club_plan_benefits_quantidade_positiva CHECK (quantity IS NULL OR quantity > 0),
  CONSTRAINT club_plan_benefits_cooldown_valido CHECK (cooldown_days BETWEEN 0 AND 90)
);

ALTER TABLE club_plan_benefits ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_plan_benefits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON club_plan_benefits
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- A assinatura de um cliente
-- ---------------------------------------------------------------------------

CREATE TABLE club_subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- O plano pode sair de linha; a assinatura vendida não muda.
  plan_id            uuid REFERENCES club_plans(id) ON DELETE SET NULL,

  /**
   * O preço **congelado na adesão**.
   *
   * A barbearia sobe o Premium de R$ 149 para R$ 169 em março, e quem assinou em
   * janeiro continua pagando R$ 149 até renegociar. Recalcular na leitura faria
   * o MRR de um mês fechado mudar sozinho — é o mesmo raciocínio da regra de
   * comissão copiada no lançamento e da taxa do adquirente congelada na venda.
   */
  price_cents        integer NOT NULL,

  status             club_subscription_status NOT NULL DEFAULT 'pendente',

  /**
   * O dia da adesão é a **âncora do ciclo**.
   *
   * Quem assinou no dia 20 tem o ciclo do 20 ao 20. Ancorar no dia 1º daria meio
   * mês de graça para quem assina no dia 28, e a barbearia veria o plano render
   * metade no primeiro mês sem entender por quê.
   */
  started_at         timestamptz NOT NULL DEFAULT now(),
  cancelled_at       timestamptz,
  cancel_reason      text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT club_subscriptions_preco_positivo CHECK (price_cents > 0),
  CONSTRAINT club_subscriptions_cancelamento_coerente CHECK (
    (status = 'cancelada') = (cancelled_at IS NOT NULL)
  )
);

ALTER TABLE club_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON club_subscriptions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Uma assinatura viva por cliente.
 *
 * Duas ao mesmo tempo fariam a cota de cada uma ser contada em separado e a
 * grade oferecer o dobro — e no balcão ninguém saberia qual está sendo usada.
 * Trocar de plano é cancelar e assinar, que é o que qualquer clube faz.
 */
CREATE UNIQUE INDEX club_subscriptions_uma_viva_por_cliente
  ON club_subscriptions (customer_id)
  WHERE status <> 'cancelada';

CREATE INDEX club_subscriptions_do_plano_idx ON club_subscriptions (plan_id, status);
-- A leitura do MRR e da lista de assinantes.
CREATE INDEX club_subscriptions_vivas_idx ON club_subscriptions (status)
  WHERE status IN ('ativa', 'inadimplente');

-- ---------------------------------------------------------------------------
-- O uso
--
-- Tabela e não contador, pela mesma razão de `package_uses`: o **quando** de
-- cada uso é a informação — é ele que decide o cooldown e o ciclo, e um
-- `usados = 2` não tem nem um nem outro.
-- ---------------------------------------------------------------------------

CREATE TABLE club_uses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id  uuid NOT NULL REFERENCES club_subscriptions(id) ON DELETE CASCADE,
  service_id       uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,

  order_id         uuid REFERENCES orders(id) ON DELETE SET NULL,
  appointment_id   uuid REFERENCES appointments(id) ON DELETE SET NULL,

  /**
   * O valor que o plano cobriu, congelado.
   *
   * É o que a rentabilidade do bloco 48 lê: o assinante que usou três cortes de
   * R$ 60 consumiu R$ 180 de um plano de R$ 149, e esse é o número que diz que
   * ele está acima do ponto de equilíbrio.
   */
  value_cents      integer NOT NULL,
  business_day     date NOT NULL,
  used_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT club_uses_valor_nao_negativo CHECK (value_cents >= 0)
);

ALTER TABLE club_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_uses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON club_uses
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/**
 * Um uso por comanda e por serviço.
 *
 * Mesma razão de `package_uses`: o fechamento é idempotente por chave, mas a
 * cadeia do webhook do Pix reentra por outro caminho, e a reentrega gastaria
 * duas cotas do assinante pelo mesmo corte.
 */
CREATE UNIQUE INDEX club_uses_um_por_comanda
  ON club_uses (subscription_id, order_id, service_id)
  WHERE order_id IS NOT NULL;

-- O cooldown e a cota do ciclo: as duas leituras do balcão.
CREATE INDEX club_uses_do_ciclo_idx
  ON club_uses (subscription_id, service_id, used_at DESC);
CREATE INDEX club_uses_do_dia_idx ON club_uses (business_day);

/**
 * O uso é append-only.
 *
 * "Por que sumiu um corte do meu plano?" é a pergunta, e o registro é a
 * resposta. Devolver um uso lançado por engano é `ajuste` no bloco 47, com
 * motivo — nunca `DELETE`.
 */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON club_plans TO barbearia_app;
    GRANT SELECT, INSERT, DELETE ON club_plan_benefits TO barbearia_app;
    GRANT SELECT, INSERT, UPDATE ON club_subscriptions TO barbearia_app;
    GRANT SELECT, INSERT ON club_uses TO barbearia_app;
    REVOKE UPDATE, DELETE ON club_uses FROM barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- A assinatura entra na comanda como forma de pagamento
--
-- Pelo mesmo desenho do pacote: o item do corte continua com o preço de tabela
-- — é ele que dá base à comissão do barbeiro, que não pode cair porque o cliente
-- é assinante — e a assinatura quita a conta.
-- ---------------------------------------------------------------------------

ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'assinatura';

-- ---------------------------------------------------------------------------
-- A permissão
--
-- Separada de `settings.manage`: montar o plano é decisão de negócio, e
-- **assinar alguém** move dinheiro recorrente. Prefixo `finance.` de propósito —
-- é dele que a `PermissaoGuard` deriva o segundo fator.
-- ---------------------------------------------------------------------------

ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_conhecida;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_conhecida CHECK (permission IN (
  'appointments.view', 'appointments.create', 'appointments.cancel',
  'appointments.reschedule', 'appointments.view_all_professionals',
  'appointments.attend',
  'cashier.open', 'cashier.close', 'cashier.withdraw',
  'finance.view', 'finance.view_profit', 'finance.export', 'finance.discount',
  'finance.deposit', 'finance.loyalty_adjust', 'finance.package_refund',
  'finance.subscription_manage',
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

-- ---------------------------------------------------------------------------
-- `anonimizar_cliente` cancela a assinatura de quem saiu
--
-- Só a parte nova é comentada; o resto é a função do bloco 43 copiada sem
-- alteração — a cópia é do arquivo, sempre.
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
         cancel_reason = 'anonimizacao do titular', updated_at = now()
   WHERE customer_id = p_customer AND tenant_id = v_tenant AND status <> 'cancelada';

  RETURN true;
END $$;
