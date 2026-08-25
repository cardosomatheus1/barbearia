-- ============================================================================
-- 0112 — contrato estrutural do snapshot de pacote na comanda.
-- ============================================================================
\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

DO $$
DECLARE faltantes integer;
BEGIN
  SELECT count(*) INTO faltantes
    FROM (VALUES
      ('package_snapshot_service_id'),
      ('package_snapshot_quantity'),
      ('package_snapshot_validity_days'),
      ('package_snapshot_transferable')
    ) AS esperada(nome)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name='order_items'
        AND c.column_name=esperada.nome
   );
  IF faltantes <> 0 THEN RAISE EXCEPTION 'FALHOU: snapshot de pacote incompleto em order_items'; END IF;
  RAISE NOTICE 'OK 1 — quatro termos mutáveis do pacote ficam congelados no item';
END $$;

DO $$
DECLARE existe boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='order_items'::regclass
       AND conname='order_items_pacote_snapshot_coerente'
       AND contype='c'
  ) INTO existe;
  IF NOT existe THEN RAISE EXCEPTION 'FALHOU: constraint de coerência do snapshot ausente'; END IF;
  RAISE NOTICE 'OK 2 — pacote não pode existir com snapshot estrutural incompleto';
END $$;

DO $$
DECLARE regra "char";
BEGIN
  SELECT confdeltype INTO regra
    FROM pg_constraint
   WHERE conrelid='order_items'::regclass
     AND conname='order_items_package_id_fkey'
     AND contype='f';
  -- 'r' = RESTRICT. O catálogo vendido é desativado, não apagado por baixo do item.
  IF regra IS DISTINCT FROM 'r'::"char" THEN
    RAISE EXCEPTION 'FALHOU: package_id ainda pode sumir do item por ON DELETE';
  END IF;
  RAISE NOTICE 'OK 3 — referência do pacote vendido usa ON DELETE RESTRICT';
END $$;
