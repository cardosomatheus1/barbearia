-- ============================================================================
-- 0039 — Sinal seletivo e política de reembolso (bloco 37, SPEC §2.12 e §2.13)
--
-- ## As duas colunas que já existiam e ninguém preenchia
--
-- `appointments.deposit_required_cents` e `deposit_paid_cents` nasceram na
-- migração **0001** e atravessaram trinta e seis blocos sem um único `UPDATE`.
-- O motor aceitava sinal e nada no produto sabia decidir se ele era devido, de
-- quanto era, ou o que fazer com ele num cancelamento — é o defeito de `blocks`
-- outra vez, e este bloco é o que finalmente lhes dá origem.
--
-- ## O carimbo que faltava
--
-- O score de confiabilidade separa quem cancelou com antecedência de quem
-- cancelou em cima da hora, e essa é a distinção mais importante dele: um
-- cancelamento avisado devolve a vaga para a grade, e punir quem avisa ensina a
-- não avisar. Só que **não havia como saber quando o cancelamento aconteceu**.
-- `updated_at` não serve: qualquer edição posterior o move.
--
-- `cancelled_at` fica nulo nos agendamentos anteriores a esta migração, e isso é
-- tratado como "não sei", nunca como "cancelou em cima". Reter o dinheiro de
-- alguém por causa de um registro que a casa não fez seria cobrar pelo próprio
-- buraco.
--
-- ## Por que a política mora em `locations`
--
-- Pelo mesmo motivo de `cancel_min_hours` (migração 0008): quem tem duas
-- unidades tem dois movimentos e duas realidades de falta. A do centro, cheia no
-- sábado, cobra sinal; a do bairro, não.
--
-- ## Por que o prazo de reembolso é separado do de cancelamento
--
-- São perguntas diferentes. `cancel_min_hours` diz se o cliente **pode**
-- desmarcar; `deposit_refund_hours` diz se ele leva o dinheiro de volta. Uma
-- barbearia pode aceitar cancelamento até uma hora antes e ainda assim reter o
-- sinal de quem desmarca em cima — e é justamente essa combinação que faz o
-- sinal funcionar sem transformar cancelamento em briga.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Quando o cancelamento aconteceu
-- ---------------------------------------------------------------------------

ALTER TABLE appointments
  ADD COLUMN cancelled_at timestamptz;

COMMENT ON COLUMN appointments.cancelled_at IS
  'Instante do cancelamento. Base da antecedência no score de confiabilidade e '
  'na decisão de reembolso do sinal. Nulo em agendamento anterior à migração '
  '0039 e em agendamento que não foi cancelado — nos dois casos vale "não sei", '
  'e "não sei" devolve o sinal.';

-- Só quem está cancelado carrega o carimbo, e todo cancelado a partir daqui o
-- carrega. Sem esta CHECK, um `UPDATE status` esquecendo a coluna produziria
-- cancelamento sem antecedência conhecida em cima de dado novo — e o buraco
-- passaria por "agendamento antigo" para sempre.
ALTER TABLE appointments
  ADD CONSTRAINT appointments_cancelled_at_so_em_cancelado
    CHECK (cancelled_at IS NULL OR status IN ('cancelled_customer', 'cancelled_business'));

-- ---------------------------------------------------------------------------
-- Por que o sinal foi exigido
-- ---------------------------------------------------------------------------

-- `deposit_required_cents` diz quanto; esta coluna diz o porquê, e ela existe
-- para o balcão. "Por que eu preciso pagar adiantado?" é a primeira pergunta do
-- cliente, e a recepção precisa da resposta na tela — recalculá-la na leitura
-- daria a resposta de hoje para uma decisão de anteontem.
--
-- Texto e não enum de propósito: o motivo é escrito por `packages/core`, que
-- não conhece banco, e um enum novo obrigaria migração a cada motivo — sendo
-- que o terceiro termo da SPEC (horário de pico) ainda vai entrar.
ALTER TABLE appointments
  ADD COLUMN deposit_reason text,

  ADD CONSTRAINT appointments_deposit_reason_conhecido
    CHECK (deposit_reason IS NULL OR deposit_reason IN ('servico', 'score', 'ticket')),

  -- Sinal com valor e sem motivo é uma cobrança que ninguém sabe defender; e
  -- motivo sem valor é uma explicação para uma cobrança que não existe. Os dois
  -- andam juntos ou nenhum existe.
  ADD CONSTRAINT appointments_deposit_motivo_com_valor
    CHECK ((deposit_required_cents = 0) = (deposit_reason IS NULL));

-- ---------------------------------------------------------------------------
-- A política da unidade
-- ---------------------------------------------------------------------------

CREATE TYPE deposit_mode AS ENUM ('nenhum', 'fixo', 'percentual', 'total');

ALTER TABLE locations
  -- `nenhum` é o padrão, e é o comportamento anterior: nenhuma barbearia já
  -- instalada passa a cobrar sinal por causa de uma migração. A regra do
  -- CLAUDE.md sobre configuração que mexe em dinheiro vale aqui inteira.
  ADD COLUMN deposit_mode deposit_mode NOT NULL DEFAULT 'nenhum',
  ADD COLUMN deposit_fixed_cents integer NOT NULL DEFAULT 0,
  -- Pontos-base, como toda alíquota deste produto: 3000 = 30%.
  ADD COLUMN deposit_percent_bps integer NOT NULL DEFAULT 0,
  -- Abaixo deste score o sinal passa a ser exigido. O padrão é o da SPEC §2.13,
  -- e ele só significa alguma coisa por causa da escala documentada em
  -- `packages/core/src/confiabilidade.ts`: com os pesos literais do texto da
  -- SPEC o pior cliente possível fica em 75, e este limiar nunca dispararia.
  ADD COLUMN deposit_score_threshold smallint NOT NULL DEFAULT 60,
  -- Ticket acima do qual o sinal é exigido de qualquer um. Zero desliga o termo.
  ADD COLUMN deposit_ticket_over_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN deposit_refund_hours smallint NOT NULL DEFAULT 24,

  ADD CONSTRAINT locations_deposit_sane
    CHECK (deposit_fixed_cents >= 0
           AND deposit_percent_bps BETWEEN 0 AND 10000
           AND deposit_score_threshold BETWEEN 0 AND 100
           AND deposit_ticket_over_cents >= 0
           AND deposit_refund_hours BETWEEN 0 AND 720),

  -- Modalidade sem o valor que ela usa é sinal de zero real cobrado num
  -- agendamento que a tela disse que exigia pagamento. O banco recusa a
  -- combinação em vez de deixá-la virar um QR Code de R$ 0,00.
  ADD CONSTRAINT locations_deposit_tem_valor
    CHECK (deposit_mode <> 'fixo' OR deposit_fixed_cents > 0),
  ADD CONSTRAINT locations_deposit_tem_percentual
    CHECK (deposit_mode <> 'percentual' OR deposit_percent_bps > 0);

-- ---------------------------------------------------------------------------
-- O serviço que sempre exige
-- ---------------------------------------------------------------------------

ALTER TABLE services
  -- O quarto termo da SPEC §2.12. Existe para o serviço caro e demorado — a
  -- coloração de três horas — em que a falta custa a tarde inteira,
  -- independentemente de quem faltou.
  ADD COLUMN always_require_deposit boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- O override do gerente (SPEC §2.13, regra de justiça 7)
-- ---------------------------------------------------------------------------

ALTER TABLE customers
  -- Quando presente, substitui o score calculado. É a válvula para o caso que a
  -- fórmula não vê: o cliente que faltou três vezes por causa de uma internação,
  -- e o que tem histórico impecável e sumiu com a chave da barbearia.
  ADD COLUMN reliability_override smallint,
  ADD COLUMN reliability_override_reason text,
  ADD COLUMN reliability_override_at timestamptz,

  ADD CONSTRAINT customers_reliability_override_range
    CHECK (reliability_override IS NULL OR reliability_override BETWEEN 0 AND 100),

  -- Override sem motivo escrito é um número que ninguém consegue defender seis
  -- meses depois — e a SPEC pede justificativa auditada, não só auditoria. A
  -- CHECK cobra o motivo no banco; a trilha registra quem fez.
  ADD CONSTRAINT customers_reliability_override_tem_motivo
    CHECK (reliability_override IS NULL
           OR (reliability_override_reason IS NOT NULL
               AND length(btrim(reliability_override_reason)) >= 10
               AND reliability_override_at IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Índice
-- ---------------------------------------------------------------------------

-- O score varre os agendamentos de um cliente nos últimos doze meses, e é
-- consultado **na marcação** — com o cliente esperando a grade carregar. Sem
-- este índice a consulta varre a tabela inteira da barbearia.
--
-- Ele não carrega `tenant_id`: a RLS já recorta, e o par
-- (customer_id, service_starts_at) é o que a consulta usa.
CREATE INDEX appointments_historico_do_cliente_idx
  ON appointments (customer_id, service_starts_at DESC)
  WHERE customer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- As duas permissões do sinal
-- ---------------------------------------------------------------------------

/**
 * `finance.deposit` e `customers.reliability_override` entram no vocabulário.
 *
 * O `CHECK` espelha `packages/core/src/permissoes.ts`, e a duplicação é
 * deliberada desde o bloco 16: é o banco que impede uma permissão inventada de
 * ser concedida numa correção manual de madrugada. Há teste que reprova se as
 * duas listas divergirem — e foi ele que reprovou este bloco antes de a
 * migração existir.
 *
 * **Nenhum `INSERT` de retrocompatibilidade**, pelo mesmo motivo da 0034: são
 * capacidades que ninguém tinha, porque não existiam. Distribuí-las para quem
 * tem `settings.manage` faria toda gerência já instalada poder dispensar
 * conhecidos do sinal no dia da migração, sem ninguém decidir isso.
 *
 * O dono continua com tudo pela semente de papel do bloco 16, que insere
 * `PERMISSOES` inteiro para `owner`. O gerente as recebe no padrão de
 * `permissoesPadrao`, que vale para barbearia nova.
 */
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_conhecida;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_conhecida CHECK (permission IN (
  'appointments.view', 'appointments.create', 'appointments.cancel',
  'appointments.reschedule', 'appointments.view_all_professionals',
  'appointments.attend',
  'cashier.open', 'cashier.close', 'cashier.withdraw',
  'finance.view', 'finance.view_profit', 'finance.export', 'finance.discount',
  'finance.deposit',
  'commission.view_own', 'commission.view_all', 'commission.edit_rules',
  'customers.view', 'customers.edit', 'customers.export',
  'customers.view_photos', 'customers.view_notes', 'customers.edit_notes',
  'customers.anonymize', 'customers.reliability_override',
  'reports.finance', 'reports.operational',
  'inventory.view', 'inventory.adjust',
  'marketing.send', 'settings.manage', 'team.manage'
));

-- ---------------------------------------------------------------------------
-- A anonimização volta a apagar tudo que identifica
--
-- Achado da `/security-review` deste bloco. `reliability_override_reason` é
-- texto livre **obrigatório**, escrito por um gerente sobre uma pessoa
-- específica, e a CHECK acima exige dez caracteres justamente para que ele
-- explique alguma coisa. Os dois exemplos que este repositório usa são "faltou
-- por internação, comprovada na recepção" e "sumiu com a chave da barbearia":
-- dado de saúde (LGPD art. 5 II) e imputação de crime.
--
-- `anonimizar_cliente` limpa uma **lista escrita** de colunas de `customers`, e
-- é o desenho certo — mas uma lista escrita só continua certa se quem
-- acrescenta coluna a atualiza. Este bloco acrescentou três e não atualizou:
-- a pessoa que pediu exclusão sairia do cadastro com o nome apagado e a
-- narrativa intacta, carimbada com a hora.
--
-- A função é recriada inteira porque plpgsql não se remenda pela metade. O que
-- mudou são as três linhas marcadas.
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

  RETURN true;
END $$;
