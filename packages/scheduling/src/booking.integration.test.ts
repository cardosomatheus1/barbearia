import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BookingError,
  cancelAppointment,
  createAppointment,
  holdSlot,
  releaseHold,
  rescheduleAppointment,
} from './booking.js';
import { getAvailability } from './service.js';

/**
 * Reserva, contra Postgres real.
 *
 * As garantias que interessam aqui — corrida entre dois clientes, idempotência,
 * atomicidade do reagendamento — só existem no banco. Testar com mock provaria
 * apenas que o mock foi escrito para concordar.
 *
 * `SEED_DATABASE_URL` é superusuário e serve só para semear. O domínio conecta
 * por `DATABASE_URL` com o role `barbearia_app` (NOBYPASSRLS): apontar
 * `DATABASE_URL` para superusuário desligaria a RLS e os testes de isolamento
 * passariam sem provar nada.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const GLEIDSON = 'bbbbbbbb-0000-0000-0000-000000000002';
const CARLOS = 'cccccccc-0000-0000-0000-000000000001';
const CABELO = 'eeeeeeee-0000-0000-0000-000000000001';
const BARBA = 'eeeeeeee-0000-0000-0000-000000000002';

const TERCA = '2026-08-11';
const QUARTA = '2026-08-12';
const AGORA = new Date('2026-08-01T12:00:00Z');

let admin: PrismaClient;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(statement);
  }
}

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

describeIfDb('reserva', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    // Semeia como superusuário; o código de domínio conecta pelo role restrito
    // via DATABASE_URL, então a RLS está ativa em tudo que os testes exercitam.
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(admin, `
      INSERT INTO tenants (id, name) VALUES
        ('${TENANT}', 'Domari'), ('${RIVAL}', 'Rival');

      INSERT INTO locations (id, tenant_id, name, timezone, granularity_minutes, min_lead_minutes)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia', 20, 30);

      INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
        ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional'),
        ('${GLEIDSON}', '${TENANT}', '${LOCATION}', 'Gleidson', 'professional');

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos', '+5571988887777');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes) VALUES
        ('${CABELO}', '${TENANT}', 'Cabelo', 4900, 20),
        ('${BARBA}', '${TENANT}', 'Barba', 3500, 20);

      INSERT INTO professional_services (professional_id, service_id, tenant_id) VALUES
        ('${RUAN}', '${CABELO}', '${TENANT}'), ('${RUAN}', '${BARBA}', '${TENANT}'),
        ('${GLEIDSON}', '${CABELO}', '${TENANT}'), ('${GLEIDSON}', '${BARBA}', '${TENANT}');

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', p.id, d.weekday, 540, 1080
      FROM (VALUES ('${RUAN}'::uuid), ('${GLEIDSON}'::uuid)) AS p(id),
           (VALUES (2), (3), (4), (5), (6)) AS d(weekday);
    `);
  });

  const base = {
    tenantId: TENANT,
    locationId: LOCATION,
    professionalId: RUAN,
    serviceIds: [CABELO],
    date: TERCA,
    start: '09:00',
    customerId: CARLOS,
    now: AGORA,
  };

  const slotsFor = async (professionalId: string, date = TERCA): Promise<string[]> => {
    const result = await getAvailability({
      tenantId: TENANT,
      locationId: LOCATION,
      serviceIds: [CABELO],
      date,
      professionalId,
      now: AGORA,
    });
    return result.slots.map((slot) => slot.start);
  };

  // -- criação ---------------------------------------------------------------

  it('cria e remove o horário da grade', async () => {
    expect(await slotsFor(RUAN)).toContain('09:00');

    const appointment = await createAppointment(base);
    expect(appointment.status).toBe('pending');
    expect(appointment.priceCents).toBe(4900);
    expect(appointment.deduplicated).toBe(false);

    expect(await slotsFor(RUAN)).not.toContain('09:00');
    // O outro barbeiro segue livre no mesmo horário.
    expect(await slotsFor(GLEIDSON)).toContain('09:00');
  });

  it('grava os serviços da visita', async () => {
    const appointment = await createAppointment({ ...base, serviceIds: [CABELO, BARBA] });

    const rows = await admin.$queryRawUnsafe<{ service_id: string; duration_minutes: number }[]>(
      `SELECT service_id, duration_minutes FROM appointment_services
       WHERE appointment_id = '${appointment.id}' ORDER BY position`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.duration_minutes)).toEqual([20, 20]);
  });

  it('preço e duração vêm do catálogo, nunca da requisição', async () => {
    await exec(admin, `
      UPDATE professional_services SET price_cents = 9900, duration_minutes = 30
      WHERE professional_id = '${RUAN}' AND service_id = '${CABELO}';
    `);

    const appointment = await createAppointment(base);
    expect(appointment.priceCents).toBe(9900);

    const minutes =
      (new Date(appointment.serviceEndsAt).getTime() -
        new Date(appointment.serviceStartsAt).getTime()) / 60_000;
    expect(minutes).toBe(30);
  });

  it('grava a janela ocupada com buffer, e a visível sem ele', async () => {
    await exec(admin, `
      UPDATE services SET buffer_before_minutes = 10, buffer_after_minutes = 5
      WHERE id = '${CABELO}';
    `);

    const appointment = await createAppointment({ ...base, start: '09:10' });

    // Ocupa 09:00–09:35 local (12:00–12:35 UTC); o cliente vê 09:10–09:30.
    expect(appointment.startsAt).toBe('2026-08-11T12:00:00.000Z');
    expect(appointment.endsAt).toBe('2026-08-11T12:35:00.000Z');
    expect(appointment.serviceStartsAt).toBe('2026-08-11T12:10:00.000Z');
    expect(appointment.serviceEndsAt).toBe('2026-08-11T12:30:00.000Z');
  });

  it('recusa horário fora da jornada', async () => {
    await expect(createAppointment({ ...base, start: '21:00' })).rejects.toMatchObject({
      code: 'slot_not_available',
    });
  });

  it('recusa horário em dia de folga', async () => {
    await expect(
      createAppointment({ ...base, date: '2026-08-10' }),
    ).rejects.toMatchObject({ code: 'slot_not_available' });
  });

  it('recusa profissional que não executa o serviço', async () => {
    await exec(admin, `
      DELETE FROM professional_services
      WHERE professional_id = '${RUAN}' AND service_id = '${BARBA}';
    `);
    await expect(
      createAppointment({ ...base, serviceIds: [CABELO, BARBA] }),
    ).rejects.toMatchObject({ code: 'slot_not_available' });
  });

  it('recusa horário fora da antecedência mínima', async () => {
    // "Agora" às 09:00 locais do próprio dia, com 30 min de antecedência.
    await expect(
      createAppointment({ ...base, now: new Date('2026-08-11T12:00:00Z') }),
    ).rejects.toMatchObject({ code: 'slot_not_available' });
  });

  // -- idempotência ----------------------------------------------------------

  it('a mesma chave devolve o mesmo agendamento', async () => {
    const first = await createAppointment({ ...base, idempotencyKey: 'req-1' });
    const second = await createAppointment({ ...base, idempotencyKey: 'req-1' });

    expect(second.id).toBe(first.id);
    expect(second.deduplicated).toBe(true);

    const total = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM appointments`,
    );
    expect(Number(total[0]?.n)).toBe(1);
  });

  it('duplo toque simultâneo com a mesma chave cria um só', async () => {
    const results = await Promise.allSettled([
      createAppointment({ ...base, idempotencyKey: 'req-2' }),
      createAppointment({ ...base, idempotencyKey: 'req-2' }),
    ]);

    const total = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM appointments`,
    );
    expect(Number(total[0]?.n)).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  });

  it('chaves diferentes no mesmo horário: só uma vence', async () => {
    await createAppointment({ ...base, idempotencyKey: 'req-3' });
    await expect(
      createAppointment({ ...base, idempotencyKey: 'req-4' }),
    ).rejects.toMatchObject({ code: 'slot_not_available' });
  });

  // -- concorrência ----------------------------------------------------------

  it('dois clientes no mesmo horário: um vence, o outro recebe erro claro', async () => {
    const results = await Promise.allSettled([
      createAppointment({ ...base, idempotencyKey: 'a' }),
      createAppointment({ ...base, idempotencyKey: 'b' }),
    ]);

    const criados = results.filter((r) => r.status === 'fulfilled');
    const recusados = results.filter((r) => r.status === 'rejected');

    expect(criados).toHaveLength(1);
    expect(recusados).toHaveLength(1);

    const erro = (recusados[0] as PromiseRejectedResult).reason as BookingError;
    // Pode cair na validação ou na constraint, dependendo do entrelaçamento —
    // as duas são respostas corretas, e nenhuma delas é overbooking.
    expect(['slot_taken', 'slot_not_available']).toContain(erro.code);

    const total = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM appointments`,
    );
    expect(Number(total[0]?.n)).toBe(1);
  });

  // -- reserva temporária ----------------------------------------------------

  it('hold tira o horário da grade e o próprio dono ainda consegue reservar', async () => {
    const hold = await holdSlot(base);
    expect(await slotsFor(RUAN)).not.toContain('09:00');

    // Sem informar o hold, o slot aparece ocupado até para quem o segura.
    await expect(createAppointment(base)).rejects.toMatchObject({
      code: 'slot_not_available',
    });

    const appointment = await createAppointment({ ...base, holdId: hold.id });
    expect(appointment.id).toBeTruthy();

    const holds = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM slot_holds`,
    );
    // O hold é consumido junto com a reserva.
    expect(Number(holds[0]?.n)).toBe(0);
  });

  it('hold liberado devolve o horário à grade', async () => {
    const hold = await holdSlot(base);
    expect(await slotsFor(RUAN)).not.toContain('09:00');

    await releaseHold(TENANT, hold.id);
    expect(await slotsFor(RUAN)).toContain('09:00');
  });

  it('hold expirado não bloqueia', async () => {
    const hold = await holdSlot({ ...base, ttlSeconds: 1 });
    await admin.$executeRawUnsafe(
      `UPDATE slot_holds SET expires_at = now() - interval '1 second' WHERE id = '${hold.id}'`,
    );
    expect(await slotsFor(RUAN)).toContain('09:00');
  });

  // -- cancelamento ----------------------------------------------------------

  it('cancelar devolve o horário à grade', async () => {
    const appointment = await createAppointment(base);
    expect(await slotsFor(RUAN)).not.toContain('09:00');

    await cancelAppointment({ tenantId: TENANT, appointmentId: appointment.id, by: 'customer' });
    expect(await slotsFor(RUAN)).toContain('09:00');
  });

  it('distingue quem cancelou — só o cliente é penalizado depois', async () => {
    const peloCliente = await createAppointment({ ...base, idempotencyKey: 'c1' });
    const pelaCasa = await createAppointment({
      ...base, professionalId: GLEIDSON, idempotencyKey: 'c2',
    });

    await cancelAppointment({ tenantId: TENANT, appointmentId: peloCliente.id, by: 'customer' });
    await cancelAppointment({ tenantId: TENANT, appointmentId: pelaCasa.id, by: 'business' });

    const rows = await admin.$queryRawUnsafe<{ id: string; status: string }[]>(
      `SELECT id, status FROM appointments ORDER BY professional_id`,
    );
    const statuses = new Set(rows.map((row) => row.status));
    expect(statuses).toEqual(new Set(['cancelled_customer', 'cancelled_business']));
  });

  it('cancelar duas vezes falha na segunda', async () => {
    const appointment = await createAppointment(base);
    await cancelAppointment({ tenantId: TENANT, appointmentId: appointment.id, by: 'customer' });

    await expect(
      cancelAppointment({ tenantId: TENANT, appointmentId: appointment.id, by: 'customer' }),
    ).rejects.toMatchObject({ code: 'appointment_not_found' });
  });

  it('outro tenant não cancela agendamento alheio', async () => {
    const appointment = await createAppointment(base);

    await expect(
      cancelAppointment({ tenantId: RIVAL, appointmentId: appointment.id, by: 'customer' }),
    ).rejects.toMatchObject({ code: 'appointment_not_found' });

    const rows = await admin.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status FROM appointments WHERE id = '${appointment.id}'`,
    );
    expect(rows[0]?.status).toBe('pending');
  });

  // -- reagendamento ---------------------------------------------------------

  it('reagenda para outro horário do mesmo dia', async () => {
    const original = await createAppointment(base);

    const novo = await rescheduleAppointment({
      tenantId: TENANT,
      appointmentId: original.id,
      date: TERCA,
      start: '14:00',
      now: AGORA,
    });

    expect(novo.id).not.toBe(original.id);
    expect(novo.serviceStartsAt).toBe('2026-08-11T17:00:00.000Z');

    const slots = await slotsFor(RUAN);
    expect(slots).toContain('09:00');      // liberado
    expect(slots).not.toContain('14:00');  // ocupado
  });

  it('reagenda para outro dia e outro profissional', async () => {
    const original = await createAppointment(base);

    const novo = await rescheduleAppointment({
      tenantId: TENANT,
      appointmentId: original.id,
      date: QUARTA,
      start: '10:00',
      professionalId: GLEIDSON,
      now: AGORA,
    });

    expect(novo.professionalId).toBe(GLEIDSON);
    expect(await slotsFor(GLEIDSON, QUARTA)).not.toContain('10:00');
  });

  it('marca o original e liga o novo a ele', async () => {
    const original = await createAppointment(base);
    const novo = await rescheduleAppointment({
      tenantId: TENANT, appointmentId: original.id, date: TERCA, start: '14:00', now: AGORA,
    });

    const rows = await admin.$queryRawUnsafe<{ id: string; status: string; rescheduled_from: string | null }[]>(
      `SELECT id, status, rescheduled_from FROM appointments`,
    );
    const antigo = rows.find((row) => row.id === original.id);
    const atual = rows.find((row) => row.id === novo.id);

    expect(antigo?.status).toBe('rescheduled');
    expect(atual?.rescheduled_from).toBe(original.id);
  });

  it('permite mover para horário que se sobrepõe ao próprio', async () => {
    // 09:00 -> 09:20 sobrepõe a janela que está saindo. O agendamento não pode
    // bloquear a si mesmo.
    const original = await createAppointment(base);
    const novo = await rescheduleAppointment({
      tenantId: TENANT, appointmentId: original.id, date: TERCA, start: '09:20', now: AGORA,
    });
    expect(novo.serviceStartsAt).toBe('2026-08-11T12:20:00.000Z');
  });

  it('reagendamento falho deixa o original intacto', async () => {
    const original = await createAppointment({ ...base, idempotencyKey: 'r1' });
    // Gleidson ocupa 14:00; tentar mover Ruan para lá é impossível de qualquer
    // forma, então usa-se um horário fora da jornada para forçar a recusa.
    await expect(
      rescheduleAppointment({
        tenantId: TENANT, appointmentId: original.id, date: TERCA, start: '23:00', now: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'slot_not_available' });

    const rows = await admin.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status FROM appointments WHERE id = '${original.id}'`,
    );
    // Continua ativo: o cliente nunca fica sem agendamento por erro do sistema.
    expect(rows[0]?.status).toBe('pending');
    expect(await slotsFor(RUAN)).not.toContain('09:00');
  });

  it('não reagenda o que já foi cancelado', async () => {
    const appointment = await createAppointment(base);
    await cancelAppointment({ tenantId: TENANT, appointmentId: appointment.id, by: 'customer' });

    await expect(
      rescheduleAppointment({
        tenantId: TENANT, appointmentId: appointment.id, date: TERCA, start: '14:00', now: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'appointment_not_active' });
  });

  it('outro tenant não reagenda agendamento alheio', async () => {
    const appointment = await createAppointment(base);
    await expect(
      rescheduleAppointment({
        tenantId: RIVAL, appointmentId: appointment.id, date: TERCA, start: '14:00', now: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'appointment_not_found' });
  });
});
