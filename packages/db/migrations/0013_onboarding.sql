-- ============================================================================
-- 0013 — Estado do onboarding e formas de pagamento
--
-- A SPEC (Parte 1 §1.5) exige que **cada etapa seja salva individualmente**:
-- abandonar no passo 4 não pode perder os passos 1 a 3. Isso pede estado
-- persistido, não um formulário longo em memória — quem cadastra barbearia faz
-- isso no celular, entre um cliente e outro.
--
-- `published_at` separa "conta criada" de "link no ar". Sem essa distinção, uma
-- barbearia com catálogo pela metade já apareceria para o cliente final.
-- ============================================================================

ALTER TABLE tenants
  -- Última etapa concluída, 1 a 6. Guardar a concluída e não a "atual" evita
  -- ambiguidade quando o dono volta pelo meio.
  ADD COLUMN onboarding_step smallint NOT NULL DEFAULT 1,
  ADD COLUMN published_at timestamptz,
  ADD CONSTRAINT tenants_onboarding_step_range
    CHECK (onboarding_step BETWEEN 1 AND 6);

ALTER TABLE locations
  -- Lista fechada validada na aplicação, como `amenities`. Texto livre viraria
  -- vocabulário divergente entre barbearias e impediria filtro no marketplace.
  ADD COLUMN payment_methods text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN tenants.onboarding_step IS
  'Última etapa concluída do onboarding (1..6). O link só vai ao ar em 6.';

-- Duas categorias com o mesmo nome partiriam o cardápio em duas seções
-- idênticas, e o onboarding grava categoria a partir do que o dono digita —
-- então o caso é esperado, não hipotético.
ALTER TABLE service_categories
  ADD CONSTRAINT service_categories_name_unique UNIQUE (tenant_id, name);
