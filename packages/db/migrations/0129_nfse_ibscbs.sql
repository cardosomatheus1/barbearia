-- Perfil explícito: não inferir enquadramento fiscal a partir do nome do serviço.
-- Reversão operacional: desabilitar a emissão; preservar snapshots já emitidos.
ALTER TABLE fiscal_native_settings ADD COLUMN ibscbs_profile text
  CHECK (ibscbs_profile IS NULL OR ibscbs_profile = 'regular_presencial');
ALTER TABLE fiscal_native_settings ADD CONSTRAINT fiscal_native_ibscbs_service CHECK (
  ibscbs_profile IS NULL OR (national_service_code = '060101' AND nbs IS NOT NULL AND nbs = '126021000')
);
