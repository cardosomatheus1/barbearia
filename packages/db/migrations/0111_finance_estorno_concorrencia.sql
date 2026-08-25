-- Auditoria Bloco 3 — concorrência e estorno financeiro.
--
-- 1. O fechamento da comanda passa a gravar fingerprint da intenção junto da
--    Idempotency-Key, para que a mesma chave não possa fechar outra intenção.
-- 2. O estorno externo ganha um lease persistente. A chamada ao adquirente
--    acontece fora da transação; sem este estado duas requisições podem ambas
--    sair para a rede antes de `psp_refund_id` existir.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS close_idempotency_fingerprint text;

ALTER TABLE order_charges
  ADD COLUMN IF NOT EXISTS refund_pending_at timestamptz;


CREATE INDEX IF NOT EXISTS order_charges_refund_pendente_idx
  ON order_charges (refund_pending_at)
  WHERE refund_pending_at IS NOT NULL;
