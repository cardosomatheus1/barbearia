import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { loadDayContext } from './repository.js';
import { computeFromContext } from './service.js';

/**
 * Testes de integração do domínio Scheduling.
 *
 * Rodam contra Postgres real. Precisam de duas conexões:
 *
 *  - `DATABASE_URL`      superusuário, para semear (ignora RLS)
 *  - `APP_DATABASE_URL`  role `barbearia_app`, o mesmo que a API usa
 *
 * A separação é proposital: as consultas do repositório passam pela RLS de
 * verdade, então um vazamento de tenant aparece aqui e não em produção.
 *
 * Cenário: Domari Barber Club, com os dados extraídos da API do concorrente
 * (docs/01-analise-salonsoft.md).
 */

const ADMIN_URL = process.env['DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const GLEIDSON = 'bbbbbbbb-0000-0000-0000-000000000002';
const RECEPCAO = 'bbbbbbbb-0000-0000-0000-000000000003';
const CABELO = 'eeeeeeee-0000-0000-0000-000000000001';
const BARBA = 'eeeeeeee-0000-0000-0000-000000000002';

// 2026-08-11 é uma terça; 2026-08-10, uma segunda (dia de folga da equipe).
const TERCA = '2026-08-11';
const SEGUNDA = '2026-08-10';
// Referência fixa para o corte de antecedência mínima: bem antes das datas testadas.
const AGORA = new Date('2026-08-01T12:00:00Z');

/**
 * Executa um bloco SQL com vários comandos.
 *
 * `$executeRawUnsafe` usa prepared statement, que aceita um comando só. O seed
 * é dividido por `;` — seguro aqui porque nenhum literal do seed contém ponto e
 * vírgula.
 */
async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(statement);
  }
}

let admin: PrismaClient;
let app: PrismaClient;

const describeIfDb = ADMIN_URL && APP_URL ? describe : describe.skip;

describeIfDb('Scheduling — integração', () => {
  beforeAll(async () => {
    // Estreitamento explícito: `describeIfDb` já garante as duas, mas o
    // compilador não sabe disso — e a regra proíbe `!` para calar o tipo.
    if (!ADMIN_URL || !APP_URL) throw new Error('DATABASE_URL e APP_DATABASE_URL são obrigatórias');
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = new PrismaClient({ datasources: { db: { url: APP_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
    await app?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');

    await exec(admin, `
      INSERT INTO tenants (id, name) VALUES
        ('${TENANT}', 'Domari Barber Club'),
        ('${RIVAL}', 'Barbearia Rival');

      INSERT INTO tenant_slugs (slug, tenant_id, is_primary) VALUES
        ('domari', '${TENANT}', true),
        ('boxseisbarbearia', '${TENANT}', false);

      INSERT INTO locations (id, tenant_id, name, timezone, slot_strategy, granularity_minutes, min_lead_minutes)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia', 'anchored', 15, 30);

      INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
        ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional'),
        ('${GLEIDSON}', '${TENANT}', '${LOCATION}', 'Gleidson', 'professional'),
        ('${RECEPCAO}', '${TENANT}', '${LOCATION}', 'Recepcao', 'counter');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes) VALUES
        ('${CABELO}', '${TENANT}', 'Cabelo (Tesoura e/ou Maquinas)', 4900, 20),
        ('${BARBA}', '${TENANT}', 'Barba', 3500, 20);

      INSERT INTO professional_services (professional_id, service_id, tenant_id) VALUES
        ('${RUAN}', '${CABELO}', '${TENANT}'),
        ('${RUAN}', '${BARBA}', '${TENANT}'),
        ('${GLEIDSON}', '${CABELO}', '${TENANT}'),
        ('${GLEIDSON}', '${BARBA}', '${TENANT}'),
        ('${RECEPCAO}', '${CABELO}', '${TENANT}');

      -- Ruan e Gleidson: terça a sábado 09:00-18:00, domingo 09:00-13:00.
      -- Segunda não tem linha: é folga.
      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', p.id, d.weekday, 540, 1080
      FROM (VALUES ('${RUAN}'::uuid), ('${GLEIDSON}'::uuid)) AS p(id),
           (VALUES (2), (3), (4), (5), (6)) AS d(weekday);

      -- A agenda de balcão trabalha todo dia das 08:00 às 23:00 — exatamente o
      -- padrão encontrado no sistema real (defeito D12).
      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', '${RECEPCAO}', d.weekday, 480, 1380
      FROM (VALUES (0), (1), (2), (3), (4), (5), (6)) AS d(weekday);
    `);
  });

  /** Roda a pipeline completa com o role da aplicação, sujeita à RLS. */
  async function availability(params: {
    serviceIds: string[];
    date: string;
    professionalId?: string;
    collapse?: boolean;
    tenantId?: string;
  }) {
    return withTenant(
      params.tenantId ?? TENANT,
      async (tx) => {
        const context = await loadDayContext(tx, {
          locationId: LOCATION,
          serviceIds: params.serviceIds,
          date: params.date,
          ...(params.professionalId ? { professionalId: params.professionalId } : {}),
        });
        if (!context) return null;
        return computeFromContext(context, {
          date: params.date,
          now: AGORA,
          ...(params.collapse ? { collapse: true } : {}),
        });
      },
      { prisma: app },
    );
  }

  async function book(professionalId: string, startUtc: string, endUtc: string) {
    await exec(admin, `
      INSERT INTO appointments (tenant_id, location_id, professional_id,
        starts_at, ends_at, service_starts_at, service_ends_at, status)
      VALUES ('${TENANT}', '${LOCATION}', '${professionalId}',
        '${startUtc}', '${endUtc}', '${startUtc}', '${endUtc}', 'confirmed');
    `);
  }

  it('gera a grade do dia para os dois barbeiros', async () => {
    const result = await availability({ serviceIds: [CABELO], date: TERCA });

    expect(result?.timezone).toBe('America/Bahia');
    expect(result?.slots[0]?.start).toBe('09:00');
    expect(result?.slots.at(-1)?.start).toBe('17:40'); // slot de cauda
    expect(result?.unavailableReason).toBeNull();
  });

  it('exclui a agenda de balcão dos profissionais ofertados — defeito D12', async () => {
    const result = await availability({ serviceIds: [CABELO], date: TERCA });

    const ids = new Set(result?.slots.map((slot) => slot.professionalId));
    expect(ids).toEqual(new Set([RUAN, GLEIDSON]));
    expect(result?.professionals.map((p) => p.name)).toEqual(['Gleidson', 'Ruan']);
  });

  it('segunda-feira é folga da equipe', async () => {
    const result = await availability({ serviceIds: [CABELO], date: SEGUNDA });

    expect(result?.slots).toEqual([]);
    expect(result?.unavailableReason).toBe('closed');
    expect(result?.waitlistAvailable).toBe(false);
  });

  it('só oferece quem executa todos os serviços escolhidos', async () => {
    // Recepcao tem Cabelo mas não Barba — e mesmo com Cabelo já é `counter`.
    const result = await availability({ serviceIds: [CABELO, BARBA], date: TERCA });

    expect(result?.professionals).toHaveLength(2);
    expect(result?.serviceDurationMinutes).toBe(40); // soma real, sem combo declarado
  });

  it('agendamento existente some da grade e o seguinte encaixa junto', async () => {
    // 12:00Z = 09:00 na Bahia.
    await book(RUAN, '2026-08-11T12:00:00Z', '2026-08-11T12:20:00Z');

    const result = await availability({
      serviceIds: [CABELO],
      date: TERCA,
      professionalId: RUAN,
    });

    const starts = result?.slots.map((slot) => slot.start) ?? [];
    expect(starts).not.toContain('09:00');
    // Slot ancorado: nasce colado no fim do anterior, não na grade de 15.
    expect(starts[0]).toBe('09:20');
  });

  it('reserva temporária bloqueia o horário como se fosse agendamento', async () => {
    await exec(admin, `
      INSERT INTO slot_holds (tenant_id, professional_id, starts_at, ends_at, expires_at)
      VALUES ('${TENANT}', '${RUAN}', '2026-08-11T12:00:00Z', '2026-08-11T12:25:00Z',
              now() + interval '10 minutes');
    `);

    const result = await availability({
      serviceIds: [CABELO],
      date: TERCA,
      professionalId: RUAN,
    });
    expect(result?.slots.map((s) => s.start)).not.toContain('09:00');
  });

  it('reserva temporária expirada não bloqueia', async () => {
    await exec(admin, `
      INSERT INTO slot_holds (tenant_id, professional_id, starts_at, ends_at, expires_at)
      VALUES ('${TENANT}', '${RUAN}', '2026-08-11T12:00:00Z', '2026-08-11T12:25:00Z',
              now() - interval '1 minute');
    `);

    const result = await availability({
      serviceIds: [CABELO],
      date: TERCA,
      professionalId: RUAN,
    });
    expect(result?.slots[0]?.start).toBe('09:00');
  });

  it('aplica duração e preço próprios do profissional', async () => {
    await exec(admin, `
      UPDATE professional_services SET duration_minutes = 15, price_cents = 8000
      WHERE professional_id = '${RUAN}' AND service_id = '${CABELO}';
    `);

    const ruan = await availability({ serviceIds: [CABELO], date: TERCA, professionalId: RUAN });
    const gleidson = await availability({
      serviceIds: [CABELO], date: TERCA, professionalId: GLEIDSON,
    });

    expect(ruan?.serviceDurationMinutes).toBe(15);
    expect(gleidson?.serviceDurationMinutes).toBe(20);
    expect(ruan?.slots[0]?.price).toBe(8000);
    expect(gleidson?.slots[0]?.price).toBe(4900);
    // Serviço mais curto termina mais tarde no mesmo expediente: o último
    // início que cabe até as 18:00 é 17:45 para 15 min e 17:40 para 20 min.
    expect(ruan?.slots.at(-1)?.start).toBe('17:45');
    expect(gleidson?.slots.at(-1)?.start).toBe('17:40');
  });

  it('aplica combo declarado', async () => {
    await exec(admin, `
      INSERT INTO service_combos (id, tenant_id, name, declared_duration_minutes)
      VALUES ('ffffffff-0000-0000-0000-000000000001', '${TENANT}', 'Cabelo + Barba', 30);
      INSERT INTO service_combo_components (combo_id, service_id, tenant_id) VALUES
        ('ffffffff-0000-0000-0000-000000000001', '${CABELO}', '${TENANT}'),
        ('ffffffff-0000-0000-0000-000000000001', '${BARBA}', '${TENANT}');
    `);

    const comBarba = await availability({ serviceIds: [CABELO, BARBA], date: TERCA });
    expect(comBarba?.serviceDurationMinutes).toBe(30);

    // O combo não pode vazar para uma seleção que não casa exatamente.
    const soCabelo = await availability({ serviceIds: [CABELO], date: TERCA });
    expect(soCabelo?.serviceDurationMinutes).toBe(20);
  });

  it('respeita exceção de horário do profissional', async () => {
    await exec(admin, `
      INSERT INTO schedule_exceptions (tenant_id, professional_id, on_date, kind, start_minute, end_minute)
      VALUES ('${TENANT}', '${RUAN}', '${TERCA}', 'custom_hours', 480, 780);
    `);

    const result = await availability({ serviceIds: [CABELO], date: TERCA, professionalId: RUAN });
    expect(result?.slots[0]?.start).toBe('08:00');
    expect(result?.slots.at(-1)?.start).toBe('12:40');
  });

  it('feriado da unidade fecha o dia para todos', async () => {
    await exec(admin, `
      INSERT INTO schedule_exceptions (tenant_id, location_id, on_date, kind, reason)
      VALUES ('${TENANT}', '${LOCATION}', '${TERCA}', 'holiday', 'Feriado municipal');
    `);

    const result = await availability({ serviceIds: [CABELO], date: TERCA });
    expect(result?.slots).toEqual([]);
    expect(result?.unavailableReason).toBe('closed');
  });

  it('exceção do profissional vence o feriado da unidade', async () => {
    await exec(admin, `
      INSERT INTO schedule_exceptions (tenant_id, location_id, on_date, kind)
      VALUES ('${TENANT}', '${LOCATION}', '${TERCA}', 'holiday');
      INSERT INTO schedule_exceptions (tenant_id, professional_id, on_date, kind, start_minute, end_minute)
      VALUES ('${TENANT}', '${RUAN}', '${TERCA}', 'custom_hours', 600, 840);
    `);

    const result = await availability({ serviceIds: [CABELO], date: TERCA });
    const ids = new Set(result?.slots.map((s) => s.professionalId));
    expect(ids).toEqual(new Set([RUAN]));
    expect(result?.slots[0]?.start).toBe('10:00');
  });

  it('capacidade de recurso limita horários simultâneos', async () => {
    await exec(admin, `
      INSERT INTO resource_pools (tenant_id, location_id, resource_type, capacity)
      VALUES ('${TENANT}', '${LOCATION}', 'cadeira', 1);
      INSERT INTO service_resource_requirements (service_id, resource_type, tenant_id, quantity)
      VALUES ('${CABELO}', 'cadeira', '${TENANT}', 1);
    `);

    // Gleidson ocupa a única cadeira das 09:00 às 09:20 local.
    await exec(admin, `
      WITH novo AS (
        INSERT INTO appointments (tenant_id, location_id, professional_id,
          starts_at, ends_at, service_starts_at, service_ends_at, status)
        VALUES ('${TENANT}', '${LOCATION}', '${GLEIDSON}',
          '2026-08-11T12:00:00Z', '2026-08-11T12:20:00Z',
          '2026-08-11T12:00:00Z', '2026-08-11T12:20:00Z', 'confirmed')
        RETURNING id
      )
      INSERT INTO appointment_resources (appointment_id, resource_type, tenant_id, quantity)
      SELECT id, 'cadeira', '${TENANT}', 1 FROM novo;
    `);

    const result = await availability({ serviceIds: [CABELO], date: TERCA, professionalId: RUAN });
    // Ruan está livre, mas não há cadeira: o horário não é ofertado.
    expect(result?.slots.map((s) => s.start)).not.toContain('09:00');
    expect(result?.slots.map((s) => s.start)).toContain('09:20');
  });

  it('serviço que exige recurso inexistente na unidade não é ofertado', async () => {
    await exec(admin, `
      INSERT INTO service_resource_requirements (service_id, resource_type, tenant_id, quantity)
      VALUES ('${CABELO}', 'maca', '${TENANT}', 1);
    `);

    const result = await availability({ serviceIds: [CABELO], date: TERCA });
    expect(result?.slots).toEqual([]);
    expect(result?.unavailableReason).toBe('resource_unavailable');
    expect(result?.waitlistAvailable).toBe(true);
  });

  it('colapsa em um slot por horário para "qualquer profissional"', async () => {
    const todos = await availability({ serviceIds: [CABELO], date: TERCA });
    const colapsado = await availability({ serviceIds: [CABELO], date: TERCA, collapse: true });

    expect(todos!.slots.length).toBeGreaterThan(colapsado!.slots.length);
    const horarios = colapsado!.slots.map((s) => s.start);
    expect(new Set(horarios).size).toBe(horarios.length);
  });

  it('anexa o instante UTC a cada slot', async () => {
    const result = await availability({ serviceIds: [CABELO], date: TERCA });
    // 09:00 na Bahia (UTC-3) é 12:00Z.
    expect(result?.slots[0]?.startsAt).toBe('2026-08-11T12:00:00.000Z');
    expect(result?.slots[0]?.endsAt).toBe('2026-08-11T12:20:00.000Z');
  });

  it('serviço inexistente não devolve grade', async () => {
    const result = await availability({
      serviceIds: ['99999999-0000-0000-0000-000000000099'],
      date: TERCA,
    });
    expect(result).toBeNull();
  });

  it('RLS impede que o tenant rival enxergue esta unidade', async () => {
    const result = await availability({ serviceIds: [CABELO], date: TERCA, tenantId: RIVAL });
    // A unidade existe no banco, mas não para este tenant.
    expect(result).toBeNull();
  });
});
