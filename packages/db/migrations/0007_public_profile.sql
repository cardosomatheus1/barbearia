-- ============================================================================
-- 0007 — Perfil público da unidade
--
-- Resolve os defeitos D8 e D9 da análise: a página do sistema estudado não tem
-- endereço, mapa, telefone, horário de funcionamento, nem descrição ou foto de
-- serviço. Metade das visitas de uma página de barbearia é gente perguntando
-- "onde fica?" e "está aberto?" — e essa metade hoje não é atendida.
-- ============================================================================

ALTER TABLE tenants
  ADD COLUMN logo_url text,
  ADD COLUMN instagram text;

ALTER TABLE locations
  ADD COLUMN street text,
  ADD COLUMN district text,
  ADD COLUMN city text,
  ADD COLUMN state char(2),
  ADD COLUMN postal_code text,
  ADD COLUMN latitude numeric(9, 6),
  ADD COLUMN longitude numeric(9, 6),
  ADD COLUMN phone_e164 text,
  ADD COLUMN whatsapp_e164 text,
  ADD COLUMN cover_url text,
  ADD COLUMN about text,
  -- Estacionamento, acessibilidade, wi-fi, formas de pagamento. Lista fechada
  -- validada na aplicação; texto livre aqui viraria vocabulário divergente
  -- entre barbearias e impossibilitaria filtro no marketplace.
  ADD COLUMN amenities text[] NOT NULL DEFAULT '{}',
  ADD COLUMN cancellation_policy text,
  ADD CONSTRAINT locations_phone_format
    CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT locations_whatsapp_format
    CHECK (whatsapp_e164 IS NULL OR whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- Latitude sem longitude não localiza nada; ou vêm as duas ou nenhuma.
  ADD CONSTRAINT locations_coords_together
    CHECK (num_nonnulls(latitude, longitude) <> 1),
  ADD CONSTRAINT locations_latitude_range
    CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT locations_longitude_range
    CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);

ALTER TABLE professionals
  ADD COLUMN bio text,
  ADD COLUMN photo_url text;

ALTER TABLE services
  ADD COLUMN photo_url text;

COMMENT ON COLUMN locations.amenities IS
  'Lista fechada validada na aplicação: parking, accessible, wifi, card, pix, cash.';
