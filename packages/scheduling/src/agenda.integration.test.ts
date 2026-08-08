import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createException, deleteException, getAgenda } from './agenda.js';
import { getAvailabilityRange } from './service.js';
import { createAppointment } from './booking.js';

/**
 * Agenda do admin e exceções, contra Postgres real.
 *
 * O que se prova aqui, e que nunca teve prova: que **escrever** em
 * `schedule_exceptions` recorta a grade de verdade. O motor lê essa tabela
 * desde o bloco 1 e nada nunca escreveu nela — o teste que faltava não era do
 * motor, era do caminho inteiro.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOCAL_RIVAL = 'aaaaaaaa-0000-0000-0000-000000000002';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const GLEIDSON = 'bbbbbbbb-0000-0000-0000-000000000002';
const CABELO = 'eeeeeeee-0000-0000-0000-000000000001';
const CARLOS = 'cccccccc-0000-0000-0000-000000000001';
const TZ = 'America/Bahia';

// Sexta-feira. `AGORA` fica bem antes para não esbarrar em antecedência.
const SEXTA = '2026-08-14';
const AGORA = new Date('2026-08-01T12:00:00Z');

let admin: PrismaClient;

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(parte);
  }
}

const agenda = (from = SEXTA, to = SEXTA) =>
  getAgenda({ tenantId: TENANT, locationId: LOCATION, timezone: TZ, from, to });

const grade = (date = SEXTA) =>
  getAvailabilityRange({
    tenantId: TENANT,
    locationId: LOCATION,
    serviceIds: [CABELO],
    dateFrom: date,
    dateTo: date,
    now: AGORA,
  });

describeIfDb('agenda e exceções', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(admin, `
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Rival');

      INSERT INTO locations (id, tenant_id, name, timezone, granularity_minutes,
                             min_lead_minutes)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', '${TZ}', 30, 0),
             ('${LOCAL_RIVAL}', '${RIVAL}', 'Rival', '${TZ}', 30, 0);

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional'),
             ('${GLEIDSON}', '${TENANT}', '${LOCATION}', 'Gleidson', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', 'Cabelo', 4900, 30);

      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      VALUES ('${RUAN}', '${CABELO}', '${TENANT}'),
             ('${GLEIDSON}', '${CABELO}', '${TENANT}');

      -- 09:00 às 18:00, todos os dias, para os dois.
      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', p.id, d.weekday, 540, 1080
      FROM (VALUES ('${RUAN}'::uuid), ('${GLEIDSON}'::uuid)) AS p(id),
           (VALUES (0), (1), (2), (3), (4), (5), (6)) AS d(weekday);

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');
    `);
  });

  const marcar = (start: string, professionalId = RUAN) =>
    createAppointment({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId,
      serviceIds: [CABELO],
      date: SEXTA,
      start,
      customerId: CARLOS,
      now: AGORA,
    });

  const bloquear = (extra: Record<string, unknown> = {}) =>
    createException({
      tenantId: TENANT,
      locationId: LOCATION,
      timezone: TZ,
      kind: 'block',
      date: SEXTA,
      startMinute: 840,
      endMinute: 900,
      professionalId: RUAN,
      reason: 'Dentista',
      ...extra,
    });

  // -- o que este bloco existe para provar -----------------------------------

  it('bloqueio criado pela tela recorta a grade de verdade', async () => {
    const antes = await grade();
    const horariosAntes = antes.days[0]?.slots.filter((s) => s.professionalId === RUAN) ?? [];
    expect(horariosAntes.some((s) => s.start === '14:00')).toBe(true);

    const criado = await bloquear();
    expect(criado.saved).toBe(true);

    const depois = await grade();
    const horariosDepois = depois.days[0]?.slots.filter((s) => s.professionalId === RUAN) ?? [];

    // 14:00 e 14:30 caíam dentro do bloqueio das 14h às 15h.
    expect(horariosDepois.some((s) => s.start === '14:00')).toBe(false);
    expect(horariosDepois.some((s) => s.start === '14:30')).toBe(false);
    // E o resto do dia continua aberto: bloquear uma hora não fecha o dia.
    expect(horariosDepois.some((s) => s.start === '10:00')).toBe(true);
    // O colega não foi bloqueado junto.
    expect(depois.days[0]?.slots.some((s) => s.professionalId === GLEIDSON)).toBe(true);
  });

  it('folga do profissional fecha o dia dele e só o dele', async () => {
    await createException({
      tenantId: TENANT,
      locationId: LOCATION,
      timezone: TZ,
      kind: 'day_off',
      date: SEXTA,
      professionalId: RUAN,
      reason: 'Folga',
    });

    const depois = await grade();
    const slots = depois.days[0]?.slots ?? [];
    expect(slots.some((s) => s.professionalId === RUAN)).toBe(false);
    expect(slots.some((s) => s.professionalId === GLEIDSON)).toBe(true);
  });

  it('feriado da unidade fecha a barbearia inteira', async () => {
    await createException({
      tenantId: TENANT,
      locationId: LOCATION,
      timezone: TZ,
      kind: 'holiday',
      date: SEXTA,
      reason: 'Feriado municipal',
    });

    const depois = await grade();
    expect(depois.days[0]?.slots ?? []).toEqual([]);
  });

  it('horário diferente num dia substitui a jornada daquele dia', async () => {
    await createException({
      tenantId: TENANT,
      locationId: LOCATION,
      timezone: TZ,
      kind: 'custom_hours',
      date: SEXTA,
      startMinute: 540,
      endMinute: 720,
      professionalId: RUAN,
      reason: 'Sai ao meio-dia',
    });

    const depois = await grade();
    const doRuan = depois.days[0]?.slots.filter((s) => s.professionalId === RUAN) ?? [];
    expect(doRuan.length).toBeGreaterThan(0);
    // Nada depois do meio-dia.
    expect(doRuan.every((s) => s.start < '12:00')).toBe(true);
  });

  it('bloqueio recusa o agendamento, não só esconde o horário', async () => {
    await bloquear();
    await expect(marcar('14:00')).rejects.toMatchObject({ code: 'slot_not_available' });
  });

  // -- os dois tempos ---------------------------------------------------------

  it('bloquear em cima de quem já marcou devolve os nomes e não grava', async () => {
    await marcar('14:00');

    const tentativa = await bloquear();
    expect(tentativa.saved).toBe(false);
    expect(tentativa.conflitos).toHaveLength(1);
    expect(tentativa.conflitos[0]).toMatchObject({
      start: '14:00',
      customerName: 'Carlos Souza',
      professionalName: 'Ruan',
    });

    // Nada foi gravado: a grade continua como estava.
    const { days } = await agenda();
    expect(days[0]?.exceptions ?? []).toEqual([]);
  });

  it('confirmando, grava mesmo com gente marcada dentro', async () => {
    await marcar('14:00');

    const confirmado = await bloquear({ confirmarConflitos: true });
    expect(confirmado.saved).toBe(true);
    expect(confirmado.conflitos).toHaveLength(1);

    // O agendamento **não** é cancelado: bloquear não cancela ninguém.
    const { days } = await agenda();
    expect(days[0]?.entries.some((e) => e.start === '14:00')).toBe(true);
    expect(days[0]?.exceptions).toHaveLength(1);
  });

  it('agendamento que encosta no bloqueio não conta como conflito', async () => {
    // Corte das 13:30 às 14:00; bloqueio começa às 14:00. Semiaberto.
    await marcar('13:30');

    const tentativa = await bloquear();
    expect(tentativa.saved).toBe(true);
  });

  it('bloqueio de um profissional não olha a agenda do outro', async () => {
    await marcar('14:00', GLEIDSON);

    const tentativa = await bloquear();
    expect(tentativa.saved).toBe(true);
  });

  // -- validação --------------------------------------------------------------

  it('recusa faixa invertida com motivo, não com erro de banco', async () => {
    await expect(bloquear({ startMinute: 900, endMinute: 840 })).rejects.toMatchObject({
      code: 'invalid_exception',
      detail: 'faixa_invertida',
    });
  });

  it('recusa bloqueio sem faixa', async () => {
    await expect(
      bloquear({ startMinute: null, endMinute: null }),
    ).rejects.toMatchObject({ detail: 'faixa_ausente' });
  });

  it('recusa folga com faixa — o tipo fecha o dia inteiro', async () => {
    await expect(
      bloquear({ kind: 'day_off' }),
    ).rejects.toMatchObject({ detail: 'faixa_indevida' });
  });

  // -- a agenda ---------------------------------------------------------------

  it('a agenda traz o dia com buffers separados do atendimento', async () => {
    await exec(admin, `UPDATE services SET buffer_after_minutes = 10 WHERE id = '${CABELO}'`);
    await marcar('10:00');

    const { days } = await agenda();
    const entrada = days[0]?.entries[0];
    expect(entrada).toMatchObject({ start: '10:00', end: '10:30', occupiedEnd: '10:40' });
    expect(entrada?.customerName).toBe('Carlos Souza');
    expect(entrada?.services).toEqual(['Cabelo']);
  });

  it('a semana traz sete dias, com e sem movimento', async () => {
    await marcar('10:00');

    const semana = await agenda('2026-08-10', '2026-08-16');
    expect(semana.days).toHaveLength(7);
    expect(semana.days.map((d) => d.date)).toContain(SEXTA);
    const sexta = semana.days.find((d) => d.date === SEXTA);
    expect(sexta?.entries).toHaveLength(1);
    expect(semana.days.filter((d) => d.entries.length === 0)).toHaveLength(6);
  });

  it('recusa intervalo maior que o teto em vez de varrer a base', async () => {
    await expect(agenda('2026-01-01', '2026-12-31')).rejects.toBeInstanceOf(RangeError);
  });

  it('o recorte de permissão limita a agenda a um profissional', async () => {
    await marcar('10:00', RUAN);
    await marcar('11:00', GLEIDSON);

    const doRuan = await getAgenda({
      tenantId: TENANT,
      locationId: LOCATION,
      timezone: TZ,
      from: SEXTA,
      to: SEXTA,
      onlyProfessionalId: RUAN,
    });

    expect(doRuan.professionals.map((p) => p.id)).toEqual([RUAN]);
    expect(doRuan.days[0]?.entries).toHaveLength(1);
    expect(doRuan.days[0]?.entries[0]?.professionalId).toBe(RUAN);
  });

  it('cancelado não ocupa espaço na grade do admin', async () => {
    const criado = await marcar('10:00');
    await exec(admin, `
      UPDATE appointments SET status = 'cancelled_customer' WHERE id = '${criado.id}'
    `);

    const { days } = await agenda();
    expect(days[0]?.entries).toEqual([]);
  });

  // -- remover ----------------------------------------------------------------

  it('remover a exceção devolve os horários', async () => {
    const criado = await bloquear();
    if (!criado.saved) throw new Error('esperava ter gravado');

    await deleteException({
      tenantId: TENANT,
      locationId: LOCATION,
      exceptionId: criado.id,
    });

    const depois = await grade();
    expect(depois.days[0]?.slots.some((s) => s.start === '14:00')).toBe(true);
  });

  // -- a parede entre barbearias ---------------------------------------------

  it('nada disso atravessa a parede entre barbearias', async () => {
    const criado = await bloquear();
    if (!criado.saved) throw new Error('esperava ter gravado');

    const doRival = await getAgenda({
      tenantId: RIVAL,
      locationId: LOCAL_RIVAL,
      timezone: TZ,
      from: SEXTA,
      to: SEXTA,
    });
    expect(doRival.days[0]?.exceptions ?? []).toEqual([]);
    expect(doRival.professionals).toEqual([]);

    await expect(
      deleteException({
        tenantId: RIVAL,
        locationId: LOCAL_RIVAL,
        exceptionId: criado.id,
      }),
    ).rejects.toMatchObject({ code: 'exception_not_found' });

    await expect(
      createException({
        tenantId: RIVAL,
        locationId: LOCAL_RIVAL,
        timezone: TZ,
        kind: 'day_off',
        date: SEXTA,
        professionalId: RUAN,
      }),
    ).rejects.toMatchObject({ code: 'unknown_professional' });

    // E o bloqueio da casa continua de pé.
    const { days } = await agenda();
    expect(days[0]?.exceptions).toHaveLength(1);
  });
});
