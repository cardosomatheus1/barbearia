-- ============================================================================
-- 0005 — Identidade do cliente final
--
-- Autenticação sem senha: telefone + código de uso único no WhatsApp
-- (SPEC Parte 1 §1.6). É o padrão que o sistema analisado acerta e que não pode
-- ser perdido — cliente de barbearia não instala app nem cria senha.
--
-- Nem o código nem o token de sessão são guardados em claro. Vazamento de dump
-- não pode virar acesso à conta de ninguém.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Desafio de OTP
--
-- Um desafio ativo por telefone por barbearia: reenviar substitui o código
-- anterior em vez de acumular códigos válidos.
-- ----------------------------------------------------------------------------

CREATE TABLE otp_challenges (
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_e164     text NOT NULL,

  -- SHA-256 do código. O código em si só existe no WhatsApp do cliente.
  code_hash      text NOT NULL,
  -- Nome informado antes do envio; vira o cadastro do cliente na confirmação.
  pending_name   text,

  attempts       smallint NOT NULL DEFAULT 0,
  max_attempts   smallint NOT NULL DEFAULT 5,
  -- Quantos envios seguidos para este telefone. Alimenta o cooldown progressivo.
  send_count     smallint NOT NULL DEFAULT 1,

  expires_at     timestamptz NOT NULL,
  last_sent_at   timestamptz NOT NULL DEFAULT now(),
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, phone_e164),
  CONSTRAINT otp_challenges_phone_format CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT otp_challenges_attempts_sane CHECK (attempts >= 0 AND max_attempts > 0),
  CONSTRAINT otp_challenges_send_count_positive CHECK (send_count > 0)
);

-- Faxina de desafios vencidos.
CREATE INDEX otp_challenges_expiry_idx ON otp_challenges (expires_at);

-- ----------------------------------------------------------------------------
-- Sessão do cliente
--
-- Token opaco, guardado apenas como hash. Não é JWT de propósito: revogação
-- imediata importa mais aqui do que evitar uma consulta por requisição.
-- ----------------------------------------------------------------------------

CREATE TABLE customer_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id    uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  token_hash     text NOT NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,

  -- Para auditoria e para revogar em lote quando algo cheira mal.
  user_agent     text,
  ip             inet
);

-- O hash é único globalmente: buscar sessão pelo token não pode depender de
-- saber o tenant antes, e colisão entre barbearias tornaria o token ambíguo.
CREATE UNIQUE INDEX customer_sessions_token_hash_key ON customer_sessions (token_hash);
CREATE INDEX customer_sessions_customer_idx ON customer_sessions (customer_id)
  WHERE revoked_at IS NULL;
CREATE INDEX customer_sessions_expiry_idx ON customer_sessions (expires_at);

-- ----------------------------------------------------------------------------
-- Consentimentos (SPEC Parte 1 §1.8)
--
-- Marketing é separado do necessário para executar o serviço. Agendar não
-- autoriza receber campanha, e a distinção precisa ser dado, não convenção.
-- ----------------------------------------------------------------------------

CREATE TYPE consent_purpose AS ENUM ('service', 'marketing', 'photos', 'photos_public');

CREATE TABLE customer_consents (
  customer_id    uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purpose        consent_purpose NOT NULL,
  granted        boolean NOT NULL,
  -- Data, IP e versão do texto: sem isso o consentimento não é comprovável.
  text_version   text NOT NULL,
  ip             inet,
  decided_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, purpose)
);

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['otp_challenges', 'customer_sessions', 'customer_consents']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    $p$, target);
  END LOOP;
END $$;
