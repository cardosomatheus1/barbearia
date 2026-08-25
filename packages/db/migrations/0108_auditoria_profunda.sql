-- Barberdock — endurecimento pós-auditoria profunda (2026-08-24)
--
-- Esta migration fecha invariantes que não são cobertas apenas por RLS por tenant:
-- idempotência com intenção/payload, fencing de workers/webhooks, KYC recuperável
-- e defaults inequívocos do papel owner em tenants já existentes.

-- ---------------------------------------------------------------------------
-- Idempotência financeira: a chave identifica uma intenção, não só uma linha.
-- ---------------------------------------------------------------------------
ALTER TABLE cash_movements
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;
ALTER TABLE account_transfers
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;
ALTER TABLE professional_advances
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;
ALTER TABLE customer_ledger
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;
ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;

ALTER TABLE loyalty_entries
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_entries_idempotency_idx
  ON loyalty_entries (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Fila/lista de espera: a mesma chave em outra unidade é outra intenção.
-- ---------------------------------------------------------------------------
ALTER TABLE queue_entries
  ADD COLUMN IF NOT EXISTS request_fingerprint text;

-- Backfill das intenções que já existiam antes desta migration. O formato é o
-- mesmo JSON compacto produzido por `JSON.stringify` no domínio, para que um
-- retry de uma chave antiga não seja falsamente tratado como payload diferente.
UPDATE queue_entries q
   SET request_fingerprint = replace(
     jsonb_build_array(
       q.location_id::text,
       q.customer_id::text,
       COALESCE((
         SELECT jsonb_agg(qes.service_id::text ORDER BY qes.service_id::text)
           FROM queue_entry_services qes
          WHERE qes.queue_entry_id = q.id
       ), '[]'::jsonb),
       q.professional_id::text,
       COALESCE(btrim(q.notes), '')
     )::text,
     ', ', ','
   )
 WHERE q.request_fingerprint IS NULL;

DROP INDEX IF EXISTS queue_entries_idempotency_idx;
CREATE UNIQUE INDEX IF NOT EXISTS queue_entries_idempotency_idx
  ON queue_entries (tenant_id, location_id, customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE waitlist_entries
  ADD COLUMN IF NOT EXISTS request_fingerprint text;

UPDATE waitlist_entries e
   SET request_fingerprint = replace(
     jsonb_build_array(
       e.location_id::text,
       e.customer_id::text,
       COALESCE((
         SELECT jsonb_agg(wes.service_id::text ORDER BY wes.service_id::text)
           FROM waitlist_entry_services wes
          WHERE wes.entry_id = e.id
       ), '[]'::jsonb),
       e.professional_id::text,
       e.wanted_from::text,
       e.wanted_to::text,
       e.window_start_minute,
       e.window_end_minute
     )::text,
     ', ', ','
   )
 WHERE e.request_fingerprint IS NULL;

DROP INDEX IF EXISTS waitlist_idempotencia_idx;
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_idempotencia_idx
  ON waitlist_entries (tenant_id, location_id, customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- O pedido repetido também é por unidade e pela composição completa do pedido.
--
-- `COALESCE` no fingerprint, e não `IS NOT NULL` no filtro: exigir fingerprint
-- para o índice valer deixa a linha sem ele fora da unicidade, e a mesma espera
-- entra duas vezes por qualquer caminho que não o preencha. A garantia antiga
-- — mesma faixa, mesma pessoa, mesma unidade — precisa continuar valendo
-- sozinha, e a composição de serviços só a torna mais fina.
DROP INDEX IF EXISTS waitlist_sem_repetido_idx;
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_sem_repetido_idx
  ON waitlist_entries (
    location_id, customer_id, wanted_from, wanted_to,
    window_start_minute, window_end_minute,
    COALESCE(professional_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(request_fingerprint, '')
  )
  WHERE status = 'waiting';

-- ---------------------------------------------------------------------------
-- KYC: a intenção em voo guarda fingerprint HMAC dos dados enviados, nunca PII.
-- ---------------------------------------------------------------------------
ALTER TABLE professionals
  ADD COLUMN IF NOT EXISTS psp_kyc_request_fingerprint varchar(64);

-- ---------------------------------------------------------------------------
-- Fencing: somente quem possui a claim atual pode finalizar uma execução.
-- ---------------------------------------------------------------------------
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS claim_token uuid;
CREATE INDEX IF NOT EXISTS jobs_claim_token_idx
  ON jobs (claim_token) WHERE claim_token IS NOT NULL;

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS webhook_deliveries_claim_idx
  ON webhook_deliveries (claim_expires_at)
  WHERE claim_token IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RBAC: owner é a única role cujo default é uma invariante do produto.
-- Não fazemos backfill cego de manager/receptionist/professional, porque essas
-- roles são editáveis e ausência pode ser uma decisão deliberada do cliente.
-- franchise.manage também NÃO é default: só a plataforma concede à franqueadora.
-- ---------------------------------------------------------------------------
INSERT INTO role_permissions (tenant_id, role, permission)
SELECT t.id, 'owner'::staff_role, p.permission
  FROM tenants t
 CROSS JOIN (VALUES
  ('appointments.view'), ('appointments.create'), ('appointments.cancel'),
  ('appointments.reschedule'), ('appointments.view_all_professionals'), ('appointments.attend'),
  ('cashier.open'), ('cashier.close'), ('cashier.withdraw'),
  ('finance.view'), ('finance.view_profit'), ('finance.export'), ('finance.discount'),
  ('finance.deposit'), ('finance.bills_manage'), ('finance.credit_limit'), ('finance.advance'),
  ('finance.order_refund'), ('finance.package_transfer'), ('finance.package_refund'), ('finance.subscription_manage'),
  ('finance.loyalty_adjust'), ('finance.split_manage'),
  ('commission.view_own'), ('commission.view_all'), ('commission.edit_rules'),
  ('customers.view'), ('customers.edit'), ('customers.export'), ('customers.view_photos'),
  ('customers.view_notes'), ('customers.edit_notes'), ('customers.manage_photos'), ('customers.anonymize'),
  ('customers.reliability_override'),
  ('feedback.view'), ('feedback.manage'),
  ('reviews.view'), ('reviews.recover'), ('reviews.contest'),
  ('fiscal.view'), ('fiscal.issue'), ('fiscal.settings'),
  ('reports.finance'), ('reports.operational'),
  ('inventory.view'), ('inventory.adjust'),
  ('marketing.send'), ('whatsapp.manage'), ('settings.manage'), ('team.manage')
 ) AS p(permission)
ON CONFLICT DO NOTHING;

-- Corrige owners novos/antigos que receberam franchise.manage pelo default incorreto,
-- sem remover a permissão de quem é de fato franqueadora.
DELETE FROM role_permissions rp
 WHERE rp.role = 'owner'::staff_role
   AND rp.permission = 'franchise.manage'
   AND NOT EXISTS (
     SELECT 1 FROM franchise_tenants ft
      WHERE ft.tenant_id = rp.tenant_id AND ft.role = 'franqueadora'
   );

-- Troca de plano também precisa de intenção persistida no downgrade, que não gera fatura.
CREATE TABLE IF NOT EXISTS subscription_change_intents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key   text NOT NULL,
  request_fingerprint text NOT NULL,
  from_plan         text NOT NULL,
  to_plan           text NOT NULL,
  charge_cents      integer NOT NULL DEFAULT 0,
  credit_cents      integer NOT NULL DEFAULT 0,
  days_remaining    integer NOT NULL DEFAULT 0,
  days_in_period    integer NOT NULL DEFAULT 0,
  invoice_id        uuid REFERENCES invoices(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

ALTER TABLE subscription_change_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_change_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscription_change_intents_leitura ON subscription_change_intents;
CREATE POLICY subscription_change_intents_leitura ON subscription_change_intents
  FOR SELECT USING (
    NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
DROP POLICY IF EXISTS subscription_change_intents_escrita ON subscription_change_intents;
CREATE POLICY subscription_change_intents_escrita ON subscription_change_intents
  FOR ALL
  USING (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barbearia_app') THEN
    GRANT SELECT, INSERT ON subscription_change_intents TO barbearia_app;
    REVOKE UPDATE, DELETE ON subscription_change_intents FROM barbearia_app;
  END IF;
END $$;
