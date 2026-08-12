-- ============================================================================
-- 0046 — Avaliações e recuperação de nota baixa (bloco 43, SPEC §4.10)
--
-- ## A avaliação nasce de um atendimento que aconteceu
--
-- "Avaliação só existe vinculada a atendimento real concluído" é a primeira
-- linha da seção, e é o que separa este produto de review aberta de
-- marketplace: aqui não há como avaliar quem você nunca visitou, nem a
-- concorrência derrubar a nota da casa ao lado. Por isso `appointment_id` é
-- **NOT NULL e único** — a garantia mora no schema, não numa validação.
--
-- ## A publicação não é coluna
--
-- Nota baixa segura 48 horas e depois vai ao ar de qualquer forma. Uma coluna
-- `publicada` estaria errada todo minuto entre o fim da janela e a varredura
-- passar — e é justamente aí que o gestor abre a tela para ver se ainda dá
-- tempo. O estado é derivado de `created_at` e da nota, em `packages/core`, e o
-- índice parcial abaixo é o que faz a leitura pública continuar barata.
--
-- ## O limite ético mora aqui, onde não depende de ninguém lembrar
--
-- A SPEC proíbe o produto de oferecer "apagar avaliação ruim", e escreve por
-- quê: suprimir review destrói a credibilidade da plataforma e é risco
-- jurídico. `REVOKE DELETE` é essa frase em código — não há caminho, nem por
-- engano, nem por rota nova escrita daqui a dez blocos.
-- ============================================================================

CREATE TYPE review_outcome AS ENUM ('contato', 'retrabalho', 'credito', 'sem_retorno');

CREATE TABLE reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  /**
   * O atendimento avaliado. **Um por atendimento**, e é o que dá confiança à
   * nota: sem ele, a avaliação seria opinião de qualquer um sobre qualquer casa.
   *
   * A garantia é de **escrita**: `avaliarAtendimento` só grava depois de achar
   * o atendimento concluído e do próprio cliente, sob RLS. Aqui a chave é
   * `SET NULL` pelo mesmo motivo de `customer_id` — ação referencial roda com os
   * direitos do dono da tabela e não passa pelo `REVOKE DELETE`, e com `CASCADE`
   * bastava apagar o agendamento para a avaliação sumir junto. A média de um
   * barbeiro não pode depender de nenhuma linha continuar existindo em outra
   * tabela.
   *
   * O índice único continua fazendo o trabalho: o Postgres aceita vários nulos,
   * e duas avaliações órfãs não conflitam — nem deveriam.
   */
  appointment_id    uuid REFERENCES appointments(id) ON DELETE SET NULL,
  /**
   * `SET NULL` e não `CASCADE`, e é achado da `/security-review`.
   *
   * Ação referencial roda com os direitos do dono da tabela e **não passa** pelo
   * `REVOKE DELETE` abaixo: com `CASCADE`, apagar um cadastro de cliente
   * destruiria as avaliações dele em silêncio — exatamente o que o cabeçalho
   * deste arquivo diz que não pode acontecer, por um caminho que ninguém
   * chamaria de "apagar avaliação".
   *
   * Nulo já é estado previsto: é o que a anonimização deixa, e a tela o desenha
   * como "Cliente anonimizado". Mesma escolha de `feedbacks` no bloco 40.
   */
  customer_id       uuid REFERENCES customers(id) ON DELETE SET NULL,
  /**
   * Quem atendeu, congelado na avaliação.
   *
   * `appointments.professional_id` responderia hoje, e mudaria se o agendamento
   * fosse remarcado para outro barbeiro depois — a nota do Ruan migraria para o
   * João sem ninguém ter feito nada. É o mesmo motivo de a regra de comissão ser
   * copiada no lançamento.
   */
  professional_id   uuid REFERENCES professionals(id) ON DELETE SET NULL,

  rating            smallint NOT NULL,
  -- As quatro da SPEC §4.10, todas opcionais: quem só quer dar as estrelas dá.
  rating_service    smallint,
  rating_quality    smallint,
  rating_punctual   smallint,
  rating_ambience   smallint,

  comment           text,

  -- A recuperação (SPEC §4.10). Nulo enquanto ninguém agiu.
  resolved_at       timestamptz,
  resolved_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  outcome           review_outcome,
  resolution_note   text,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reviews_nota_valida CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT reviews_categorias_validas CHECK (
    (rating_service  IS NULL OR rating_service  BETWEEN 1 AND 5) AND
    (rating_quality  IS NULL OR rating_quality  BETWEEN 1 AND 5) AND
    (rating_punctual IS NULL OR rating_punctual BETWEEN 1 AND 5) AND
    (rating_ambience IS NULL OR rating_ambience BETWEEN 1 AND 5)
  ),
  CONSTRAINT reviews_comentario_cabe CHECK (comment IS NULL OR length(comment) <= 1000),
  /**
   * Resolver é dizer **o que foi feito**, por escrito.
   *
   * "Resolvido" sozinho não é registro de nada: seis meses depois ninguém sabe
   * se ligaram, se refizeram o corte ou se desistiram. É a mesma exigência do
   * motivo escrito no override de confiabilidade e no ajuste de saldo.
   */
  CONSTRAINT reviews_resolucao_coerente CHECK (
    (resolved_at IS NULL AND outcome IS NULL AND resolution_note IS NULL)
    OR (resolved_at IS NOT NULL AND outcome IS NOT NULL
        AND resolution_note IS NOT NULL AND length(btrim(resolution_note)) >= 10)
  )
);

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reviews
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Um atendimento, uma avaliação. A garantia é do banco: a checagem na aplicação
-- perde a corrida entre dois toques no mesmo botão.
CREATE UNIQUE INDEX reviews_um_por_atendimento ON reviews (appointment_id);

CREATE INDEX reviews_do_cliente_idx ON reviews (customer_id, created_at DESC);
CREATE INDEX reviews_do_profissional_idx ON reviews (professional_id, created_at DESC);

/**
 * A fila da recuperação: nota baixa ainda sem resolução.
 *
 * Parcial porque é sempre o mesmo filtro, e porque é ela que o painel abre. O
 * prazo **não** entra no índice: ele depende do relógio, e um índice que
 * dependesse de `now()` não poderia existir. Quem corta pelas 48 horas é a
 * leitura — e o filtro da aplicação e este índice dizem a mesma coisa sobre o
 * que sobra, que é a regra que o bloco 39 aprendeu a respeitar.
 */
CREATE INDEX reviews_a_recuperar_idx ON reviews (created_at)
  WHERE rating <= 3 AND resolved_at IS NULL;

-- A leitura da página pública e a média do painel.
CREATE INDEX reviews_publicaveis_idx ON reviews (created_at DESC)
  WHERE rating >= 4;

/**
 * Apagar avaliação não existe.
 *
 * A SPEC §4.10 escreve o limite: *"O produto não pode oferecer 'apagar
 * avaliação ruim'. Suprimir review é o que destrói a credibilidade de
 * plataforma de avaliação — e é risco jurídico."* Aqui isso deixa de depender
 * de alguém lembrar: não há permissão de apagar no catálogo, e não há
 * privilégio no banco.
 *
 * `UPDATE` fica, porque a resolução é um `UPDATE` — e as colunas que ela toca
 * não incluem a nota nem o comentário, o que é garantido pelo gatilho abaixo.
 */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON reviews TO barbearia_app;
    REVOKE DELETE ON reviews FROM barbearia_app;
  END IF;
END $$;

/**
 * A nota e o comentário são imutáveis.
 *
 * `REVOKE DELETE` sozinho não bastaria: um `UPDATE SET rating = 5` é apagar a
 * avaliação ruim com outro nome, e seria o caminho mais curto para exatamente
 * o que a SPEC proíbe. O gatilho fecha isso onde nenhuma rota nova alcança.
 *
 * Só a recuperação escreve, e ela só escreve nas colunas dela.
 */
CREATE OR REPLACE FUNCTION reviews_nota_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  /**
   * A regra em duas metades.
   *
   * **Nunca muda:** a nota, as categorias, o comentário, o atendimento e a data.
   * É o conteúdo da avaliação, e reescrevê-lo é apagá-la com outro nome. O
   * comentário entra aqui inclusive na direção de virar nulo — limpar "o
   * barbeiro me cortou" mantendo a estrela vermelha é censura pela metade, que
   * é censura. Quem precisa fazer isso por LGPD é `anonimizar_cliente`, que
   * desliga este gatilho de propósito e por uma transação só.
   *
   * **Pode desatar, nunca reapontar:** `appointment_id`, `customer_id` e
   * `professional_id` aceitam ir de preenchido para nulo, e nada além disso. Essa é a direção da
   * anonimização e da própria chave estrangeira, que zera a coluna quando o
   * profissional é apagado — se o gatilho recusasse, apagar um barbeiro se
   * tornaria impossível. O que ele barra é a **reatribuição**: mover as notas
   * ruins para quem saiu limparia a média de quem ficou, e seria apagar a
   * avaliação ruim com outro nome, aplicado ao indicador da pessoa.
   *
   * `professional_id` estava de fora da primeira versão. Achado da
   * `/security-review` do bloco 43.
   */
  IF NEW.rating IS DISTINCT FROM OLD.rating
     OR NEW.comment IS DISTINCT FROM OLD.comment
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.rating_service IS DISTINCT FROM OLD.rating_service
     OR NEW.rating_quality IS DISTINCT FROM OLD.rating_quality
     OR NEW.rating_punctual IS DISTINCT FROM OLD.rating_punctual
     OR NEW.rating_ambience IS DISTINCT FROM OLD.rating_ambience
     OR (NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
         AND NEW.appointment_id IS NOT NULL)
     OR (NEW.customer_id IS DISTINCT FROM OLD.customer_id
         AND NEW.customer_id IS NOT NULL)
     OR (NEW.professional_id IS DISTINCT FROM OLD.professional_id
         AND NEW.professional_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'a avaliação não se reescreve; a recuperação registra o que foi feito'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER reviews_nota_imutavel
  BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_nota_imutavel();

-- ---------------------------------------------------------------------------
-- O convite para avaliar, e a permissão de ler
-- ---------------------------------------------------------------------------

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'pedido_de_avaliacao';

/**
 * Duas permissões, e são coisas diferentes.
 *
 * `reviews.view` é ler as notas — o barbeiro precisa ver o que dizem do trabalho
 * dele, e é o indicador que a SPEC §4.21 manda comparar com o próprio passado.
 * `reviews.recover` é agir em nome da casa dentro da janela: ligar, oferecer
 * retrabalho, registrar o desfecho. É a mesma separação de `feedback.view` e
 * `feedback.manage`, e de ler e escrever anotação.
 *
 * Nenhuma das duas apaga nada, e não existe uma terceira que apague.
 */
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_conhecida;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_conhecida CHECK (permission IN (
  'appointments.view', 'appointments.create', 'appointments.cancel',
  'appointments.reschedule', 'appointments.view_all_professionals',
  'appointments.attend',
  'cashier.open', 'cashier.close', 'cashier.withdraw',
  'finance.view', 'finance.view_profit', 'finance.export', 'finance.discount',
  'finance.deposit', 'finance.loyalty_adjust', 'finance.package_refund',
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
-- `anonimizar_cliente` passa a desatar a avaliação
--
-- Só a parte nova é comentada; o resto é a função do bloco 40 copiada sem
-- alteração. Escrevê-la de memória é como o bloco 40 quase perdeu vinte
-- instruções — a cópia é do arquivo, sempre.
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

  RETURN true;
END $$;
