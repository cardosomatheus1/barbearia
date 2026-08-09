-- ============================================================================
-- 0028 — Feature flags, segundo fator da plataforma e impersonação auditada
--        (bloco 26, SPEC Parte 1 §1.2 e §1.7)
--
-- "controla feature flags; (…) executa suporte assistido; **impersona usuário
--  com registro de auditoria obrigatório**."
--
-- > Impersonação sem trilha auditável é incidente de LGPD esperando acontecer.
-- > O registro deve gravar quem impersonou, quando, por quanto tempo e o que
-- > acessou — e **o tenant deve poder consultar esse log**.
--
-- A última frase é a que decide o desenho. `platform_audit` não serve sozinha:
-- ela é da plataforma, e o dono da barbearia não a lê. Então a impersonação
-- escreve **nos dois lugares** — na trilha da plataforma, porque é ato de um
-- Super Admin, e no `audit_log` da barbearia, porque é a barbearia que tem
-- direito de saber que entraram na conta dela.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Segundo fator da plataforma — a lacuna que o bloco 24 declarou apontando aqui
-- ---------------------------------------------------------------------------

/**
 * Mesmas colunas de `staff_users`, e é de propósito.
 *
 * O `CLAUDE.md` exige segundo fator para quem move dinheiro. Quem bloqueia
 * todas as barbearias faz mais que isso, e a conta do Super Admin era a única
 * capacidade grave do produto atrás de senha sozinha.
 *
 * Reaproveitar o formato deixa o mesmo código de `@barbearia/identity` cifrar,
 * conferir e consumir o passo — inclusive a proteção contra reuso do código
 * dentro da janela de trinta segundos, que é fácil de esquecer ao reescrever.
 */
ALTER TABLE platform_admins
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_confirmed_at timestamptz,
  ADD COLUMN totp_last_step bigint,
  ADD COLUMN recovery_codes text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN platform_admins.totp_secret IS 'Segredo TOTP cifrado (AES-256-GCM).';

/** Quando **esta sessão** provou o segundo fator, como em `staff_sessions`. */
ALTER TABLE platform_sessions ADD COLUMN mfa_verified_at timestamptz;

-- ---------------------------------------------------------------------------
-- Feature flags
-- ---------------------------------------------------------------------------

/**
 * O catálogo do que pode ser ligado e desligado por barbearia.
 *
 * `code` é a chave e não o id: ele aparece no código, e um UUID ali só faria
 * a leitura de uma rota depender de uma consulta a mais.
 *
 * O catálogo é semeado por migração, não pela tela. Recurso é algo que **o
 * código sabe fazer** — inventar uma linha nova pelo painel criaria um
 * interruptor que não liga nada, que é o defeito de `blocks` outra vez.
 */
CREATE TABLE feature_flags (
  code            text PRIMARY KEY,
  name            text NOT NULL,
  description     text NOT NULL,
  /**
   * O padrão para quem nunca foi tocado.
   *
   * Ligado por padrão em recurso que já estava no ar — desligar o que as
   * barbearias já usam seria estrear a plataforma tirando função de todo mundo.
   */
  default_enabled boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flags FORCE ROW LEVEL SECURITY;

/**
 * Leitura ampla, escrita só pelo caminho de plataforma.
 *
 * A leitura é ampla porque a própria barbearia precisa saber o que tem ligado, e
 * o catálogo não guarda nada dela.
 *
 * A escrita é restrita a conexão **sem tenant fixado**, que é exatamente como a
 * camada de plataforma consulta (`semTenant`) e nunca como o produto consulta
 * (`withTenant`). Não é o isolamento clássico por `tenant_id` — aqui não há
 * tenant dono da linha —, é a mesma ideia pelo outro lado: quem está dentro de
 * uma barbearia não escreve aqui, aconteça o que acontecer com o código.
 *
 * A `/security-review` do bloco 26 apontou o risco em `tenant_features`, e ele
 * é o mesmo dos dois lados: a primeira rota de recurso voltada ao tenant se
 * tornaria escrita entre barbearias sem nada ficar vermelho.
 */
CREATE POLICY feature_flags_leitura ON feature_flags FOR SELECT USING (true);
CREATE POLICY feature_flags_escrita ON feature_flags FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

/**
 * O que cada barbearia tem, quando difere do padrão.
 *
 * Linha ausente significa "o padrão do catálogo". Guardar uma linha por
 * barbearia por recurso desde o começo faria mil barbearias virarem mil linhas
 * que dizem exatamente o que a coluna `default_enabled` já diz — e mudar o
 * padrão deixaria de mudar coisa alguma.
 */
CREATE TABLE tenant_features (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flag_code  text NOT NULL REFERENCES feature_flags(code) ON DELETE CASCADE,
  enabled    boolean NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, flag_code)
);

ALTER TABLE tenant_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_features FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_features_leitura ON tenant_features FOR SELECT USING (true);
-- Mesma regra do catálogo, e aqui ela importa mais: esta tabela **tem**
-- `tenant_id`, então uma escrita de dentro de uma barbearia seria escrita na
-- linha da vizinha.
CREATE POLICY tenant_features_escrita ON tenant_features FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

-- Os recursos que existem no dia um.
--
-- Três, e todos com consumidor de verdade neste mesmo bloco. Um interruptor a
-- mais seria mais fácil de escrever e não apagaria nada.
INSERT INTO feature_flags (code, name, description, default_enabled) VALUES
  ('fila',
   'Fila de espera',
   'Atendimento por ordem de chegada, com encaixe e link de posição para o cliente.',
   true),
  ('importacao',
   'Importar base de clientes',
   'Trazer a base do sistema antigo por planilha, com conferência e reversão.',
   true),
  ('avisos',
   'Avisos automáticos',
   'Confirmação, lembrete e mensagem de retorno enviados pelo sistema.',
   true)
ON CONFLICT (code) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON feature_flags, tenant_features TO barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Impersonação
-- ---------------------------------------------------------------------------

/**
 * A marca de que esta sessão de gestor não é de um gestor.
 *
 * Fica na **sessão** e não numa tabela paralela porque é a sessão que atravessa
 * cada requisição: `resolveStaffSession` já é lido em toda rota do painel, e
 * pendurar a marca ali significa que nenhuma rota consegue esquecer de
 * perguntar. Uma tabela à parte exigiria uma segunda consulta que alguém
 * eventualmente pularia.
 *
 * `ON DELETE SET NULL` e não `CASCADE`: apagar a conta do Super Admin não pode
 * apagar as sessões que ele abriu — elas são a prova de que ele entrou.
 */
ALTER TABLE staff_sessions
  ADD COLUMN impersonated_by uuid REFERENCES platform_admins(id) ON DELETE SET NULL;

COMMENT ON COLUMN staff_sessions.impersonated_by IS
  'Super Admin que abriu esta sessão de suporte. Nulo em sessão de gestor de verdade.';

-- Índice parcial: a pergunta "que sessões de suporte estão abertas?" só olha as
-- poucas linhas marcadas, e não a tabela inteira de sessões da plataforma.
CREATE INDEX staff_sessions_suporte
  ON staff_sessions (impersonated_by, expires_at)
  WHERE impersonated_by IS NOT NULL;

/**
 * O lado da plataforma da sessão de suporte.
 *
 * Parece duplicar `staff_sessions.impersonated_by`, e não duplica — as duas
 * respondem perguntas diferentes de lugares diferentes:
 *
 * - `staff_sessions.impersonated_by` é lido **dentro** do tenant, a cada
 *   requisição, e é o que faz o painel saber que está em modo suporte;
 * - esta tabela é lida **sem** tenant, e é o que responde "quais sessões de
 *   suporte estão abertas agora, em toda a plataforma?".
 *
 * A primeira versão tentou a segunda pergunta em `staff_sessions` e não podia
 * funcionar: a política dela é o isolamento clássico por `app.tenant_id`, então
 * uma consulta sem tenant devolve zero linhas — o mesmo erro que o bloco 20
 * cometeu na falta automática.
 *
 * E há um ganho que não era o motivo: `ended_at`. A SPEC pede **por quanto
 * tempo**, e revogar a sessão do lado do tenant não registra duração em lugar
 * nenhum que a plataforma leia.
 */
CREATE TABLE support_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  /** Sem `ON DELETE CASCADE`: o registro sobrevive à barbearia, como a trilha. */
  tenant_id   uuid NOT NULL,
  admin_id    uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  /** A sessão de gestor correspondente. Nulo depois que ela é limpa da tabela. */
  staff_session_id uuid,
  reason      text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  /** Quando foi encerrada de fato. Nulo é "ainda aberta ou vencida no prazo". */
  ended_at    timestamptz,
  CONSTRAINT suporte_tem_motivo CHECK (length(btrim(reason)) > 0),
  CONSTRAINT suporte_expira_depois CHECK (expires_at > started_at)
);

ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY support_sessions_acesso ON support_sessions FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX support_sessions_abertas ON support_sessions (expires_at DESC)
  WHERE ended_at IS NULL;
CREATE INDEX support_sessions_por_tenant ON support_sessions (tenant_id, started_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON support_sessions TO barbearia_app;
    -- Sem DELETE: apagar a sessão de suporte apagaria a prova de que ela existiu.
    REVOKE DELETE ON support_sessions FROM barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- O que **não** precisou de coluna nova
--
-- A trilha da barbearia. `audit_log.action` é texto livre no schema e fechado
-- no tipo do TypeScript — o vocabulário mora lá porque a trilha é lida
-- agrupada por ação, e ação inventada some do relatório sem dar erro nenhum.
-- O bloco 26 acrescenta três ao tipo, e elas respondem exatamente o que a SPEC
-- manda que o tenant possa consultar: quem entrou (`support.started`), o que
-- acessou (`support.accessed`) e por quanto tempo (`support.ended`).
--
-- `actor_name` guarda o nome do Super Admin, e `actor_id` o do gestor cuja
-- conta foi usada. É essa combinação que responde "quem entrou na minha conta"
-- sem inventar um usuário fantasma dentro da barbearia.
-- ---------------------------------------------------------------------------
