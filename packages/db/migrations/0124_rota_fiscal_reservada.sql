-- Evita publicar /nota sobre um slug já atribuído. Se houver conflito legado,
-- a migração falha sem renomear a barbearia nem apagar seu endereço.
ALTER TABLE tenant_slugs ADD CONSTRAINT tenant_slug_rota_fiscal CHECK (slug <> 'nota');
