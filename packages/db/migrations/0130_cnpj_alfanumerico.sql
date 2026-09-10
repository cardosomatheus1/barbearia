-- Ampliação de formato, sem apagar ou transformar cadastros/documentos existentes.
-- Reversão operacional: desabilitar novos cadastros; não remover dados alfanuméricos.
ALTER TABLE fiscal_settings DROP CONSTRAINT fiscal_settings_cnpj_so_digitos,
  ADD CONSTRAINT fiscal_settings_cnpj_formato CHECK (cnpj ~ '^[A-Z0-9]{12}[0-9]{2}$');
ALTER TABLE fiscal_certificates DROP CONSTRAINT fiscal_certificates_cnpj_check,
  ADD CONSTRAINT fiscal_certificates_cnpj_formato CHECK (cnpj ~ '^[A-Z0-9]{12}[0-9]{2}$');
ALTER TABLE fiscal_dps_counters DROP CONSTRAINT fiscal_dps_counters_cnpj_check,
  ADD CONSTRAINT fiscal_dps_counters_cnpj_formato CHECK (cnpj ~ '^[A-Z0-9]{12}[0-9]{2}$');
ALTER TABLE customers DROP CONSTRAINT customers_tax_id_formato,
  ADD CONSTRAINT customers_tax_id_formato CHECK (tax_id IS NULL OR tax_id ~ '^[0-9]{11}$' OR tax_id ~ '^[A-Z0-9]{12}[0-9]{2}$');
COMMENT ON COLUMN customers.tax_id IS 'CPF (11 dígitos) ou CNPJ (12 alfanuméricos e 2 DVs). Nulo = consumidor quando permitido.';
ALTER TABLE fiscal_native_documents DROP CONSTRAINT fiscal_native_documents_dps_id_check,
  ADD CONSTRAINT fiscal_native_documents_dps_id_formato CHECK (dps_id ~ '^DPS[0-9]{7}(1[0-9]{14}|2[A-Z0-9]{12}[0-9]{2})[0-9]{20}$'),
  DROP CONSTRAINT fiscal_native_documents_access_key_check,
  ADD CONSTRAINT fiscal_native_documents_access_key_formato CHECK (access_key IS NULL OR access_key ~ '^[0-9]{8}(1[0-9]{14}|2[A-Z0-9]{12}[0-9]{2})[0-9]{27}$');
