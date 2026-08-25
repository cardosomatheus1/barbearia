-- ============================================================================
-- 0111 — contrato estrutural do fechamento/estorno financeiro.
-- ============================================================================
\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

DO $$
DECLARE existe boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='orders'
       AND column_name='close_idempotency_fingerprint'
  ) INTO existe;
  IF NOT existe THEN RAISE EXCEPTION 'FALHOU: orders sem close_idempotency_fingerprint'; END IF;
  RAISE NOTICE 'OK 1 — fingerprint do fechamento existe';
END $$;

DO $$
DECLARE existe boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='order_charges'
       AND column_name='refund_pending_at'
  ) INTO existe;
  IF NOT existe THEN RAISE EXCEPTION 'FALHOU: order_charges sem refund_pending_at'; END IF;
  RAISE NOTICE 'OK 2 — lease de estorno existe';
END $$;

DO $$
DECLARE existe boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='order_charges'
       AND indexname='order_charges_refund_pendente_idx'
  ) INTO existe;
  IF NOT existe THEN RAISE EXCEPTION 'FALHOU: índice do refund pendente ausente'; END IF;
  RAISE NOTICE 'OK 3 — refund pendente é indexado';
END $$;
