-- Perfil não optante pelo Simples e percentuais informativos da Lei 12.741.
-- Os valores permanecem nulos até serem informados; zero não é um padrão fiscal.
-- Reversão operacional: desabilitar o perfil; preservar enum/dados já usados por notas.
ALTER TYPE fiscal_regime ADD VALUE IF NOT EXISTS 'normal';
ALTER TABLE fiscal_native_settings
  ADD COLUMN approximate_federal_bps integer CHECK (approximate_federal_bps BETWEEN 0 AND 10000),
  ADD COLUMN approximate_state_bps integer CHECK (approximate_state_bps BETWEEN 0 AND 10000),
  ADD COLUMN approximate_municipal_bps integer CHECK (approximate_municipal_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT fiscal_native_approximate_complete CHECK (
    (approximate_federal_bps IS NULL AND approximate_state_bps IS NULL AND approximate_municipal_bps IS NULL)
    OR (approximate_federal_bps IS NOT NULL AND approximate_state_bps IS NOT NULL AND approximate_municipal_bps IS NOT NULL)
  );
