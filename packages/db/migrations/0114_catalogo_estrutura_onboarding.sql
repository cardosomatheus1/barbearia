-- 0114 — Catálogo/Estrutura/Onboarding: identidade estável do combo.
--
-- O catálogo diário ainda reconstruía o vínculo de combo por `name`, embora
-- `sold_as_service_id` exista desde 0011. Nome é rótulo editável; id é a
-- identidade. O backfill abaixo só converte legado quando há correspondência
-- 1:1 entre combo e serviço no mesmo tenant. Ambiguidade fica intocada para não
-- escolher silenciosamente a linha errada durante a migração.

WITH pares AS (
  SELECT sc.id AS combo_id,
         s.id AS service_id,
         count(*) OVER (PARTITION BY sc.id) AS servicos_para_combo,
         count(*) OVER (PARTITION BY s.id) AS combos_para_servico
    FROM service_combos sc
    JOIN services s
      ON s.tenant_id = sc.tenant_id
     AND lower(btrim(s.name)) = lower(btrim(sc.name))
   WHERE sc.sold_as_service_id IS NULL
)
UPDATE service_combos sc
   SET sold_as_service_id = p.service_id
  FROM pares p
 WHERE p.combo_id = sc.id
   AND p.servicos_para_combo = 1
   AND p.combos_para_servico = 1;

-- Uma linha vendável por serviço. O índice é por tenant também para expressar
-- a cardinalidade real e manter diagnósticos/índices alinhados à RLS.
CREATE UNIQUE INDEX IF NOT EXISTS service_combos_um_por_servico_vendido
  ON service_combos (tenant_id, sold_as_service_id)
  WHERE sold_as_service_id IS NOT NULL;
