-- ============================================================================
-- 0071 — foto do cliente e portfólio (bloco 74, SPEC §4.2 e §1.8 regra 2)
--
-- > *"O barbeiro registra **Antes** e **Depois**, vinculados ao atendimento."*
-- > *"Consentimento **separado** para uso em portfólio público — autorizar o
-- > registro interno não autoriza publicar."*
-- > *"O cliente pode revogar, e a revogação **apaga as fotos**."*
--
-- ## Duas autorizações, e a diferença entre elas é o bloco inteiro
--
-- `photos` deixa o barbeiro **guardar** a foto na ficha, para consultar "o
-- último corte" no atendimento seguinte. `photos_public` deixa a barbearia
-- **publicar** aquilo no portfólio, numa página indexada. As duas finalidades
-- existem separadas em `consent_purpose` desde o bloco 5, e até aqui nenhuma
-- delas guardava coisa nenhuma: o aceite era coletado e não havia foto.
--
-- ## A guarda mora aqui, e não só na aplicação
--
-- A regra 2 da §1.8 é direito do titular, não invariante de negócio. Uma
-- cláusula de aplicação é perdível numa reescrita; um gatilho não. São dois:
--
-- 1. **na escrita** — não entra foto de quem não autorizou, e não entra no
--    portfólio quem não autorizou o uso público;
-- 2. **na revogação** — revogar `photos` apaga as fotos, e revogar
--    `photos_public` tira do portfólio o que já estava lá.
--
-- ## E por isso esta tabela **aceita `DELETE`**
--
-- É a exceção deliberada no meio de um schema em que quase tudo é append-only.
-- Ali o `REVOKE DELETE` protege registro de dinheiro; aqui apagar **é** a
-- obrigação: "a revogação apaga as fotos" está escrito na SPEC, e uma tabela
-- que só soubesse marcar como escondida deixaria o dado no banco depois de o
-- titular ter dito não.
-- ============================================================================

CREATE TYPE customer_photo_kind AS ENUM ('antes', 'depois');

CREATE TABLE customer_photos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  /**
   * O atendimento a que a foto pertence.
   *
   * `SET NULL` e não `CASCADE`: apagar um agendamento não pode apagar a foto em
   * silêncio — a decisão de apagar foto de pessoa é do titular, e ela tem
   * caminho próprio. A foto órfã continua na ficha, que é onde o barbeiro a
   * procura.
   */
  appointment_id  uuid REFERENCES appointments(id) ON DELETE SET NULL,

  /**
   * De quem é o trabalho.
   *
   * É o que faz o portfólio existir: a página do barbeiro mostra o que **ele**
   * fez, não o que a casa fez. `SET NULL` porque a pessoa pode sair, e aí a
   * foto some do portfólio dela sem sumir da ficha do cliente.
   */
  professional_id uuid REFERENCES professionals(id) ON DELETE SET NULL,

  kind            customer_photo_kind NOT NULL,
  url             text NOT NULL,

  /**
   * Se esta foto está no portfólio público.
   *
   * Separado do consentimento de propósito: autorizar o uso público não
   * publica tudo automaticamente — a barbearia escolhe **quais** fotos entram.
   * O consentimento é o teto; isto é a escolha dentro dele.
   */
  in_portfolio    boolean NOT NULL DEFAULT false,

  /** Legenda curta, para o portfólio dizer o que é. Sem nome de cliente. */
  caption         text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,

  /**
   * A foto sai para um `src` numa página anônima quando entra no portfólio, e
   * um dia sairá para `og:image` — onde um esquema que não seja `https` deixa
   * de ser inerte. É a mesma `CHECK` da vitrine do bloco 70.
   */
  CONSTRAINT customer_photos_https CHECK (url LIKE 'https://%'),
  CONSTRAINT customer_photos_legenda_curta CHECK (caption IS NULL OR length(caption) <= 120)
);

CREATE INDEX customer_photos_do_cliente
  ON customer_photos (tenant_id, customer_id, created_at DESC);

-- O portfólio da página do barbeiro: só o que está publicado, do mais novo.
CREATE INDEX customer_photos_no_portfolio
  ON customer_photos (professional_id, created_at DESC) WHERE in_portfolio;

ALTER TABLE customer_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_photos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_photos
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_photos TO barbearia_app;

COMMENT ON TABLE customer_photos IS
  'Fotos antes/depois do cliente (bloco 74, SPEC §4.2). Exige consentimento '
  '`photos` para existir e `photos_public` para entrar no portfólio, e as duas '
  'condições são impostas por gatilho. Aceita DELETE de propósito: revogar '
  'apaga (SPEC §1.8 regra 2).';

-- ----------------------------------------------------------------------------
-- A guarda da escrita
-- ----------------------------------------------------------------------------

/**
 * A decisão mais recente do titular para uma finalidade.
 *
 * `customer_consents` é append-only desde o bloco 33: revogar é **inserir** a
 * revogação, nunca apagar a concessão. Quem vale é a última linha, e é isso
 * que esta função responde.
 *
 * `SECURITY DEFINER` não — o gatilho roda na transação de quem escreve, com o
 * tenant já fixado, e a política de `customer_consents` é a de sempre.
 */
CREATE OR REPLACE FUNCTION consentimento_vigente(
  p_customer_id uuid,
  p_purpose consent_purpose
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT granted
       FROM customer_consents
      WHERE customer_id = p_customer_id AND purpose = p_purpose
      ORDER BY decided_at DESC, id DESC
      LIMIT 1),
    false
  );
$$;

/**
 * Não entra foto de quem não autorizou.
 *
 * *"O barbeiro não fotografa sem o aceite registrado."* A aplicação já confere
 * antes de gravar e dá mensagem legível; isto é a camada que não depende de
 * ninguém ter lembrado — e a única que vale para um `INSERT` escrito à mão, uma
 * importação ou um caminho novo daqui a dez blocos.
 */
CREATE OR REPLACE FUNCTION customer_photos_exige_consentimento() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT consentimento_vigente(NEW.customer_id, 'photos') THEN
    RAISE EXCEPTION 'O cliente não autorizou o registro de fotos'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.in_portfolio AND NOT consentimento_vigente(NEW.customer_id, 'photos_public') THEN
    RAISE EXCEPTION 'O cliente não autorizou o uso público da foto'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_photos_exige_consentimento
  BEFORE INSERT OR UPDATE ON customer_photos
  FOR EACH ROW EXECUTE FUNCTION customer_photos_exige_consentimento();

-- ----------------------------------------------------------------------------
-- A revogação apaga
-- ----------------------------------------------------------------------------

/**
 * Revogar `photos` apaga as fotos; revogar `photos_public` tira do portfólio.
 *
 * SPEC §1.8 regra 2, imposta pelo banco. Deixar isso para a aplicação faria a
 * revogação depender de o caminho que a grava lembrar de limpar — e um caminho
 * novo que esquecesse deixaria a foto de alguém que disse não no ar, sem nada
 * ficar vermelho.
 *
 * A ordem importa: `photos` é o teto, então revogá-lo apaga tudo, inclusive o
 * que estava publicado. Revogar só o uso público mantém a foto na ficha, que é
 * exatamente a diferença entre as duas autorizações.
 */
CREATE OR REPLACE FUNCTION customer_consents_revogacao_apaga_fotos() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.granted THEN RETURN NEW; END IF;

  IF NEW.purpose = 'photos' THEN
    DELETE FROM customer_photos WHERE customer_id = NEW.customer_id;
  ELSIF NEW.purpose = 'photos_public' THEN
    UPDATE customer_photos SET in_portfolio = false
     WHERE customer_id = NEW.customer_id AND in_portfolio;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_consents_revogacao_apaga_fotos
  AFTER INSERT ON customer_consents
  FOR EACH ROW EXECUTE FUNCTION customer_consents_revogacao_apaga_fotos();

-- ----------------------------------------------------------------------------
-- A permissão de escrever
-- ----------------------------------------------------------------------------

/**
 * Ler e escrever foto são permissões diferentes.
 *
 * `customers.view_photos` já existia e abre a ficha; `customers.manage_photos`
 * é o que autoriza **criar** dado pessoal sensível e publicá-lo. Escrita
 * guardada por permissão de leitura é defeito, não economia — a regra é do
 * bloco 30, e aqui o que se cria é a foto do rosto de alguém.
 *
 * Só o dono por padrão, como toda permissão que expõe pessoa. Quem quiser dar
 * ao barbeiro edita o papel na tela, que é editável desde o bloco 30.
 */
/**
 * A `CHECK` do catálogo cresce, e a lista é **copiada** da 0058.
 *
 * Reescrevê-la de memória levaria junto permissões que treze blocos
 * acrescentaram, e a constraint passaria a recusar papéis que já existem. A
 * única diferença é `customers.manage_photos`.
 */
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
  'customers.view_photos', 'customers.manage_photos',
  'customers.view_notes', 'customers.edit_notes',
  'customers.anonymize', 'customers.reliability_override',
  'feedback.view', 'feedback.manage',
  'reviews.view', 'reviews.recover',
  'reports.finance', 'reports.operational',
  'inventory.view', 'inventory.adjust',
  'marketing.send', 'settings.manage', 'team.manage',
  'whatsapp.manage'
));

INSERT INTO role_permissions (tenant_id, role, permission)
SELECT t.id, 'owner', 'customers.manage_photos' FROM tenants t
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- A anonimização alcança a foto
--
-- `anonimizar_cliente` é uma **lista escrita**, e o cabeçalho da 0058 já dizia
-- o preço disso: "coluna nova que não entra aqui sobrevive à anonimização em
-- silêncio". Uma tabela nova com o rosto da pessoa é o caso mais caro possível
-- desse defeito, e ele quase aconteceu aqui.
--
-- A função é recriada **inteira**, copiada da 0058 e não reescrita de memória:
-- reescrevê-la deixaria para trás treze blocos de limpeza que ninguém lembraria
-- de recolocar. A única diferença é o `DELETE` das fotos, no fim.
-- ----------------------------------------------------------------------------

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
         /**
          * Bloco 54. O CPF do tomador, que a nota fiscal usa.
          *
          * É o identificador mais direto que existe no cadastro: deixá-lo para
          * trás faria a função apagar nome e telefone e guardar exatamente o
          * número pelo qual a pessoa é encontrada em qualquer outra base.
          */
         tax_id = NULL,
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
  /**
   * A nota fiscal guarda nome e CPF do tomador, e os dois são cópia do
   * cadastro — como `queue_entries.customer_name`, que já é limpa acima.
   *
   * O que **não** sai é o valor, o número e a data: eles são o registro fiscal,
   * a barbearia tem obrigação de guarda de cinco anos, e é a mesma decisão que
   * mantém a venda de pé. Anonimizar é tirar a pessoa de dentro do documento,
   * não destruir o documento.
   *
   * O filtro passa por `orders` porque a nota aponta para a venda, não para o
   * cliente — e é sob o tenant, porque `SECURITY DEFINER` roda como dono e a
   * RLS pode não estar valendo aqui dentro.
   */
  UPDATE public.fiscal_invoices
     SET customer_name = v_apelido,
         customer_document = NULL
   WHERE tenant_id = v_tenant
     AND order_id IN (
       SELECT id FROM public.orders
        WHERE tenant_id = v_tenant AND customer_id = p_customer
     );

  /**
   * O que o cliente escreveu pelo WhatsApp, e o número de onde escreveu.
   *
   * `whatsapp_inbound` guarda o telefone em claro — é ele que identifica quem
   * respondeu, porque a Meta não devolve o nosso id — e o texto que a pessoa
   * digitou, que rotineiramente traz o nome dela. Os dois são cópia de dado
   * pessoal fora de `customers`, e a função é uma **lista escrita**: coluna
   * nova que não entra aqui sobrevive à anonimização em silêncio.
   *
   * A linha fica, sem a pessoa: ela é o registro de que houve uma conversa, e
   * é o mesmo critério de `queue_entries` e da nota fiscal. O que sai é quem.
   */
  UPDATE public.whatsapp_inbound
     SET from_phone = NULL, body = NULL, customer_id = NULL
   WHERE tenant_id = v_tenant AND customer_id = p_customer;

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

  /**
   * A foto do rosto da pessoa sai, e é `DELETE` (bloco 74).
   *
   * Esta função é **lista escrita**, não varredura: coluna ou tabela nova que
   * não entre aqui sobrevive à anonimização em silêncio. O bloco 74 criou
   * `customer_photos` e quase repetiu o defeito — e o efeito seria o pior deste
   * produto: quem exerceu o direito à exclusão continuaria com o rosto numa
   * página **indexada**, porque a anonimização não insere revogação de
   * consentimento e o gatilho que apaga por revogação nunca dispararia.
   *
   * `DELETE` e não `in_portfolio = false`: a foto **é** a pessoa. Não é registro
   * de fato do negócio como a venda ou a nota — é o mesmo critério de
   * `customer_sessions`, que também some inteira.
   *
   * Achado da `/security-review` do bloco 74.
   */
  DELETE FROM public.customer_photos
   WHERE customer_id = p_customer AND tenant_id = v_tenant;

  RETURN true;
END $$;
