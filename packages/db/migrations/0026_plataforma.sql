-- ============================================================================
-- 0026 — Super Admin: planos, bloqueio de conta e a porta da plataforma
--        (SPEC Parte 1 §1.2)
--
-- "Administrador da plataforma SaaS. Visualiza tenants; cria e bloqueia contas;
--  altera planos."
--
-- ## O problema que este bloco tinha que resolver antes de escrever qualquer
-- ## coluna
--
-- O produto inteiro é construído sobre uma garantia: **ninguém lê fora do
-- próprio tenant**, e quem filtra é a política de RLS, não o `WHERE`. Repositório
-- que esquece o filtro não vaza, porque o banco recusa.
--
-- O Super Admin precisa exatamente do contrário: ver todas as barbearias.
--
-- A saída errada e tentadora é afrouxar a política de `tenants` para permitir
-- leitura ampla sob alguma condição. Seria fatal, e não pelo motivo óbvio: como
-- **nenhuma consulta do produto repete `tenant_id` no `WHERE`**, afrouxar a
-- política alarga em silêncio todas as consultas que já existem. A rede de
-- segurança que a regra descreve deixaria de existir no mesmo commit.
--
-- A saída daqui é a que o projeto já usa em `staff_directory`: **tabela de
-- plataforma, com política `USING (true)`, contendo só o que pode ser visto
-- globalmente**, e o que for sensível guardado em HMAC. Nenhuma política de
-- tabela de negócio é tocada. O Super Admin nunca lê `appointments`,
-- `customers` ou `orders` — ele lê as tabelas desta migração.
--
-- ## Por que o nome da barbearia é espelhado
--
-- `tenants.name` está atrás da RLS, e o painel da plataforma precisa listar
-- nomes. Espelhar parece duplicação, e é — mas o nome **já é público**: ele
-- aparece na página da barbearia para qualquer visitante. Espelhá-lo não revela
-- nada que o slug não revele, e o gatilho abaixo mantém os dois iguais sem
-- ninguém precisar lembrar.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Planos
-- ---------------------------------------------------------------------------

CREATE TABLE plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  /** Chave estável para o código: o nome muda, o `code` não. */
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  /**
   * Centavos inteiros, nunca float (CLAUDE.md). Zero é legítimo: é o plano de
   * cortesia, e é diferente de "sem plano".
   */
  price_cents  integer NOT NULL CHECK (price_cents >= 0),
  /**
   * Teto de cadeiras. `NULL` é ilimitado — e é diferente de zero, que seria um
   * plano onde ninguém pode trabalhar.
   */
  max_chairs   integer CHECK (max_chairs IS NULL OR max_chairs > 0),
  /**
   * Plano inativo não some: barbearia que já está nele continua nele. Ele só
   * deixa de ser oferecido. Apagar plano com tenant dentro reescreveria o
   * histórico de quanto cada uma pagava.
   */
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
-- Plano não pertence a barbearia nenhuma: é catálogo da plataforma. A leitura é
-- ampla porque a própria barbearia precisa saber em que plano está; a escrita
-- fica com a plataforma, que conecta pelo mesmo role mas passa pela guarda da
-- aplicação.
CREATE POLICY plans_leitura ON plans FOR SELECT USING (true);
CREATE POLICY plans_escrita ON plans FOR ALL USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- O espelho de plataforma de cada barbearia
-- ---------------------------------------------------------------------------

CREATE TABLE tenant_platform (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  /** Espelhado de `tenants.name` por gatilho. Já é público pela página. */
  name            text NOT NULL,
  plan_id         uuid REFERENCES plans(id) ON DELETE RESTRICT,

  /**
   * Bloqueio.
   *
   * `blocked_at` nulo é conta ativa. O motivo é obrigatório quando há bloqueio:
   * conta bloqueada sem motivo escrito vira discussão sem registro no dia em
   * que o dono liga reclamando — e é o suporte que perde.
   */
  blocked_at      timestamptz,
  blocked_reason  text,
  CONSTRAINT bloqueio_tem_motivo CHECK (
    (blocked_at IS NULL AND blocked_reason IS NULL)
    OR (blocked_at IS NOT NULL AND blocked_reason IS NOT NULL AND length(btrim(blocked_reason)) > 0)
  ),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_platform ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_platform FORCE ROW LEVEL SECURITY;
-- `USING (true)`, como `staff_directory`: é tabela de plataforma. O que ela
-- guarda — nome público, plano e estado de bloqueio — não é dado de cliente.
CREATE POLICY tenant_platform_leitura ON tenant_platform FOR SELECT USING (true);
CREATE POLICY tenant_platform_escrita ON tenant_platform FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX tenant_platform_bloqueadas ON tenant_platform (blocked_at) WHERE blocked_at IS NOT NULL;
CREATE INDEX tenant_platform_por_plano ON tenant_platform (plan_id);

/**
 * O espelho é mantido pelo banco, não pela aplicação.
 *
 * Se dependesse de a aplicação lembrar, ele estaria desatualizado no primeiro
 * caminho que criasse tenant sem passar pelo lugar certo — e o painel da
 * plataforma passaria a mostrar uma barbearia a menos, que é o tipo de erro que
 * ninguém percebe porque não dá tela vermelha.
 */
CREATE OR REPLACE FUNCTION espelhar_tenant_na_plataforma() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tenant_platform (tenant_id, name)
  VALUES (NEW.id, NEW.name)
  ON CONFLICT (tenant_id) DO UPDATE
    SET name = EXCLUDED.name, updated_at = now();
  RETURN NEW;
END $$;

CREATE TRIGGER tenants_espelha_plataforma
AFTER INSERT OR UPDATE OF name ON tenants
FOR EACH ROW EXECUTE FUNCTION espelhar_tenant_na_plataforma();

-- As barbearias que já existem entram no espelho agora.
INSERT INTO tenant_platform (tenant_id, name)
SELECT id, name FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- A porta da plataforma
-- ---------------------------------------------------------------------------

CREATE TABLE platform_admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  /**
   * HMAC do e-mail, nunca o e-mail.
   *
   * Mesma decisão de `staff_directory`, pelo mesmo motivo: a tabela não tem
   * isolamento, e e-mail em claro numa tabela de leitura ampla é dado pessoal
   * exposto a qualquer consulta que escape.
   */
  email_key     text NOT NULL UNIQUE,
  name          text NOT NULL,
  /** scrypt do `node:crypto`, com os parâmetros dentro do hash. */
  password_hash text NOT NULL,
  /** Conta desligada não some: a trilha de auditoria aponta para ela. */
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admins_acesso ON platform_admins FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE platform_sessions (
  /** SHA-256 do token. O token em si só existe no navegador de quem entrou. */
  token_hash  text PRIMARY KEY,
  admin_id    uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  CONSTRAINT sessao_expira_depois CHECK (expires_at > created_at)
);

ALTER TABLE platform_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_sessions_acesso ON platform_sessions FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX platform_sessions_por_admin ON platform_sessions (admin_id);

-- ---------------------------------------------------------------------------
-- A trilha da plataforma
-- ---------------------------------------------------------------------------

/**
 * Separada de `audit_log`, que é por barbearia.
 *
 * O que a plataforma faz — bloquear conta, trocar plano — não pertence a
 * nenhuma barbearia e não pode ser apagado junto com ela. Por isso a chave é
 * `tenant_id` **sem** `ON DELETE CASCADE`: se a barbearia sumir, o registro de
 * que ela foi bloqueada em tal dia continua.
 */
CREATE TABLE platform_audit (
  id          bigserial PRIMARY KEY,
  admin_id    uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  tenant_id   uuid,
  action      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_audit_acesso ON platform_audit FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX platform_audit_por_tenant ON platform_audit (tenant_id, created_at DESC);

-- Append-only pelo mesmo mecanismo do `audit_log`: o role da aplicação não
-- recebe UPDATE nem DELETE. Trilha que pode ser reescrita não é trilha.
REVOKE UPDATE, DELETE ON platform_audit FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT ON platform_audit TO barbearia_app;
    REVOKE UPDATE, DELETE ON platform_audit FROM barbearia_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON plans, tenant_platform, platform_admins, platform_sessions TO barbearia_app;
    GRANT USAGE, SELECT ON SEQUENCE platform_audit_id_seq TO barbearia_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Os planos que existem no dia um
-- ---------------------------------------------------------------------------

INSERT INTO plans (code, name, price_cents, max_chairs) VALUES
  ('cortesia', 'Cortesia', 0, 2),
  ('essencial', 'Essencial', 9900, 5),
  ('completo', 'Completo', 19900, NULL)
ON CONFLICT (code) DO NOTHING;
