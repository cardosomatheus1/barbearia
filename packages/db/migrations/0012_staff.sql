-- ============================================================================
-- 0012 — Conta de gestor
--
-- Até aqui só o cliente final tinha identidade (telefone + código no WhatsApp).
-- Quem administra a barbearia não tinha conta nenhuma: o catálogo, a equipe e as
-- jornadas entravam por SQL. Sem isto o produto não é SaaS, é instalação manual.
--
-- Três tabelas e uma decisão que merece explicação:
--
--   staff_users      — pessoa que administra, dentro de um tenant, com RLS
--   staff_sessions   — sessão opaca, mesmo padrão de `customer_sessions`
--   staff_directory  — índice **entre tenants** de e-mail para tenant
--
-- O diretório existe porque o login por e-mail acontece **antes** de saber qual
-- é o tenant, e a RLS exige o tenant fixado para enxergar qualquer linha. Sem
-- ele, o gestor teria que digitar o slug da própria barbearia para entrar.
--
-- E ele guarda `email_key`, não o e-mail: é uma tabela sem RLS por natureza, e
-- em claro seria a lista de clientes da plataforma — todo dono de barbearia,
-- pronta para spam e para engenharia social. A chave é HMAC-SHA256 do e-mail
-- normalizado com um segredo de ambiente, calculado na aplicação. Um dump do
-- banco não devolve nenhum endereço.
-- ============================================================================

CREATE TYPE staff_role AS ENUM ('owner', 'manager', 'receptionist', 'professional');

CREATE TABLE staff_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  email         citext NOT NULL,
  phone_e164    text,
  -- Formato `scrypt$N$r$p$salt$hash`, com os parâmetros dentro: quando o custo
  -- subir, hash antigo continua verificável e é regravado no próximo login.
  password_hash text NOT NULL,
  role          staff_role NOT NULL DEFAULT 'owner',
  /**
   * Vínculo opcional com a agenda. O dono que também corta cabelo é uma pessoa
   * só — sem isto, viraria dois cadastros e duas comissões.
   */
  professional_id uuid REFERENCES professionals(id) ON DELETE SET NULL,
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT staff_users_email_format CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT staff_users_phone_format CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- Duas contas com o mesmo e-mail na mesma barbearia tornariam o login ambíguo.
  CONSTRAINT staff_users_email_unique UNIQUE (tenant_id, email)
);

CREATE INDEX staff_users_tenant_idx ON staff_users (tenant_id);

CREATE TABLE staff_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_user_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  -- Só o hash. Vazamento de backup não vira sessão ativa de ninguém.
  token_hash    text NOT NULL UNIQUE,
  user_agent    text,
  ip            inet,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX staff_sessions_user_idx ON staff_sessions (staff_user_id);
-- A varredura de expiradas roda por data; sem índice ela lê a tabela inteira.
CREATE INDEX staff_sessions_expiry_idx ON staff_sessions (expires_at);

/**
 * Índice de login, entre tenants.
 *
 * Sem `tenant_id` na política porque a pergunta que ela responde acontece antes
 * de existir tenant no contexto. O que a protege é não guardar dado legível:
 * `email_key` é HMAC, e nada mais além do destino.
 */
CREATE TABLE staff_directory (
  email_key     text PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_user_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE staff_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_users
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE staff_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_sessions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- `staff_directory` fica deliberadamente fora da RLS: é o índice que resolve
-- e-mail para tenant, e uma política por tenant o tornaria inútil. A proteção é
-- o conteúdo — só HMAC e destino, nenhum dado legível.
ALTER TABLE staff_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_directory FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_directory_lookup ON staff_directory
  USING (true)
  WITH CHECK (true);

-- Sem GRANT explícito: a migração 0002 já deixou `ALTER DEFAULT PRIVILEGES`
-- valendo para tabelas futuras.
