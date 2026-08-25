-- ============================================================================
-- 0112 — congela os termos do pacote quando ele entra na comanda
--
-- O preço do pacote já era copiado para `order_items.unit_price_cents`, mas o
-- fechamento relia serviço, quantidade, validade e transferibilidade do
-- catálogo. Uma edição entre "adicionar" e "receber" podia, portanto, cobrar
-- o contrato antigo e entregar o novo. O item passa a ser o snapshot completo
-- do que foi oferecido ao cliente.
-- ============================================================================

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS package_snapshot_service_id uuid REFERENCES services(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS package_snapshot_quantity smallint,
  ADD COLUMN IF NOT EXISTS package_snapshot_validity_days integer,
  ADD COLUMN IF NOT EXISTS package_snapshot_transferable boolean;

-- Compatibilidade com comandas abertas no momento do deploy. Para vendas já
-- fechadas estes campos são históricos apenas; para abertas, esta é a melhor
-- fotografia recuperável no upgrade (o preço já continua sendo o congelado no
-- item). Novas inclusões gravam os quatro campos na mesma transação do item.
UPDATE order_items oi
   SET package_snapshot_service_id = p.service_id,
       package_snapshot_quantity = p.quantity,
       package_snapshot_validity_days = p.validity_days,
       package_snapshot_transferable = p.transferable
  FROM packages p
 WHERE oi.package_id = p.id
   AND oi.package_snapshot_service_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_pacote_snapshot_quantidade'
  ) THEN
    ALTER TABLE order_items
      ADD CONSTRAINT order_items_pacote_snapshot_quantidade CHECK (
    package_snapshot_quantity IS NULL OR package_snapshot_quantity BETWEEN 2 AND 100
  );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_pacote_snapshot_validade'
  ) THEN
    ALTER TABLE order_items
      ADD CONSTRAINT order_items_pacote_snapshot_validade CHECK (
    package_snapshot_validity_days IS NULL OR package_snapshot_validity_days BETWEEN 7 AND 3650
  );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_pacote_snapshot_coerente'
  ) THEN
    ALTER TABLE order_items
      ADD CONSTRAINT order_items_pacote_snapshot_coerente CHECK (
    (
      package_id IS NULL
      AND package_snapshot_service_id IS NULL
      AND package_snapshot_quantity IS NULL
      AND package_snapshot_validity_days IS NULL
      AND package_snapshot_transferable IS NULL
    ) OR (
      package_id IS NOT NULL
      AND kind = 'package'
      AND package_snapshot_service_id IS NOT NULL
      AND package_snapshot_quantity IS NOT NULL
      AND package_snapshot_transferable IS NOT NULL
    )
  );
  END IF;
END $$;

-- O catálogo de um pacote vendido deve ser desativado, não apagado. `SET NULL`
-- fazia o item perder a referência que prova qual produto gerou o benefício.
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_package_id_fkey;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_package_id_fkey'
  ) THEN
    ALTER TABLE order_items
      ADD CONSTRAINT order_items_package_id_fkey
  FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE RESTRICT;
  END IF;
END $$;
