-- ============================================================================
-- 0001 — Domínio Scheduling
--
-- Primeira fatia: multi-tenant, catálogo, jornadas e agendamentos.
-- SPEC Parte 1 §1.1 (isolamento) e Parte 2 §2.15 (integridade).
--
-- Duas garantias são impostas pelo banco, não pela aplicação:
--   1. Isolamento de tenant via RLS — um WHERE esquecido não vaza dados.
--   2. Ausência de overbooking via constraint de exclusão — corrida entre dois
--      clientes no mesmo slot é rejeitada pelo próprio Postgres.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
-- btree_gist permite misturar `uuid WITH =` e `tstzrange WITH &&` num EXCLUDE.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------

-- SPEC Parte 1 §1.4 — resolve o defeito D12 (agendas de balcão poluindo
-- relatórios de ocupação e comissão).
CREATE TYPE professional_kind AS ENUM ('professional', 'counter', 'resource_only', 'external');

-- SPEC Parte 2 §2.11. `cancelled_customer` e `cancelled_business` são
-- deliberadamente separados: só o primeiro afeta o reliability score.
CREATE TYPE appointment_status AS ENUM (
  'pending', 'confirmed', 'checked_in', 'waiting', 'in_progress', 'completed',
  'cancelled_customer', 'cancelled_business', 'no_show', 'rescheduled'
);

CREATE TYPE appointment_source AS ENUM (
  'website', 'app', 'whatsapp', 'instagram', 'google', 'marketplace',
  'reception', 'professional', 'api', 'recurrence', 'waitlist'
);

CREATE TYPE schedule_exception_type AS ENUM ('custom_hours', 'day_off', 'holiday', 'vacation');

CREATE TYPE slot_strategy AS ENUM ('anchored', 'grid');
CREATE TYPE buffer_policy AS ENUM ('outer', 'per_service');

-- ----------------------------------------------------------------------------
-- Tenant e estrutura
-- ----------------------------------------------------------------------------

CREATE TABLE tenants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- SPEC Parte 1 §1.5 — o slug é permanente. A barbearia analisada trocou de nome
-- (Box Seis -> Domari Barber Club) e o link da bio do Instagram continuou
-- funcionando. Slug antigo nunca pode quebrar.
CREATE TABLE tenant_slugs (
  slug         citext PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  is_primary   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_slugs_tenant_idx ON tenant_slugs (tenant_id);
CREATE UNIQUE INDEX tenant_slugs_one_primary ON tenant_slugs (tenant_id) WHERE is_primary;

CREATE TABLE locations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  -- Fuso IANA. Resolve o defeito D2: toda disponibilidade é calculada aqui,
  -- nunca com o offset do dispositivo do cliente.
  timezone              text NOT NULL DEFAULT 'America/Sao_Paulo',
  slot_strategy         slot_strategy NOT NULL DEFAULT 'anchored',
  buffer_policy         buffer_policy NOT NULL DEFAULT 'outer',
  granularity_minutes   smallint NOT NULL DEFAULT 5,
  min_lead_minutes      smallint NOT NULL DEFAULT 30,
  max_lead_days         smallint NOT NULL DEFAULT 60,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT locations_granularity_positive CHECK (granularity_minutes BETWEEN 1 AND 120),
  CONSTRAINT locations_lead_sane CHECK (min_lead_minutes >= 0 AND max_lead_days > 0)
);
CREATE INDEX locations_tenant_idx ON locations (tenant_id);

-- ----------------------------------------------------------------------------
-- Pessoas
-- ----------------------------------------------------------------------------

CREATE TABLE professionals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  kind          professional_kind NOT NULL DEFAULT 'professional',
  bookable_online boolean NOT NULL DEFAULT true,
  daily_limit   smallint,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT professionals_daily_limit_positive CHECK (daily_limit IS NULL OR daily_limit > 0)
);
CREATE INDEX professionals_location_idx ON professionals (location_id) WHERE active;

CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  -- E.164 normalizado. É a chave natural de deduplicação na importação
  -- (SPEC Parte 5 §5.8).
  phone_e164    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_phone_format CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$')
);
CREATE UNIQUE INDEX customers_tenant_phone_key ON customers (tenant_id, phone_e164);

-- ----------------------------------------------------------------------------
-- Catálogo
-- ----------------------------------------------------------------------------

CREATE TABLE service_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  position    smallint NOT NULL DEFAULT 0
);
CREATE INDEX service_categories_tenant_idx ON service_categories (tenant_id);

CREATE TABLE services (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id             uuid REFERENCES service_categories(id) ON DELETE SET NULL,
  name                    text NOT NULL,
  description             text,
  price_cents             integer NOT NULL,
  duration_minutes        smallint NOT NULL,
  buffer_before_minutes   smallint NOT NULL DEFAULT 0,
  buffer_after_minutes    smallint NOT NULL DEFAULT 0,
  bookable_online         boolean NOT NULL DEFAULT true,
  active                  boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- Validador de catálogo, regra V10 (SPEC Parte 5 §5.7).
  CONSTRAINT services_price_non_negative CHECK (price_cents >= 0),
  CONSTRAINT services_duration_positive CHECK (duration_minutes > 0),
  CONSTRAINT services_buffers_non_negative
    CHECK (buffer_before_minutes >= 0 AND buffer_after_minutes >= 0)
);
CREATE INDEX services_tenant_idx ON services (tenant_id) WHERE active;

-- Habilidade: quem executa o quê, com preço e duração próprios opcionais.
-- Herdado do concorrente (`get_profs_hab`) — evita agendamento inválido na
-- origem em vez de recusar depois.
CREATE TABLE professional_services (
  professional_id     uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  service_id          uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  price_cents         integer,
  duration_minutes    smallint,
  PRIMARY KEY (professional_id, service_id),
  CONSTRAINT professional_services_price_non_negative
    CHECK (price_cents IS NULL OR price_cents >= 0),
  CONSTRAINT professional_services_duration_positive
    CHECK (duration_minutes IS NULL OR duration_minutes > 0)
);
CREATE INDEX professional_services_service_idx ON professional_services (service_id);

-- SPEC Parte 2 §2.2 — combo só encurta se declarado. Sem esta tabela, a duração
-- é sempre a soma das partes (defeito D4).
CREATE TABLE service_combos (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                      text NOT NULL,
  declared_duration_minutes smallint NOT NULL,
  CONSTRAINT service_combos_duration_positive CHECK (declared_duration_minutes > 0)
);

CREATE TABLE service_combo_components (
  combo_id     uuid NOT NULL REFERENCES service_combos(id) ON DELETE CASCADE,
  service_id   uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (combo_id, service_id)
);

-- ----------------------------------------------------------------------------
-- Recursos (SPEC Parte 2 §2.3)
-- ----------------------------------------------------------------------------

CREATE TABLE resource_pools (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id    uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  resource_type  text NOT NULL,
  capacity       smallint NOT NULL,
  CONSTRAINT resource_pools_capacity_positive CHECK (capacity > 0)
);
CREATE UNIQUE INDEX resource_pools_location_type_key ON resource_pools (location_id, resource_type);

CREATE TABLE service_resource_requirements (
  service_id     uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  resource_type  text NOT NULL,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quantity       smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (service_id, resource_type),
  CONSTRAINT service_resource_requirements_quantity_positive CHECK (quantity > 0)
);

-- ----------------------------------------------------------------------------
-- Jornadas (SPEC Parte 2 §2.1)
-- ----------------------------------------------------------------------------

CREATE TABLE work_schedules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  professional_id   uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  weekday           smallint NOT NULL,
  start_minute      smallint NOT NULL,
  end_minute        smallint NOT NULL,
  -- [{"start":720,"end":780}] — suporta mais de um intervalo no dia.
  breaks            jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT work_schedules_weekday_range CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT work_schedules_minutes_range
    CHECK (start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute),
  CONSTRAINT work_schedules_breaks_is_array CHECK (jsonb_typeof(breaks) = 'array')
);
CREATE UNIQUE INDEX work_schedules_prof_weekday_key ON work_schedules (professional_id, weekday);

CREATE TABLE schedule_exceptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Exceção do profissional (professional_id) ou da unidade inteira (location_id).
  professional_id   uuid REFERENCES professionals(id) ON DELETE CASCADE,
  location_id       uuid REFERENCES locations(id) ON DELETE CASCADE,
  on_date           date NOT NULL,
  kind              schedule_exception_type NOT NULL,
  start_minute      smallint,
  end_minute        smallint,
  reason            text,
  CONSTRAINT schedule_exceptions_target
    CHECK (num_nonnulls(professional_id, location_id) = 1),
  CONSTRAINT schedule_exceptions_custom_hours_needs_range
    CHECK (kind <> 'custom_hours' OR (start_minute IS NOT NULL AND end_minute IS NOT NULL)),
  CONSTRAINT schedule_exceptions_minutes_range
    CHECK (start_minute IS NULL OR end_minute IS NULL
           OR (start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute))
);
CREATE INDEX schedule_exceptions_date_idx ON schedule_exceptions (on_date);

-- ----------------------------------------------------------------------------
-- Agendamentos
-- ----------------------------------------------------------------------------

CREATE TABLE appointments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id         uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  customer_id         uuid REFERENCES customers(id) ON DELETE SET NULL,
  professional_id     uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,

  -- Janela ocupada na agenda, com buffers. É o que governa a alocação.
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  -- Janela visível ao cliente, sem buffers. Separar as duas é o que permite
  -- buffer invisível sem mentir para o cliente (SPEC Parte 5 §5.5).
  service_starts_at   timestamptz NOT NULL,
  service_ends_at     timestamptz NOT NULL,

  status              appointment_status NOT NULL DEFAULT 'pending',
  source              appointment_source NOT NULL DEFAULT 'website',
  recurrence_id       uuid,
  rescheduled_from    uuid REFERENCES appointments(id) ON DELETE SET NULL,
  notes               text,

  price_cents         integer NOT NULL DEFAULT 0,
  discount_cents      integer NOT NULL DEFAULT 0,
  deposit_required_cents integer NOT NULL DEFAULT 0,
  deposit_paid_cents  integer NOT NULL DEFAULT 0,

  -- SPEC Parte 5 §5.6 — duplo toque em celular lento não gera dois agendamentos.
  idempotency_key     text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT appointments_window_valid CHECK (starts_at < ends_at),
  CONSTRAINT appointments_service_window_valid CHECK (service_starts_at < service_ends_at),
  CONSTRAINT appointments_service_within_occupied
    CHECK (service_starts_at >= starts_at AND service_ends_at <= ends_at),
  CONSTRAINT appointments_amounts_non_negative
    CHECK (price_cents >= 0 AND discount_cents >= 0
           AND deposit_required_cents >= 0 AND deposit_paid_cents >= 0)
);

CREATE INDEX appointments_professional_window_idx
  ON appointments (professional_id, starts_at)
  WHERE status NOT IN ('cancelled_customer', 'cancelled_business', 'no_show', 'rescheduled');

CREATE INDEX appointments_customer_idx ON appointments (customer_id, starts_at DESC);
CREATE INDEX appointments_location_window_idx ON appointments (location_id, starts_at);

CREATE UNIQUE INDEX appointments_idempotency_key
  ON appointments (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============================================================================
-- A garantia central: overbooking é impossível, não improvável.
--
-- O sistema analisado faz apenas checagem otimista antes de gravar. Sob carga
-- real, dois clientes que passam pela checagem antes de qualquer um gravar
-- produzem overbooking silencioso.
--
-- Aqui o próprio Postgres rejeita a segunda escrita. Statuses terminais são
-- excluídos: um horário cancelado volta a ficar livre.
-- SPEC Parte 2 §2.15.
-- ============================================================================
ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    professional_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (status NOT IN ('cancelled_customer', 'cancelled_business', 'no_show', 'rescheduled'));

CREATE TABLE appointment_services (
  appointment_id   uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id       uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  position         smallint NOT NULL DEFAULT 0,
  price_cents      integer NOT NULL,
  duration_minutes smallint NOT NULL,
  PRIMARY KEY (appointment_id, service_id),
  CONSTRAINT appointment_services_price_non_negative CHECK (price_cents >= 0),
  CONSTRAINT appointment_services_duration_positive CHECK (duration_minutes > 0)
);

-- Reserva temporária durante o pagamento do sinal (SPEC Parte 2 §2.15).
-- Sem isso, o cliente perde o horário enquanto digita o cartão.
CREATE TABLE slot_holds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  professional_id  uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slot_holds_window_valid CHECK (starts_at < ends_at)
);
CREATE INDEX slot_holds_expiry_idx ON slot_holds (expires_at);
CREATE INDEX slot_holds_professional_idx ON slot_holds (professional_id, starts_at);

-- ----------------------------------------------------------------------------
-- Row Level Security (SPEC Parte 1 §1.1)
--
-- Defesa em profundidade: o isolamento também é aplicado no repositório, mas um
-- WHERE esquecido não pode vazar dados entre barbearias.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'tenant_slugs', 'locations', 'professionals', 'customers',
    'service_categories', 'services', 'professional_services',
    'service_combos', 'service_combo_components',
    'resource_pools', 'service_resource_requirements',
    'work_schedules', 'schedule_exceptions',
    'appointments', 'appointment_services', 'slot_holds'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    $p$, target);
  END LOOP;
END $$;

-- `tenants` é isolada pela própria chave primária.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
