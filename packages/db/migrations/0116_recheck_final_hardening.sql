-- Barberdock — Recheck final: hardening residual (2026-08-25)
--
-- A migração 0080 protegeu taxa e bloqueio contra escrita em contexto de tenant,
-- mas `plan_id` e `blocked_reason` ficaram fora do gatilho. Ambos também são
-- decisão da plataforma: o autoatendimento de plano entra por `semTenant` depois
-- de validar regras/rateio, e o motivo do bloqueio é trilha operacional.

CREATE OR REPLACE FUNCTION tenant_platform_termo_comercial() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '') IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.platform_fee_bps IS DISTINCT FROM OLD.platform_fee_bps
     OR NEW.marketplace_fee_bps IS DISTINCT FROM OLD.marketplace_fee_bps
     OR NEW.blocked_at IS DISTINCT FROM OLD.blocked_at
     OR NEW.blocked_reason IS DISTINCT FROM OLD.blocked_reason
  THEN
    RAISE EXCEPTION 'o termo comercial é da plataforma, não da barbearia'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END $$;
