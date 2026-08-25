-- Estorno online recuperável.
--
-- A venda local e o adquirente não compartilham transação. Guardar o refund no
-- próprio charge cria o ponto de recuperação: se a Stripe devolver o dinheiro
-- e o processo cair antes de marcar a comanda como estornada, a repetição vê o
-- mesmo refund e conclui somente a metade local, sem devolver duas vezes.

ALTER TABLE order_charges
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS psp_refund_id text,
  ADD COLUMN IF NOT EXISTS refunded_cents integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_charges_estorno_consistente'
  ) THEN
    ALTER TABLE order_charges
      ADD CONSTRAINT order_charges_estorno_consistente CHECK (
    (refunded_at IS NULL AND psp_refund_id IS NULL AND refunded_cents IS NULL)
    OR
    (refunded_at IS NOT NULL AND psp_refund_id IS NOT NULL AND refunded_cents IS NOT NULL
      AND refunded_cents > 0 AND refunded_cents <= amount_cents)
  );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS order_charges_psp_refund_idx
  ON order_charges (psp_refund_id)
  WHERE psp_refund_id IS NOT NULL;
