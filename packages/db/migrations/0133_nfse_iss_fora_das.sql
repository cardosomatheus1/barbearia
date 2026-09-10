-- regApTribSN=2: tributos federais no SN, ISS apurado pela legislação municipal.
-- Cadastro anterior mantém ISS no DAS; o contribuinte escolhe a mudança.
ALTER TABLE fiscal_native_settings ADD COLUMN iss_outside_das boolean NOT NULL DEFAULT false;
ALTER TABLE fiscal_native_settings ADD CONSTRAINT fiscal_iss_fora_das_tributos
  CHECK (NOT iss_outside_das OR NOT enabled OR
    (approximate_federal_bps IS NOT NULL AND approximate_state_bps IS NOT NULL AND approximate_municipal_bps IS NOT NULL));
