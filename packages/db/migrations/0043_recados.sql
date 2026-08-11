-- ============================================================================
-- 0043 — Recados do cliente: sugestão, reclamação e elogio (bloco 40)
--
-- ## Por que não é um campo na avaliação
--
-- A avaliação (SPEC §4.10, bloco 43) é uma nota presa a um atendimento
-- concluído. O recado é o outro lado: quem quer dizer alguma coisa **sem ter
-- uma nota para dar**, e muitas vezes sem nunca ter sido atendido — quem
-- desistiu da fila e foi embora é justamente quem mais tem o que contar.
--
-- Por isso `appointment_id` é **opcional** e `customer_id` também. Exigir o
-- primeiro perderia quem nunca chegou à cadeira; exigir o segundo perderia a
-- reclamação anônima, que é a mais honesta que existe.
--
-- ## O limite ético não é promessa de tela
--
-- A SPEC §4.10 é explícita: o produto não pode oferecer "apagar avaliação
-- ruim". Aqui a regra vale igual e é imposta pelo banco — `barbearia_app` não
-- tem `DELETE` nesta tabela. Encerrar um recado é um **estado**; o texto
-- continua lá, e a média de reclamações do trimestre continua verdadeira.
--
-- ## Sem coluna de telefone
--
-- Quem deixa nome e celular vira (ou reencontra) um cliente, e o recado aponta
-- para ele. Copiar o telefone para cá criaria dado pessoal fora de `customers`
-- — que a convenção deste código só admite com prazo escrito no schema — para
-- responder o que uma junção já responde. Quem não deixa contato fica anônimo,
-- e a tela diz que não haverá resposta.
-- ============================================================================

CREATE TYPE feedback_kind AS ENUM ('sugestao', 'reclamacao', 'elogio');
CREATE TYPE feedback_status AS ENUM ('aberto', 'em_analise', 'respondido', 'encerrado');

CREATE TABLE feedbacks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id    uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,

  -- Nulo é o recado anônimo. `ON DELETE SET NULL` e não CASCADE: a barbearia
  -- não perde "a cadeira do fundo está bamba" porque a pessoa saiu da base.
  customer_id    uuid REFERENCES customers(id) ON DELETE SET NULL,
  -- Nulo é o recado de quem não estava marcado — ou nem chegou a ser atendido.
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,

  kind           feedback_kind NOT NULL,
  status         feedback_status NOT NULL DEFAULT 'aberto',

  body           text NOT NULL,

  -- Quem assumiu. Nulo enquanto ninguém assumiu, que é o estado de triagem.
  assigned_to    uuid REFERENCES staff_users(id) ON DELETE SET NULL,

  answer         text,
  answered_at    timestamptz,
  answered_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,

  closed_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- Os mesmos limites da borda, no banco. O piso não é burocracia: recado de
  -- três caracteres não diz nada e ocupa a fila de quem lê.
  CONSTRAINT feedbacks_texto_com_conteudo CHECK (
    length(btrim(body)) BETWEEN 10 AND 2000
  ),
  CONSTRAINT feedbacks_resposta_com_teto CHECK (
    answer IS NULL OR length(btrim(answer)) BETWEEN 1 AND 1000
  ),
  -- "Respondido" sem resposta escrita é um estado mentindo para quem lê a fila.
  CONSTRAINT feedbacks_respondido_tem_resposta CHECK (
    status <> 'respondido' OR (answer IS NOT NULL AND answered_at IS NOT NULL)
  ),
  CONSTRAINT feedbacks_encerrado_tem_hora CHECK (
    status <> 'encerrado' OR closed_at IS NOT NULL
  )
);

ALTER TABLE feedbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedbacks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON feedbacks
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Índices
-- ---------------------------------------------------------------------------

-- A fila de triagem: o que ainda não foi encerrado, do mais antigo ao mais novo.
CREATE INDEX feedbacks_triagem_idx
  ON feedbacks (location_id, created_at)
  WHERE status <> 'encerrado';

-- "O que este cliente já nos disse?", na ficha e na exportação do titular.
CREATE INDEX feedbacks_por_cliente_idx ON feedbacks (customer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Permissão da aplicação
--
-- **Sem `DELETE`.** É o limite ético da SPEC §4.10 escrito onde ele não depende
-- de ninguém lembrar: não existe caminho de código que apague uma reclamação,
-- porque o role da aplicação não consegue. Encerrar é estado.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON feedbacks TO barbearia_app;
    REVOKE DELETE ON feedbacks FROM barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- A resposta ao cliente entra no vocabulário de notificação
--
-- Transacional, não promocional: é resposta a uma mensagem que a pessoa mandou.
-- A janela de silêncio de 21h às 8h continua valendo — o recado esperou três
-- dias na fila, pode esperar até as oito.
-- ---------------------------------------------------------------------------

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'resposta_recado';

-- ---------------------------------------------------------------------------
-- As duas permissões novas
--
-- Separadas porque ler e agir são coisas diferentes, como `customers.view_notes`
-- e `customers.edit_notes`: o barbeiro precisa saber que reclamaram da cadeira
-- dele; responder em nome da casa é do balcão.
-- ---------------------------------------------------------------------------

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
  'feedback.view', 'feedback.manage',
  'reports.finance', 'reports.operational',
  'inventory.view', 'inventory.adjust',
  'marketing.send', 'settings.manage', 'team.manage'
));

-- ---------------------------------------------------------------------------
-- A anonimização solta o recado em vez de apagá-lo
--
-- As duas coisas são verdadeiras ao mesmo tempo: a pessoa tem direito a sair, e
-- a barbearia precisa continuar sabendo que a cadeira do fundo está bamba.
-- Apagar o recado perderia a melhoria; manter o vínculo manteria a pessoa
-- identificada por um texto que ela mesma escreveu, e que pode dizer o nome
-- dela.
--
-- O desate é o vínculo: `customer_id` vai a nulo e o texto fica órfão. É o
-- mesmo raciocínio de `orders`, em que a linha e os centavos ficam — só que
-- aqui não há sequer obrigação fiscal segurando o vínculo.
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

  RETURN true;
END $$;
