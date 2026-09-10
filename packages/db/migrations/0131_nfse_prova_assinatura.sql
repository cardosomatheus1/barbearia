-- Registro autenticado da validação feita no recebimento. Não presume prova
-- histórica para documentos anteriores; uma revalidação exige confiança atual.
ALTER TABLE fiscal_native_documents
  ADD COLUMN nfse_validation_cipher text,
  ADD COLUMN cancel_validation_cipher text,
  ADD CONSTRAINT fiscal_nfse_validation_document CHECK (nfse_validation_cipher IS NULL OR nfse_cipher IS NOT NULL),
  ADD CONSTRAINT fiscal_cancel_validation_document CHECK (cancel_validation_cipher IS NULL OR cancel_event_cipher IS NOT NULL);

CREATE FUNCTION fiscal_validation_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (OLD.nfse_validation_cipher IS NOT NULL AND NEW.nfse_validation_cipher IS DISTINCT FROM OLD.nfse_validation_cipher)
    OR (OLD.cancel_validation_cipher IS NOT NULL AND NEW.cancel_validation_cipher IS DISTINCT FROM OLD.cancel_validation_cipher)
  THEN RAISE EXCEPTION 'Validacao fiscal persistida e imutavel'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_validation_immutable BEFORE UPDATE ON fiscal_native_documents
FOR EACH ROW EXECUTE FUNCTION fiscal_validation_immutable();
REVOKE ALL ON FUNCTION fiscal_validation_immutable() FROM PUBLIC;
