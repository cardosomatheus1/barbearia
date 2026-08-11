import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyAttendance, getDayBoard } from './dayboard.js';
import { createAppointment } from './booking.js';

/**
 * Painel do dia, contra Postgres real.
 *
 * O que se prova aqui: que o dia mostrado é o **da barbearia** e não o do
 * servidor, que a máquina de estados recusa o que não faz sentido, e que
 * desfazer uma falta não cria dois clientes no mesmo horário.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const CABELO = 'eeeeeeee-0000-0000-0000-000000000001';

// Terça-feira. `AGORA` fica antes para não esbarrar na antecedência mínima.
const TERCA = '2026-08-11';
const AGORA = new Date('2026-08-01T12:00:00Z');

let admin: PrismaClient;

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(parte);
  }
}

describeIfDb('painel do dia', () => {
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
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari');

      INSERT INTO tenant_slugs (slug, tenant_id, is_primary)
      VALUES ('domari', '${TENANT}', true);

      -- América/Bahia é UTC-3: um agendamento às 23:30 local cai no dia seguinte
      -- em UTC, e é assim que a consulta erra o dia se estiver mal escrita.
      INSERT INTO locations (id, tenant_id, name, timezone, granularity_minutes)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia', 20);

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', 'Cabelo', 4900, 20);

      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      VALUES ('${RUAN}', '${CABELO}', '${TENANT}');

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', '${RUAN}', d.weekday, 480, 1439
      FROM (VALUES (0), (1), (2), (3), (4), (5), (6)) AS d(weekday);
    `);
  });

  const marcar = (start: string) =>
    createAppointment({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      serviceIds: [CABELO],
      date: TERCA,
      start,
      now: AGORA,
    });

  const painel = (now = AGORA) =>
    getDayBoard({ tenantId: TENANT, locationId: LOCATION, date: TERCA, now });

  it('mostra o dia com quem está marcado', async () => {
    await marcar('09:00');
    await marcar('10:00');

    const board = await painel();
    expect(board.entries).toHaveLength(2);
    expect(board.entries[0]?.start).toBe('09:00');
    expect(board.entries[0]?.services).toEqual(['Cabelo']);
    expect(board.totals.esperados).toBe(2);
  });

  describe('o sinal na linha do balcão (bloco 37)', () => {
    /**
     * O que se prova aqui é a regra de fluxo do CLAUDE.md §6, não a aritmética:
     * **todo estado tem que ter saída na tela**. O painel é a única superfície
     * onde a recepção encontra um horário com sinal, e se ele não trouxer o
     * destino do dinheiro a tela não tem como oferecer o botão de devolver — o
     * mesmo defeito de `in_service`, que era alcançável e não fechava.
     */
    const comSinal = async (extra: string) => {
      const marcado = await marcar('09:00');
      await admin.$executeRawUnsafe(
        `UPDATE appointments
            SET deposit_required_cents = 2000, deposit_reason = 'score', ${extra}
          WHERE id = '${marcado.id}'`,
      );
      return (await painel()).entries.find((e) => e.id === marcado.id);
    };

    it('horário sem sinal não carrega linha de sinal nenhuma', async () => {
      // Nulo e não um objeto zerado: uma linha "sinal R$ 0,00" em todo cartão é
      // indicador que se aprende a não ler.
      await marcar('09:00');
      expect((await painel()).entries[0]?.deposit).toBeNull();
    });

    it('horário com sinal a receber traz valor e motivo, e nenhuma decisão', async () => {
      const linha = await comSinal('deposit_paid_cents = 0');
      expect(linha?.deposit).toMatchObject({
        exigidoCents: 2000,
        pagoCents: 0,
        motivo: 'score',
        // Indicador que responde antes da pergunta é pior que indicador nenhum:
        // o horário ainda vai acontecer.
        reembolso: null,
      });
    });

    it('cancelado dentro do prazo: a tela recebe "devolver"', async () => {
      const linha = await comSinal(
        `deposit_paid_cents = 2000, status = 'cancelled_customer',
         cancelled_at = service_starts_at - interval '48 hours'`,
      );
      expect(linha?.deposit?.reembolso?.desfecho).toBe('devolver');
    });

    it('cancelado em cima da hora: a tela recebe "reter"', async () => {
      const linha = await comSinal(
        `deposit_paid_cents = 2000, status = 'cancelled_customer',
         cancelled_at = service_starts_at - interval '2 hours'`,
      );
      expect(linha?.deposit?.reembolso?.desfecho).toBe('reter');
    });

    it('faltou: retém — é o caso para o qual o sinal existe', async () => {
      const linha = await comSinal(`deposit_paid_cents = 2000, status = 'no_show'`);
      expect(linha?.deposit?.reembolso?.desfecho).toBe('reter');
    });

    it('a casa cancelou: devolve, mesmo em cima da hora', async () => {
      const linha = await comSinal(
        `deposit_paid_cents = 2000, status = 'cancelled_business',
         cancelled_at = service_starts_at`,
      );
      expect(linha?.deposit?.reembolso?.desfecho).toBe('devolver');
    });

    it('sinal exigido e não pago não produz decisão de reembolso', async () => {
      // Não há o que devolver, e um "devolver" aqui poria na tela um botão que
      // move dinheiro que nunca entrou.
      const linha = await comSinal(
        `deposit_paid_cents = 0, status = 'no_show'`,
      );
      expect(linha?.deposit?.reembolso).toBeNull();
    });
  });

  it('o dia é o da barbearia, não o do servidor', async () => {
    // 21:20 em America/Bahia é 00:20 do dia **seguinte** em UTC. Uma consulta
    // que compare a data com a coluna sem converter o fuso perde este
    // agendamento — e o balcão fecharia o dia sem ver o último cliente.
    await marcar('21:20');

    const board = await painel();
    const tardio = board.entries.find((e) => e.start === '21:20');
    expect(tardio, 'agendamento das 21:20 sumiu do dia').toBeDefined();

    // E o contrário: ele não pode aparecer no dia 12, que é onde cairia se a
    // consulta usasse UTC cru.
    const seguinte = await getDayBoard({
      tenantId: TENANT, locationId: LOCATION, date: '2026-08-12', now: AGORA,
    });
    expect(seguinte.entries).toEqual([]);
  });

  // -- máquina de estados ----------------------------------------------------

  it('percorre chegada, início e fim, carimbando a hora de cada um', async () => {
    const criado = await marcar('09:00');

    await applyAttendance({ tenantId: TENANT, appointmentId: criado.id, action: 'check_in', now: new Date('2026-08-11T12:03:00Z') });
    await applyAttendance({ tenantId: TENANT, appointmentId: criado.id, action: 'start', now: new Date('2026-08-11T12:10:00Z') });
    await applyAttendance({ tenantId: TENANT, appointmentId: criado.id, action: 'complete', now: new Date('2026-08-11T12:38:00Z') });

    const board = await painel(new Date('2026-08-11T13:00:00Z'));
    const item = board.entries[0];

    expect(item?.status).toBe('completed');
    // Duração real: 28 minutos para um serviço cadastrado em 20. É esse número
    // que a fila presencial vai usar para estimar espera (bloco 14).
    expect(item?.realDurationMinutes).toBe(28);
    expect(board.totals.concluidos).toBe(1);
  });

  it('recusa começar quem não chegou', async () => {
    const criado = await marcar('09:00');
    await expect(
      applyAttendance({ tenantId: TENANT, appointmentId: criado.id, action: 'start' }),
    ).rejects.toMatchObject({ code: 'transition_not_allowed' });
  });

  it('recusa a segunda pessoa que tocar o mesmo cartão', async () => {
    // Dois no balcão, o mesmo atendimento. A segunda ação não pode desfazer a
    // primeira em silêncio.
    const criado = await marcar('09:00');
    await applyAttendance({ tenantId: TENANT, appointmentId: criado.id, action: 'check_in' });

    await expect(
      applyAttendance({ tenantId: TENANT, appointmentId: criado.id, action: 'check_in' }),
    ).rejects.toMatchObject({ code: 'transition_not_allowed' });
  });

  it('marca falta e devolve o horário para a grade', async () => {
    const criado = await marcar('09:00');
    await applyAttendance({ tenantId: TENANT, appointmentId: criado.id, action: 'no_show' });

    const board = await painel();
    expect(board.totals.faltaram).toBe(1);
    expect(board.totals.esperados).toBe(0);

    // A constraint de exclusão ignora `no_show`, então a vaga volta a existir.
    await expect(marcar('09:00')).resolves.toBeDefined();
  });

  it('desfazer a falta recusa quando a vaga já foi dada a outro', async () => {
    // O caso que produziria dois clientes no mesmo horário por causa de um
    // toque: a recepção marca falta, a vaga é reocupada, e alguém tenta
    // desfazer.
    const criado = await marcar('09:00');
    await applyAttendance({ tenantId: TENANT, appointmentId: criado.id, action: 'no_show' });
    await marcar('09:00');

    await expect(
      applyAttendance({ tenantId: TENANT, appointmentId: criado.id, action: 'undo_no_show' }),
    ).rejects.toMatchObject({ code: 'slot_taken' });
  });

  it('desfazer a falta funciona quando a vaga continua livre', async () => {
    const criado = await marcar('09:00');
    await applyAttendance({ tenantId: TENANT, appointmentId: criado.id, action: 'no_show' });

    const voltou = await applyAttendance({
      tenantId: TENANT, appointmentId: criado.id, action: 'undo_no_show',
    });
    expect(voltou.status).toBe('checked_in');
  });

  it('cancelar pelo balcão não pune o cliente', async () => {
    const criado = await marcar('09:00');
    await applyAttendance({ tenantId: TENANT, appointmentId: criado.id, action: 'cancel' });

    const linhas = await admin.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status FROM appointments WHERE id = '${criado.id}'`,
    );
    // `cancelled_business`, não `cancelled_customer`: quem desmarcou foi a casa.
    expect(linhas[0]?.status).toBe('cancelled_business');
  });

  // -- pontualidade ----------------------------------------------------------

  it('mostra o relógio da falta automática para quem está atrasado', async () => {
    await marcar('09:00');

    // 09:08 local = 12:08 UTC. Tolerância padrão de 20 minutos.
    const board = await painel(new Date('2026-08-11T12:08:00Z'));
    expect(board.entries[0]?.punctuality).toEqual({
      kind: 'late',
      minutesLate: 8,
      noShowInMinutes: 12,
    });
  });

  it('quem já chegou deixa de ser cobrado de atraso e passa a contar espera', async () => {
    const criado = await marcar('09:00');
    await applyAttendance({
      tenantId: TENANT, appointmentId: criado.id, action: 'check_in',
      now: new Date('2026-08-11T12:03:00Z'),
    });

    const board = await painel(new Date('2026-08-11T12:15:00Z'));
    expect(board.entries[0]?.punctuality).toBeNull();
    expect(board.entries[0]?.waitingMinutes).toBe(12);
  });

  it('tolerância zero na unidade não transforma atraso em falta', async () => {
    await admin.$executeRawUnsafe(
      `UPDATE locations SET no_show_after_minutes = 0 WHERE id = '${LOCATION}'`,
    );
    await marcar('09:00');

    const board = await painel(new Date('2026-08-11T13:00:00Z'));
    expect(board.entries[0]?.punctuality?.kind).toBe('late');
  });

  // -- isolamento ------------------------------------------------------------

  it('não mostra o dia de outra barbearia', async () => {
    await marcar('09:00');
    const rival = '22222222-2222-2222-2222-222222222222';
    await exec(admin, `INSERT INTO tenants (id, name) VALUES ('${rival}', 'Rival')`);

    const board = await getDayBoard({
      tenantId: rival, locationId: LOCATION, date: TERCA, now: AGORA,
    });
    // A RLS não enxerga nem a unidade: o painel volta vazio, não com o dia alheio.
    expect(board.entries).toEqual([]);
  });

  it('não move atendimento de outra barbearia', async () => {
    const criado = await marcar('09:00');
    const rival = '22222222-2222-2222-2222-222222222222';
    await exec(admin, `INSERT INTO tenants (id, name) VALUES ('${rival}', 'Rival')`);

    await expect(
      applyAttendance({ tenantId: rival, appointmentId: criado.id, action: 'check_in' }),
    ).rejects.toMatchObject({ code: 'appointment_not_found' });
  });
});

/**
 * Recorte por agenda.
 *
 * `appointments.view_all_professionals` existia no catálogo, era negada ao
 * barbeiro e não decidia nada: o painel devolvia a casa inteira sob
 * `appointments.view`, que todo papel tem — e a tela de equipe prometia "a
 * própria agenda" para esse papel.
 */
describeIfDb('painel do dia — só a minha agenda', () => {
  const GLEIDSON = 'bbbbbbbb-0000-0000-0000-000000000002';

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
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari');

      INSERT INTO locations (id, tenant_id, name, timezone, granularity_minutes)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia', 20);

      INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
        ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional'),
        ('${GLEIDSON}', '${TENANT}', '${LOCATION}', 'Gleidson', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', 'Cabelo', 4900, 20);

      INSERT INTO professional_services (professional_id, service_id, tenant_id) VALUES
        ('${RUAN}', '${CABELO}', '${TENANT}'),
        ('${GLEIDSON}', '${CABELO}', '${TENANT}');

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', p.id, d.weekday, 480, 1200
      FROM (VALUES ('${RUAN}'::uuid), ('${GLEIDSON}'::uuid)) AS p(id)
      CROSS JOIN (VALUES (0), (1), (2), (3), (4), (5), (6)) AS d(weekday);
    `);
  });

  const marcarCom = (professionalId: string, start: string) =>
    createAppointment({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId,
      serviceIds: [CABELO],
      date: TERCA,
      start,
      now: AGORA,
    });

  it('o barbeiro vê a agenda dele e não a do colega', async () => {
    await marcarCom(RUAN, '09:00');
    await marcarCom(GLEIDSON, '10:00');

    const dele = await getDayBoard({
      tenantId: TENANT,
      locationId: LOCATION,
      date: TERCA,
      onlyProfessionalId: RUAN,
      now: AGORA,
    });

    expect(dele.entries.map((e) => e.professionalName)).toEqual(['Ruan']);
    expect(dele.totals.esperados).toBe(1);
    // Nem o nome do colega na lista de filtro: seria dizer quem mais atende e
    // quantos horários ele tem.
    expect(dele.professionals.map((p) => p.name)).toEqual(['Ruan']);
  });

  const casaInteira = () =>
    getDayBoard({ tenantId: TENANT, locationId: LOCATION, date: TERCA, now: AGORA });

  it('sem recorte, a casa inteira aparece', async () => {
    await marcarCom(RUAN, '09:00');
    await marcarCom(GLEIDSON, '10:00');

    const tudo = await casaInteira();
    expect(tudo.entries).toHaveLength(2);
  });

  it('o barbeiro não move o atendimento do colega, mesmo com o id em mãos', async () => {
    // A lista de ontem já daria o id. Sem o recorte na gravação, marcar falta no
    // cliente do colega era uma requisição.
    const doColega = await marcarCom(GLEIDSON, '10:00');

    await expect(
      applyAttendance({
        tenantId: TENANT,
        appointmentId: doColega.id,
        action: 'check_in',
        onlyProfessionalId: RUAN,
      }),
    ).rejects.toMatchObject({ code: 'appointment_not_found' });

    // E o dono, sem recorte, move normalmente.
    await expect(
      applyAttendance({ tenantId: TENANT, appointmentId: doColega.id, action: 'check_in' }),
    ).resolves.toMatchObject({ status: 'checked_in' });
  });

  it('o painel não devolve faturamento para ninguém', async () => {
    // `finance.view` é do dono e do gerente. Entregar o número sob
    // `appointments.view` daria a receita do dia a todo mundo com acesso ao
    // balcão. Ele volta no bloco 18, com o caixa e com MFA.
    const criado = await marcarCom(RUAN, '09:00');
    await applyAttendance({ tenantId: TENANT, appointmentId: criado.id, action: 'check_in' });
    await applyAttendance({ tenantId: TENANT, appointmentId: criado.id, action: 'start' });
    await applyAttendance({ tenantId: TENANT, appointmentId: criado.id, action: 'complete' });

    const board = await casaInteira();
    expect(JSON.stringify(board.totals)).not.toContain('realizado');
  });
});
