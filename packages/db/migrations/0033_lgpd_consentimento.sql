-- ============================================================================
-- 0033 — LGPD: o consentimento vira histórico, e o titular consegue os dados
--        (bloco 31, SPEC Parte 1 §1.8)
--
-- ## O defeito que este bloco encontra antes de resolver
--
-- Existem **duas** fontes de verdade para "este cliente aceita marketing", e
-- elas nunca conversaram:
--
-- 1. `customer_consents` (bloco 5) — tabela com finalidade, versão do texto e
--    IP, desenhada certa e **nunca escrita por ninguém**. Nenhuma linha de
--    código de produto a lê ou grava.
-- 2. `customers.accepts_marketing` (bloco 20) — a coluna que o disparo de
--    campanha de fato consulta, com data, IP e versão ao lado.
--
-- É o defeito de `blocks` outra vez, pelo avesso: em vez de um campo que o
-- motor aceita e ninguém preenche, uma tabela inteira que ninguém usa. E o
-- estrago aqui seria maior — quem auditasse o consentimento leria a tabela
-- vazia e concluiria que a barbearia dispara campanha sem aceite nenhum.
--
-- ## A saída: histórico é a fonte, a coluna é derivada
--
-- `customer_consents` passa a ser **append-only**: cada decisão do titular é uma
-- linha nova, com data, IP e versão do texto. É o que a LGPD pede de verdade —
-- "quando ele consentiu" e "quando revogou" são perguntas diferentes, e uma
-- tabela com uma linha por finalidade só responde a primeira, e mal.
--
-- `customers.accepts_marketing` continua existindo e vira **derivada por
-- gatilho**. Sem isso, o disparo de campanha faria uma consulta ao histórico
-- por cliente — N+1 numa varredura que percorre a base inteira.
--
-- ## O que o bloco 32 vai precisar e este já prepara
--
-- Nada aqui apaga dado. Anonimização, retenção e o pipeline de exclusão são o
-- bloco seguinte, e a separação é deliberada: consentir e exportar são direitos
-- que o titular exerce a qualquer momento; apagar é operação irreversível que
-- merece bloco próprio, com fila e aviso.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- O consentimento, agora com história
-- ---------------------------------------------------------------------------

/**
 * A chave primária era `(customer_id, purpose)`, o que obrigava a sobrescrever.
 *
 * Sobrescrever apaga a prova: "o cliente revogou em março" some no dia em que
 * ele consente de novo em abril, e é justamente o par de datas que responde a
 * um pedido de comprovação. A tabela está vazia em toda instalação — nada
 * nunca a escreveu —, então a troca de chave não migra dado nenhum.
 */
ALTER TABLE customer_consents DROP CONSTRAINT customer_consents_pkey;
ALTER TABLE customer_consents
  ADD COLUMN id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  /**
   * Quem registrou a decisão.
   *
   * Nulo é o próprio titular, pela página pública; preenchido é alguém da
   * barbearia registrando o que o cliente disse no balcão. A diferença importa
   * numa contestação — "eu nunca aceitei" tem resposta diferente conforme quem
   * clicou.
   */
  ADD COLUMN recorded_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;

-- "Qual é a decisão atual desta pessoa para esta finalidade?" é a pergunta que
-- toda leitura faz, e ela é a última linha por (cliente, finalidade).
CREATE INDEX customer_consents_atual
  ON customer_consents (customer_id, purpose, decided_at DESC);

/**
 * Append-only por `REVOKE`, como `audit_log` e `platform_audit`.
 *
 * Prova que a própria aplicação pode reescrever não é prova. Revogar um
 * consentimento é **inserir** a revogação, nunca apagar a concessão.
 */
REVOKE UPDATE, DELETE ON customer_consents FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    REVOKE UPDATE, DELETE ON customer_consents FROM barbearia_app;
    GRANT SELECT, INSERT ON customer_consents TO barbearia_app;
  END IF;
END $$;

/**
 * A coluna que o disparo de campanha lê passa a ser espelho do histórico.
 *
 * Espelho e não consulta: `varrerRetornos` percorre a base inteira à procura de
 * quem não volta há X dias, e uma subconsulta ao histórico por cliente seria o
 * N+1 que a regra proíbe — disfarçado de "é só um `EXISTS`".
 *
 * `SET search_path = ''` com tudo qualificado pelo mesmo motivo da migração
 * 0029: sem `pg_temp` escrito, o esquema temporário é procurado primeiro, e
 * nome de relação continua sequestrável.
 */
CREATE OR REPLACE FUNCTION espelhar_consentimento_de_marketing() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.purpose <> 'marketing' THEN
    RETURN NULL;
  END IF;

  /**
   * Só avança o espelho se esta decisão for a mais recente.
   *
   * Importação e correção manual podem inserir uma decisão antiga depois de uma
   * nova. Sem a condição, o registro de 2023 sobrescreveria a revogação de
   * ontem — e a campanha sairia para quem pediu para parar.
   */
  UPDATE public.customers
     SET accepts_marketing = NEW.granted,
         marketing_consent_at = NEW.decided_at,
         marketing_consent_ip = NEW.ip,
         marketing_consent_version = NEW.text_version,
         updated_at = now()
   WHERE id = NEW.customer_id
     AND (marketing_consent_at IS NULL OR marketing_consent_at <= NEW.decided_at);

  RETURN NULL;
END $$;

CREATE TRIGGER customer_consents_espelha_marketing
AFTER INSERT ON customer_consents
FOR EACH ROW EXECUTE FUNCTION espelhar_consentimento_de_marketing();

REVOKE EXECUTE ON FUNCTION espelhar_consentimento_de_marketing() FROM PUBLIC;

/**
 * As decisões que já existem viram a primeira linha do histórico.
 *
 * Sem isto, toda barbearia em operação ficaria com histórico vazio e coluna
 * preenchida — exatamente a divergência que este bloco existe para acabar. A
 * versão do texto de quem veio da coluna é preservada; quem não tinha nenhuma
 * entra como `importado`, que é a verdade: o aceite existe e a versão do texto
 * se perdeu antes deste bloco.
 */
INSERT INTO customer_consents (customer_id, tenant_id, purpose, granted,
                               text_version, ip, decided_at)
SELECT c.id, c.tenant_id, 'marketing', c.accepts_marketing,
       COALESCE(c.marketing_consent_version, 'importado'),
       c.marketing_consent_ip,
       COALESCE(c.marketing_consent_at, c.created_at)
  FROM customers c
 WHERE c.accepts_marketing OR c.marketing_consent_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- O encarregado (DPO), por barbearia
-- ---------------------------------------------------------------------------

/**
 * A barbearia é controladora; a plataforma é operadora (SPEC §1.8, regra 5).
 *
 * Por isso o encarregado é **dela** e não nosso: o titular que quer exercer um
 * direito fala com quem coletou o dado. Sem o campo, a página pública não teria
 * para quem apontar, e o pedido cairia no nosso suporte — que é operador e não
 * tem competência para responder.
 */
ALTER TABLE tenants
  ADD COLUMN dpo_name  text,
  ADD COLUMN dpo_email text,
  ADD CONSTRAINT tenants_dpo_email_formato CHECK (
    dpo_email IS NULL OR dpo_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  );

-- ---------------------------------------------------------------------------
-- O pedido do titular
-- ---------------------------------------------------------------------------

/**
 * `export` é o direito de acesso; `deletion` é o de exclusão (bloco 32).
 *
 * Os dois nascem juntos porque são o mesmo pedido do ponto de vista do prazo: a
 * SPEC §1.8 dá 15 dias, e um pedido sem registro de quando chegou não tem como
 * provar que foi atendido dentro dele.
 */
CREATE TYPE data_request_kind AS ENUM ('export', 'deletion');
CREATE TYPE data_request_status AS ENUM ('open', 'done', 'refused');

CREATE TABLE data_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id  uuid REFERENCES customers(id) ON DELETE SET NULL,

  kind         data_request_kind NOT NULL,
  status       data_request_status NOT NULL DEFAULT 'open',

  /**
   * O prazo, gravado na criação e não calculado na leitura.
   *
   * Quinze dias da SPEC §1.8. Calcular na tela faria o prazo mudar sozinho no
   * dia em que alguém decidisse que são vinte — inclusive para os pedidos
   * antigos, que foram feitos sob a regra anterior.
   */
  due_at       timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  settled_at   timestamptz,
  /** Por que foi recusado. Recusa sem motivo escrito não se defende. */
  note         text,

  CONSTRAINT data_requests_encerrado_tem_data CHECK (
    (status = 'open') = (settled_at IS NULL)
  ),
  CONSTRAINT data_requests_recusa_tem_motivo CHECK (
    status <> 'refused' OR length(btrim(coalesce(note, ''))) >= 3
  )
);

ALTER TABLE data_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON data_requests
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

/** "O que vence primeiro?" é a pergunta de quem responde pedido de titular. */
CREATE INDEX data_requests_a_vencer ON data_requests (due_at) WHERE status = 'open';

/**
 * Um pedido aberto por pessoa e por tipo.
 *
 * O titular pede pelo aplicativo dele e também pelo balcão, e o mesmo pedido
 * chega pelos dois caminhos — ele manda no WhatsApp, a recepção registra, e ele
 * clica no botão da própria tela achando que o primeiro não foi. Sem o índice,
 * a fila enche de duplicatas do mesmo direito e o prazo passa a ter duas
 * respostas.
 *
 * Parcial em `open`: pedir de novo depois de atendido é direito, não engano —
 * a pessoa pode querer uma cópia nova no ano seguinte.
 */
CREATE UNIQUE INDEX data_requests_um_aberto_por_tipo
  ON data_requests (customer_id, kind)
  WHERE status = 'open';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON data_requests TO barbearia_app;
  END IF;
END $$;
