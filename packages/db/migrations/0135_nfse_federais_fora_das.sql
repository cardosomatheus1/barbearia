-- regApTribSN=3: ME/EPP apura tributos federais e ISS pelas respectivas legislações.
-- O novo campo não altera o enquadramento de cadastros anteriores.
ALTER TABLE fiscal_native_settings ADD COLUMN federal_outside_das boolean NOT NULL DEFAULT false;
ALTER TABLE fiscal_native_settings ADD CONSTRAINT fiscal_federais_fora_das_iss
  CHECK (NOT federal_outside_das OR iss_outside_das);
