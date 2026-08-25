/**
 * O estorno de crédito da plataforma precisa saber **qual cobrança** ele
 * devolve também depois de uma queda de rede.
 *
 * Antes, `refunds.status='pending'` era descrito como retomável, mas a tabela
 * não guardava `psp_charge_id`; repetir a operação teria que procurar outra vez
 * a última fatura paga, que pode já ser outra. A origem passa a nascer junto
 * com o lançamento e fica imutável como valor/motivo/tenant.
 */
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS psp_charge_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'refunds_charge_id_nao_vazio'
  ) THEN
    ALTER TABLE refunds
      ADD CONSTRAINT refunds_charge_id_nao_vazio
  CHECK (psp_charge_id IS NULL OR length(btrim(psp_charge_id)) > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS refunds_pendentes_recuperaveis_idx
  ON refunds (created_at)
  WHERE status = 'pending' AND psp_charge_id IS NOT NULL;
