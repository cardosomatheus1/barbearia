-- Cadastro hospedado de cartão para a assinatura SaaS. Nunca armazena PAN/CVV.
-- A intenção é persistida antes de chamar a Stripe, para recuperar resposta perdida.
CREATE TABLE billing_setup_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_user_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  stripe_session_id text UNIQUE,
  stripe_url text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'applied', 'expired', 'superseded')),
  consent_version text NOT NULL,
  return_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  applied_at timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  CHECK (expires_at > created_at),
  CHECK ((state = 'applied') = (applied_at IS NOT NULL))
);
ALTER TABLE billing_setup_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_setup_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_setup_sessions_plataforma ON billing_setup_sessions FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);
CREATE INDEX billing_setup_sessions_pending ON billing_setup_sessions (created_at)
  WHERE state = 'pending';
CREATE INDEX billing_setup_sessions_tenant ON billing_setup_sessions (tenant_id, created_at DESC, id DESC);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT, UPDATE ON billing_setup_sessions TO barbearia_app;
  END IF;
END $$;
