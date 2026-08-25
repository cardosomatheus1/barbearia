-- Repasse em voo precisa ser recuperável sem adivinhar os parâmetros originais.
ALTER TABLE payment_splits
  ADD COLUMN transfer_recipient_id text,
  ADD COLUMN transfer_payment_id text,
  ADD COLUMN recovery_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN clawback_reversal_entry_id uuid REFERENCES commission_entries(id) ON DELETE SET NULL;

CREATE INDEX payment_splits_recuperacao_idx
  ON payment_splits (tenant_id, updated_at)
  WHERE status = 'estornado' AND recovery_pending;
