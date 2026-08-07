-- ============================================================================
-- 0003 — Recursos consumidos por agendamento
--
-- O motor checa capacidade de recurso comparando a janela candidata com as
-- janelas já ocupadas (SPEC Parte 2 §2.3). Para saber quais agendamentos
-- consomem qual recurso, a exigência é gravada **no momento da reserva** e não
-- derivada do catálogo na hora da consulta: o catálogo muda, o passado não.
-- ============================================================================

CREATE TABLE appointment_resources (
  appointment_id  uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  resource_type   text NOT NULL,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quantity        smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (appointment_id, resource_type),
  CONSTRAINT appointment_resources_quantity_positive CHECK (quantity > 0)
);

CREATE INDEX appointment_resources_type_idx ON appointment_resources (tenant_id, resource_type);

ALTER TABLE appointment_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON appointment_resources
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
