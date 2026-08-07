-- ============================================================================
-- Testes de integridade do domínio Scheduling.
--
-- Roda contra um Postgres real: as garantias testadas aqui são do banco, não da
-- aplicação, então mock não prova nada.
--
--   psql -d barbearia -v ON_ERROR_STOP=1 -f 0001_scheduling.test.sql
--
-- Qualquer falha aborta com exceção. Saída limpa = tudo passou.
-- ============================================================================

\set ON_ERROR_STOP on
SET client_min_messages TO NOTICE;

BEGIN;

-- ----------------------------------------------------------------------------
-- Semente: duas barbearias distintas, para provar o isolamento.
-- ----------------------------------------------------------------------------

INSERT INTO tenants (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Domari Barber Club'),
  ('22222222-2222-2222-2222-222222222222', 'Barbearia Rival');

INSERT INTO tenant_slugs (slug, tenant_id, is_primary) VALUES
  ('domari', '11111111-1111-1111-1111-111111111111', true),
  -- Slug legado: a barbearia se chamava Box Seis e o link da bio não pode quebrar.
  ('boxseisbarbearia', '11111111-1111-1111-1111-111111111111', false),
  ('rival', '22222222-2222-2222-2222-222222222222', true);

INSERT INTO locations (id, tenant_id, name, timezone) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Matriz', 'America/Bahia'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'Unidade Rival', 'America/Sao_Paulo');

INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'Ruan', 'professional'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'Gleidson', 'professional'),
  -- Agenda de balcão: existe, mas não conta como profissional (defeito D12).
  ('bbbbbbbb-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'Recepcao', 'counter'),
  ('bbbbbbbb-0000-0000-0000-000000000009', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000002', 'Rival Barber', 'professional');

INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Carlos Souza', '+5571988887777'),
  ('cccccccc-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Joao Lima', '+5571977776666');

-- ----------------------------------------------------------------------------
-- 1. Overbooking é rejeitado pelo banco
-- ----------------------------------------------------------------------------

INSERT INTO appointments (
  id, tenant_id, location_id, customer_id, professional_id,
  starts_at, ends_at, service_starts_at, service_ends_at, status
) VALUES (
  'dddddddd-0000-0000-0000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'cccccccc-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001',
  '2026-08-11T12:00:00Z', '2026-08-11T12:25:00Z',
  '2026-08-11T12:00:00Z', '2026-08-11T12:20:00Z',
  'confirmed'
);

DO $$
BEGIN
  INSERT INTO appointments (
    tenant_id, location_id, customer_id, professional_id,
    starts_at, ends_at, service_starts_at, service_ends_at, status
  ) VALUES (
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-0000-0000-0000-000000000001',
    'cccccccc-0000-0000-0000-000000000002',
    'bbbbbbbb-0000-0000-0000-000000000001',
    '2026-08-11T12:10:00Z', '2026-08-11T12:35:00Z',
    '2026-08-11T12:10:00Z', '2026-08-11T12:30:00Z',
    'confirmed'
  );
  RAISE EXCEPTION 'FALHOU: overbooking sobreposto foi aceito';
EXCEPTION WHEN exclusion_violation THEN
  RAISE NOTICE 'OK 1 — sobreposição no mesmo profissional rejeitada pelo banco';
END $$;

-- ----------------------------------------------------------------------------
-- 2. Intervalo semiaberto: encostar não é sobrepor
-- ----------------------------------------------------------------------------

INSERT INTO appointments (
  id, tenant_id, location_id, customer_id, professional_id,
  starts_at, ends_at, service_starts_at, service_ends_at, status
) VALUES (
  'dddddddd-0000-0000-0000-000000000002',
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'cccccccc-0000-0000-0000-000000000002',
  'bbbbbbbb-0000-0000-0000-000000000001',
  -- Começa exatamente onde o anterior termina: é o encaixe justo do slot ancorado.
  '2026-08-11T12:25:00Z', '2026-08-11T12:50:00Z',
  '2026-08-11T12:25:00Z', '2026-08-11T12:45:00Z',
  'confirmed'
);
DO $$ BEGIN RAISE NOTICE 'OK 2 — encaixe justo aceito (tstzrange semiaberto)'; END $$;

-- ----------------------------------------------------------------------------
-- 3. Mesmo horário em profissional diferente é permitido
-- ----------------------------------------------------------------------------

INSERT INTO appointments (
  tenant_id, location_id, customer_id, professional_id,
  starts_at, ends_at, service_starts_at, service_ends_at, status
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'cccccccc-0000-0000-0000-000000000002',
  'bbbbbbbb-0000-0000-0000-000000000002',
  '2026-08-11T12:00:00Z', '2026-08-11T12:25:00Z',
  '2026-08-11T12:00:00Z', '2026-08-11T12:20:00Z',
  'confirmed'
);
DO $$ BEGIN RAISE NOTICE 'OK 3 — mesmo horário em outro profissional aceito'; END $$;

-- ----------------------------------------------------------------------------
-- 4. Cancelamento libera o horário
-- ----------------------------------------------------------------------------

UPDATE appointments SET status = 'cancelled_customer'
  WHERE id = 'dddddddd-0000-0000-0000-000000000001';

INSERT INTO appointments (
  id, tenant_id, location_id, customer_id, professional_id,
  starts_at, ends_at, service_starts_at, service_ends_at, status
) VALUES (
  'dddddddd-0000-0000-0000-000000000003',
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'cccccccc-0000-0000-0000-000000000002',
  'bbbbbbbb-0000-0000-0000-000000000001',
  '2026-08-11T12:00:00Z', '2026-08-11T12:25:00Z',
  '2026-08-11T12:00:00Z', '2026-08-11T12:20:00Z',
  'confirmed'
);
DO $$ BEGIN RAISE NOTICE 'OK 4 — vaga liberada por cancelamento pode ser reocupada'; END $$;

-- E não se pode ressuscitar o cancelado para cima do novo.
DO $$
BEGIN
  UPDATE appointments SET status = 'confirmed'
    WHERE id = 'dddddddd-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'FALHOU: reativação de cancelado gerou sobreposição';
EXCEPTION WHEN exclusion_violation THEN
  RAISE NOTICE 'OK 5 — reativar cancelado sobre horário já ocupado é rejeitado';
END $$;

-- ----------------------------------------------------------------------------
-- 5. Idempotência
-- ----------------------------------------------------------------------------

INSERT INTO appointments (
  tenant_id, location_id, professional_id,
  starts_at, ends_at, service_starts_at, service_ends_at, status, idempotency_key
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  '2026-08-11T14:00:00Z', '2026-08-11T14:25:00Z',
  '2026-08-11T14:00:00Z', '2026-08-11T14:20:00Z',
  'pending', 'req-abc-123'
);

DO $$
BEGIN
  INSERT INTO appointments (
    tenant_id, location_id, professional_id,
    starts_at, ends_at, service_starts_at, service_ends_at, status, idempotency_key
  ) VALUES (
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-0000-0000-0000-000000000001',
    'bbbbbbbb-0000-0000-0000-000000000002',
    '2026-08-11T15:00:00Z', '2026-08-11T15:25:00Z',
    '2026-08-11T15:00:00Z', '2026-08-11T15:20:00Z',
    'pending', 'req-abc-123'
  );
  RAISE EXCEPTION 'FALHOU: chave de idempotência duplicada foi aceita';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'OK 6 — duplo toque com a mesma Idempotency-Key rejeitado';
END $$;

-- ----------------------------------------------------------------------------
-- 6. Validações de catálogo e janela
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  INSERT INTO services (tenant_id, name, price_cents, duration_minutes)
  VALUES ('11111111-1111-1111-1111-111111111111', 'Serviço zerado', 4900, 0);
  RAISE EXCEPTION 'FALHOU: serviço com duração zero foi aceito';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 7 — serviço com duração zero rejeitado (validador V10)';
END $$;

DO $$
BEGIN
  INSERT INTO appointments (
    tenant_id, location_id, professional_id,
    starts_at, ends_at, service_starts_at, service_ends_at
  ) VALUES (
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-0000-0000-0000-000000000001',
    'bbbbbbbb-0000-0000-0000-000000000002',
    '2026-08-12T14:00:00Z', '2026-08-12T14:25:00Z',
    -- Janela visível maior que a ocupada: incoerente.
    '2026-08-12T13:50:00Z', '2026-08-12T14:20:00Z'
  );
  RAISE EXCEPTION 'FALHOU: janela de serviço fora da janela ocupada foi aceita';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 8 — janela de serviço precisa caber dentro da ocupada';
END $$;

DO $$
BEGIN
  INSERT INTO customers (tenant_id, name, phone_e164)
  VALUES ('11111111-1111-1111-1111-111111111111', 'Telefone Torto', '71988887777');
  RAISE EXCEPTION 'FALHOU: telefone fora do formato E.164 foi aceito';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK 9 — telefone precisa estar em E.164 (base da deduplicação)';
END $$;

-- ----------------------------------------------------------------------------
-- 7. Slug legado continua resolvendo
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  resolved uuid;
BEGIN
  -- citext: busca sem diferenciar maiúsculas.
  SELECT tenant_id INTO resolved FROM tenant_slugs WHERE slug = 'BoxSeisBarbearia';
  IF resolved IS DISTINCT FROM '11111111-1111-1111-1111-111111111111' THEN
    RAISE EXCEPTION 'FALHOU: slug legado não resolveu';
  END IF;
  RAISE NOTICE 'OK 10 — slug legado resolve, sem diferenciar maiúsculas';
END $$;

COMMIT;

-- ----------------------------------------------------------------------------
-- 8. Row Level Security
--
-- Precisa de role não-superusuário: superusuário ignora RLS por definição.
-- ----------------------------------------------------------------------------

-- O role já foi criado por scripts/bootstrap-role.sh e recebeu os privilégios
-- na migração 0002. Nenhuma credencial aqui.
SET ROLE barbearia_app;

-- Sem tenant no contexto: nada é visível.
DO $$
DECLARE
  visible integer;
BEGIN
  PERFORM set_config('app.tenant_id', '', true);
  SELECT count(*) INTO visible FROM appointments;
  IF visible <> 0 THEN
    RAISE EXCEPTION 'FALHOU: % agendamentos visíveis sem tenant no contexto', visible;
  END IF;
  RAISE NOTICE 'OK 11 — sem tenant no contexto, nada é visível';
END $$;

-- Com o tenant 1: vê só o que é dele.
DO $$
DECLARE
  mine integer;
  theirs integer;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);

  SELECT count(*) INTO mine FROM appointments;
  IF mine = 0 THEN
    RAISE EXCEPTION 'FALHOU: tenant não enxerga os próprios agendamentos';
  END IF;

  -- Consulta deliberadamente sem filtro de tenant — o "WHERE esquecido".
  SELECT count(*) INTO theirs FROM professionals
    WHERE tenant_id = '22222222-2222-2222-2222-222222222222';
  IF theirs <> 0 THEN
    RAISE EXCEPTION 'FALHOU: vazou % profissionais do outro tenant', theirs;
  END IF;

  RAISE NOTICE 'OK 12 — tenant enxerga % agendamentos e zero dados do rival', mine;
END $$;

-- Não se pode gravar em nome de outro tenant.
DO $$
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO customers (tenant_id, name, phone_e164)
  VALUES ('22222222-2222-2222-2222-222222222222', 'Espiao', '+5511999998888');
  RAISE EXCEPTION 'FALHOU: gravou registro em nome de outro tenant';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'OK 13 — WITH CHECK impede gravar em nome de outro tenant';
END $$;

RESET ROLE;

DO $$ BEGIN RAISE NOTICE '--- todos os invariantes passaram ---'; END $$;
