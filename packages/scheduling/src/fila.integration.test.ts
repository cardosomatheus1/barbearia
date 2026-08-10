import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  custoDoEncaixeNaFila,
  getQueue,
  joinQueue,
  moveQueueEntry,
  queuePositionByToken,
  seatQueueEntry,
} from './fila.js';
import { applyAttendance } from './dayboard.js';

/**
 * Fila presencial, contra Postgres real.
 *
 * O que se prova aqui: que a estimativa usa a duração **real** medida no
 * balcão, que sentar alguém em cima de quem marcou é recusado **pelo banco**, e
 * que o link do celular não é chave para a fila da barbearia.
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
const JOAO = 'cccccccc-0000-0000-0000-000000000002';
const TZ = 'America/Bahia';

// Terça-feira, 10:00 em Salvador (UTC-3).
const AGORA = new Date('2026-08-11T13:00:00Z');

let admin: PrismaClient;

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(parte);
  }
}

const fila = (now = AGORA) =>
  getQueue({ tenantId: TENANT, locationId: LOCATION, timezone: TZ, now });

describeIfDb('fila presencial', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE jobs');
    await exec(admin, `
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Rival');

      INSERT INTO locations (id, tenant_id, name, timezone, granularity_minutes)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', '${TZ}', 15),
             ('${LOCAL_RIVAL}', '${RIVAL}', 'Rival', '${TZ}', 15);

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional'),
             ('${GLEIDSON}', '${TENANT}', '${LOCATION}', 'Gleidson', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', 'Cabelo', 4900, 30);

      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      VALUES ('${RUAN}', '${CABELO}', '${TENANT}'),
             ('${GLEIDSON}', '${CABELO}', '${TENANT}');

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', p.id, d.weekday, 480, 1320
      FROM (VALUES ('${RUAN}'::uuid), ('${GLEIDSON}'::uuid)) AS p(id),
           (VALUES (0), (1), (2), (3), (4), (5), (6)) AS d(weekday);

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777'),
        ('${JOAO}', '${TENANT}', 'Joao Lima', '+5571977776666');
    `);
  });

  const entrar = (customerId = CARLOS, professionalId: string | null = null, now = AGORA) =>
    joinQueue({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId,
      serviceIds: [CABELO],
      professionalId,
      now,
    });

  // -- entrar na fila ---------------------------------------------------------

  it('quem chega entra na fila e recebe o link uma única vez', async () => {
    const entrada = await entrar();

    expect(entrada.posicao).toBe(1);
    expect(entrada.token.length).toBeGreaterThan(30);

    // O que foi para o banco é o hash, nunca o token.
    const guardado = await admin.$queryRawUnsafe<{ public_token_hash: string }[]>(
      `SELECT public_token_hash FROM queue_entries WHERE id = '${entrada.id}'`,
    );
    expect(guardado[0]?.public_token_hash).not.toBe(entrada.token);
    expect(guardado[0]?.public_token_hash).toHaveLength(64);
  });

  it('duplo toque na recepção não põe a mesma pessoa duas vezes', async () => {
    await entrar();
    await expect(entrar()).rejects.toMatchObject({ code: 'already_in_queue' });
  });

  it('a mesma chave de idempotência devolve a mesma entrada', async () => {
    const primeira = await joinQueue({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId: CARLOS,
      serviceIds: [CABELO],
      idempotencyKey: 'balcao-1',
      now: AGORA,
    });
    const repetida = await joinQueue({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId: CARLOS,
      serviceIds: [CABELO],
      idempotencyKey: 'balcao-1',
      now: AGORA,
    });

    expect(repetida.id).toBe(primeira.id);
    // E o token **não** volta: só o hash existe, e reemitir invalidaria o link
    // que a pessoa já está olhando no celular.
    expect(repetida.token).toBe('');
  });

  it('serviço de outra barbearia não entra na fila desta', async () => {
    await exec(admin, `
      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('eeeeeeee-0000-0000-0000-000000000009', '${RIVAL}', 'Do rival', 1000, 30);
    `);

    await expect(
      joinQueue({
        tenantId: TENANT,
        locationId: LOCATION,
        customerId: CARLOS,
        serviceIds: ['eeeeeeee-0000-0000-0000-000000000009'],
        now: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'unknown_service' });
  });

  // -- estimativa -------------------------------------------------------------

  it('com as duas cadeiras livres, os dois primeiros entram sem espera', async () => {
    await entrar(CARLOS);
    await entrar(JOAO, null, new Date(AGORA.getTime() + 60_000));

    const { entries } = await fila();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.esperaMinutos).toBe(0);
    expect(entries[1]?.esperaMinutos).toBe(0);
    // Cadeiras diferentes: ninguém espera com barbeiro parado ao lado.
    expect(entries[0]?.professionalId).not.toBe(entries[1]?.professionalId);
  });

  it('quem pede um barbeiro ocupado espera por ele, e a tela diz há quanto tempo', async () => {
    await entrar(CARLOS, RUAN);
    await entrar(JOAO, RUAN, new Date(AGORA.getTime() + 60_000));

    const { entries } = await fila(new Date(AGORA.getTime() + 10 * 60_000));

    expect(entries[0]?.professionalId).toBe(RUAN);
    expect(entries[0]?.esperandoHaMinutos).toBe(10);
    // 30 minutos de corte do primeiro.
    expect(entries[1]?.esperaMinutos).toBe(30);
  });

  it('a estimativa usa a duração real medida, não a cadastrada', async () => {
    // Seis atendimentos concluídos de 50 minutos, contra 30 no catálogo. É o
    // requisito literal da SPEC §2.10, e sem ele a fila promete o que não
    // cumpre — o cliente ouve "30 min" e espera 50.
    await exec(admin, `
      INSERT INTO appointments
        (id, tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at,
         status, started_at, completed_at)
      SELECT ('ffffffff-0000-0000-0000-00000000000' || n)::uuid,
             '${TENANT}', '${LOCATION}', '${CARLOS}', '${RUAN}',
             '2026-08-04T12:00:00Z'::timestamptz + (n || ' hours')::interval,
             '2026-08-04T12:50:00Z'::timestamptz + (n || ' hours')::interval,
             '2026-08-04T12:00:00Z'::timestamptz + (n || ' hours')::interval,
             '2026-08-04T12:50:00Z'::timestamptz + (n || ' hours')::interval,
             'completed',
             '2026-08-04T12:00:00Z'::timestamptz + (n || ' hours')::interval,
             '2026-08-04T12:50:00Z'::timestamptz + (n || ' hours')::interval
        FROM generate_series(1, 6) AS n;

      INSERT INTO appointment_services
        (appointment_id, service_id, tenant_id, position, price_cents, duration_minutes)
      SELECT ('ffffffff-0000-0000-0000-00000000000' || n)::uuid, '${CABELO}', '${TENANT}',
             0, 4900, 30
        FROM generate_series(1, 6) AS n;
    `);

    await entrar(CARLOS, RUAN);
    await entrar(JOAO, RUAN, new Date(AGORA.getTime() + 60_000));

    const { entries } = await fila();
    expect(entries[0]?.duracaoMinutos).toBe(50);
    expect(entries[1]?.esperaMinutos).toBe(50);
  });

  it('atendimento velho não conta para a média — o barbeiro de hoje não é o de dois anos atrás', async () => {
    // Seis atendimentos de 50 min, todos fora da janela de 90 dias. Sem o
    // recorte, a média de um ritmo abandonado há anos governaria a estimativa
    // de hoje para sempre — e ninguém entenderia por que ela não muda.
    await exec(admin, `
      INSERT INTO appointments
        (id, tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at,
         status, started_at, completed_at)
      SELECT ('ffffffff-0000-0000-0000-00000000000' || n)::uuid,
             '${TENANT}', '${LOCATION}', '${CARLOS}', '${RUAN}',
             '2024-01-04T12:00:00Z'::timestamptz + (n || ' hours')::interval,
             '2024-01-04T12:50:00Z'::timestamptz + (n || ' hours')::interval,
             '2024-01-04T12:00:00Z'::timestamptz + (n || ' hours')::interval,
             '2024-01-04T12:50:00Z'::timestamptz + (n || ' hours')::interval,
             'completed',
             '2024-01-04T12:00:00Z'::timestamptz + (n || ' hours')::interval,
             '2024-01-04T12:50:00Z'::timestamptz + (n || ' hours')::interval
        FROM generate_series(1, 6) AS n;

      INSERT INTO appointment_services
        (appointment_id, service_id, tenant_id, position, price_cents, duration_minutes)
      SELECT ('ffffffff-0000-0000-0000-00000000000' || n)::uuid, '${CABELO}', '${TENANT}',
             0, 4900, 30
        FROM generate_series(1, 6) AS n;
    `);

    await entrar(CARLOS, RUAN);
    const { entries } = await fila();

    // Volta a cadastrada, não os 50 minutos de 2024.
    expect(entries[0]?.duracaoMinutos).toBe(30);
  });

  it('barbeiro de folga hoje não recebe ninguém da fila', async () => {
    await exec(admin, `DELETE FROM work_schedules WHERE professional_id = '${GLEIDSON}'`);

    await entrar(CARLOS, GLEIDSON);
    const { entries, cadeiras } = await fila();

    expect(cadeiras.map((c) => c.professionalId)).toEqual([RUAN]);
    expect(entries[0]?.professionalId).toBeNull();
    expect(entries[0]?.frase).toContain('recepção');
  });

  // -- custo do encaixe -------------------------------------------------------

  it('cadeira livre com pouco tempo até o marcado não cabe, e diz de quem é', async () => {
    // Ruan tem cliente marcado às 10:20; o corte leva 30 min.
    await exec(admin, `
      INSERT INTO appointments
        (tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, status)
      VALUES ('${TENANT}', '${LOCATION}', '${JOAO}', '${RUAN}',
              '2026-08-11T13:20:00Z', '2026-08-11T13:50:00Z',
              '2026-08-11T13:20:00Z', '2026-08-11T13:50:00Z', 'confirmed');
    `);

    const custos = await custoDoEncaixeNaFila({
      tenantId: TENANT,
      locationId: LOCATION,
      timezone: TZ,
      serviceIds: [CABELO],
      now: AGORA,
    });

    const doRuan = custos.find((c) => c.professionalId === RUAN);
    expect(doRuan).toMatchObject({ cabe: false, invadeMinutos: 10 });
    expect(doRuan?.proximoMarcado).toBe('10:20');

    // E a outra cadeira, sem compromisso, cabe.
    expect(custos.find((c) => c.professionalId === GLEIDSON)?.cabe).toBe(true);
  });

  it('a fila avisa antes que o encaixe vai atrasar quem marcou', async () => {
    await exec(admin, `
      INSERT INTO appointments
        (tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, status)
      VALUES ('${TENANT}', '${LOCATION}', '${JOAO}', '${RUAN}',
              '2026-08-11T13:20:00Z', '2026-08-11T13:50:00Z',
              '2026-08-11T13:20:00Z', '2026-08-11T13:50:00Z', 'confirmed');
    `);

    await entrar(CARLOS, RUAN);
    const { entries } = await fila();
    expect(entries[0]?.atrasaMarcado).toBe(true);
  });

  // -- sentar -----------------------------------------------------------------

  it('sentar cria o atendimento com origem walk_in e hora real', async () => {
    const entrada = await entrar(CARLOS, RUAN);
    const sentado = await seatQueueEntry({
      tenantId: TENANT,
      queueEntryId: entrada.id,
      professionalId: RUAN,
      now: AGORA,
    });

    const linhas = await admin.$queryRawUnsafe<
      { source: string; status: string; started_at: Date; checked_in_at: Date }[]
    >(`SELECT source, status, started_at, checked_in_at FROM appointments WHERE id = '${sentado.appointmentId}'`);

    expect(linhas[0]?.source).toBe('walk_in');
    expect(linhas[0]?.status).toBe('in_progress');
    // A chegada é a hora em que entrou na fila, não a em que sentou: é o que
    // permite medir quanto a barbearia faz as pessoas esperarem.
    expect(linhas[0]?.checked_in_at?.toISOString()).toBe(AGORA.toISOString());
  });

  it('encerrar o atendimento fecha a entrada da fila', async () => {
    /**
     * As duas já nasciam ligadas — `seatQueueEntry` grava
     * `queue_entries.appointment_id` —, mas nada no produto escrevia `done`. A
     * entrada sumia da tela ao virar `in_service` e ficava viva para sempre.
     */
    const entrada = await entrar(CARLOS, RUAN);
    const sentado = await seatQueueEntry({
      tenantId: TENANT,
      queueEntryId: entrada.id,
      professionalId: RUAN,
      now: AGORA,
    });

    await applyAttendance({
      tenantId: TENANT,
      appointmentId: sentado.appointmentId,
      action: 'complete',
      now: new Date(AGORA.getTime() + 30 * 60_000),
    });

    const linhas = await admin.$queryRawUnsafe<{ status: string; finished_at: Date | null }[]>(
      `SELECT status, finished_at FROM queue_entries WHERE id = '${entrada.id}'`,
    );
    expect(linhas[0]?.status).toBe('done');
    expect(linhas[0]?.finished_at).not.toBeNull();
  });

  it('a espera média deixa de ser sempre "—"', async () => {
    /**
     * Ela só conta entradas concluídas. Sem nada escrevendo `done`, o número
     * que a tela da fila promete **nunca aparecia** — indicador sempre vazio é
     * pior que indicador ausente: ocupa espaço prometendo uma resposta que não
     * vem, e quem opera aprende a não olhar.
     */
    const entrada = await entrar(CARLOS, RUAN);
    const antes = await fila();
    expect(antes.totals.esperaMediaMinutos).toBeNull();

    const sentado = await seatQueueEntry({
      tenantId: TENANT,
      queueEntryId: entrada.id,
      professionalId: RUAN,
      // Vinte minutos depois de entrar na fila: é essa a espera medida.
      now: new Date(AGORA.getTime() + 20 * 60_000),
    });
    await applyAttendance({
      tenantId: TENANT,
      appointmentId: sentado.appointmentId,
      action: 'complete',
      now: new Date(AGORA.getTime() + 50 * 60_000),
    });

    const depois = await fila();
    expect(depois.totals.esperaMediaMinutos).toBe(20);
    // E ela sai da contagem de quem está na cadeira.
    expect(depois.totals.atendendo).toBe(0);
  });

  it('cancelar o atendimento também libera a cadeira na fila', async () => {
    // O cliente que senta e desiste no meio existe. Sem isto, a cadeira ficaria
    // ocupada no cálculo da fila por alguém que já foi embora.
    const entrada = await entrar(CARLOS, RUAN);
    const sentado = await seatQueueEntry({
      tenantId: TENANT,
      queueEntryId: entrada.id,
      professionalId: RUAN,
      now: AGORA,
    });

    await applyAttendance({
      tenantId: TENANT,
      appointmentId: sentado.appointmentId,
      action: 'cancel',
      now: new Date(AGORA.getTime() + 5 * 60_000),
    });

    const linhas = await admin.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status FROM queue_entries WHERE id = '${entrada.id}'`,
    );
    expect(linhas[0]?.status).toBe('done');
  });

  it('sentar em cima de quem marcou é recusado pelo banco, não por um if', async () => {
    // A constraint de exclusão é a garantia; um `if` teria a janela entre a
    // checagem e o INSERT, que é justo quando duas pessoas tocam o botão.
    await exec(admin, `
      INSERT INTO appointments
        (tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, status)
      VALUES ('${TENANT}', '${LOCATION}', '${JOAO}', '${RUAN}',
              '2026-08-11T13:20:00Z', '2026-08-11T13:50:00Z',
              '2026-08-11T13:20:00Z', '2026-08-11T13:50:00Z', 'confirmed');
    `);

    const entrada = await entrar(CARLOS, RUAN);
    await expect(
      seatQueueEntry({
        tenantId: TENANT,
        queueEntryId: entrada.id,
        professionalId: RUAN,
        now: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'slot_taken' });

    // A pessoa continua na fila: a recusa não a expulsa.
    const { entries } = await fila();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('waiting');
  });

  it('não se senta duas vezes a mesma pessoa', async () => {
    const entrada = await entrar(CARLOS, RUAN);
    await seatQueueEntry({
      tenantId: TENANT,
      queueEntryId: entrada.id,
      professionalId: RUAN,
      now: AGORA,
    });

    await expect(
      seatQueueEntry({
        tenantId: TENANT,
        queueEntryId: entrada.id,
        professionalId: GLEIDSON,
        now: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'transition_not_allowed' });
  });

  // -- chamar e desistir ------------------------------------------------------

  it('chamado que não aparece volta para a fila sem perder a hora de chegada', async () => {
    const entrada = await entrar(CARLOS);
    await moveQueueEntry({ tenantId: TENANT, queueEntryId: entrada.id, para: 'called', now: AGORA });
    await moveQueueEntry({
      tenantId: TENANT,
      queueEntryId: entrada.id,
      para: 'waiting',
      now: new Date(AGORA.getTime() + 120_000),
    });

    const { entries } = await fila(new Date(AGORA.getTime() + 10 * 60_000));
    expect(entries[0]?.status).toBe('waiting');
    expect(entries[0]?.esperandoHaMinutos).toBe(10);
  });

  it('quem desistiu sai da fila e é contado separado de quem foi atendido', async () => {
    const entrada = await entrar(CARLOS);
    await moveQueueEntry({
      tenantId: TENANT,
      queueEntryId: entrada.id,
      para: 'gave_up',
      now: AGORA,
    });

    const { entries, totals } = await fila();
    expect(entries).toHaveLength(0);
    expect(totals.desistiram).toBe(1);
    expect(totals.esperando).toBe(0);
  });

  it('quem desistiu pode voltar mais tarde', async () => {
    const primeira = await entrar(CARLOS);
    await moveQueueEntry({
      tenantId: TENANT,
      queueEntryId: primeira.id,
      para: 'gave_up',
      now: AGORA,
    });

    const volta = await entrar(CARLOS, null, new Date(AGORA.getTime() + 3600_000));
    expect(volta.id).not.toBe(primeira.id);
  });

  it('recusa transição que a fila já passou', async () => {
    const entrada = await entrar(CARLOS);
    await moveQueueEntry({
      tenantId: TENANT,
      queueEntryId: entrada.id,
      para: 'gave_up',
      now: AGORA,
    });

    await expect(
      moveQueueEntry({
        tenantId: TENANT,
        queueEntryId: entrada.id,
        para: 'called',
        now: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'transition_not_allowed' });
  });

  // -- o link do celular ------------------------------------------------------

  it('o link mostra a posição de quem o tem, e nada da fila alheia', async () => {
    const carlos = await entrar(CARLOS, RUAN);
    await entrar(JOAO, RUAN, new Date(AGORA.getTime() + 60_000));

    const minha = await queuePositionByToken({
      tenantId: TENANT,
      locationId: LOCATION,
      timezone: TZ,
      token: carlos.token,
      now: AGORA,
    });

    expect(minha).toMatchObject({ posicao: 1, nome: 'Carlos Souza' });
    // Nenhum campo carrega a fila inteira nem o nome de mais ninguém.
    expect(JSON.stringify(minha)).not.toContain('Joao');
  });

  it('token inventado não abre a fila de ninguém', async () => {
    await entrar(CARLOS);
    const minha = await queuePositionByToken({
      tenantId: TENANT,
      locationId: LOCATION,
      timezone: TZ,
      token: 'chute-de-quem-nao-tem-o-link',
      now: AGORA,
    });

    expect(minha).toBeNull();
  });

  it('o link continua respondendo depois que a pessoa sai da fila', async () => {
    const entrada = await entrar(CARLOS);
    await moveQueueEntry({
      tenantId: TENANT,
      queueEntryId: entrada.id,
      para: 'gave_up',
      now: AGORA,
    });

    const minha = await queuePositionByToken({
      tenantId: TENANT,
      locationId: LOCATION,
      timezone: TZ,
      token: entrada.token,
      now: AGORA,
    });

    // 404 depois de ter funcionado parece defeito para quem está esperando.
    expect(minha?.status).toBe('gave_up');
    expect(minha?.frase).toContain('encerrado');
  });

  // -- a parede entre barbearias ---------------------------------------------

  it('a fila de uma barbearia não existe para a outra', async () => {
    const entrada = await entrar(CARLOS);

    const doRival = await getQueue({
      tenantId: RIVAL,
      locationId: LOCATION,
      timezone: TZ,
      now: AGORA,
    });
    expect(doRival.entries).toEqual([]);

    // Nem com o token na mão: a RLS filtra antes de o hash ser comparado.
    const posicao = await queuePositionByToken({
      tenantId: RIVAL,
      locationId: LOCAL_RIVAL,
      timezone: TZ,
      token: entrada.token,
      now: AGORA,
    });
    expect(posicao).toBeNull();

    await expect(
      moveQueueEntry({
        tenantId: RIVAL,
        queueEntryId: entrada.id,
        para: 'gave_up',
        now: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'queue_entry_not_found' });

    await expect(
      seatQueueEntry({
        tenantId: RIVAL,
        queueEntryId: entrada.id,
        professionalId: RUAN,
        now: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'queue_entry_not_found' });
  });
  // -- "você é o próximo", entregue -------------------------------------------

  /** As tarefas de aviso de fila que existem agora, na ordem em que nasceram. */
  const avisosDeFila = async (): Promise<string[]> => {
    const linhas = await admin.$queryRawUnsafe<{ payload: { queueEntryId?: string } }[]>(
      `SELECT payload FROM jobs WHERE kind = 'notificacao.sua_vez' ORDER BY created_at, id`,
    );
    return linhas.map((linha) => linha.payload.queueEntryId ?? '');
  };

  it('quem chega numa fila vazia já é o próximo e é avisado', async () => {
    // A lacuna do bloco 14: a posição e a estimativa existiam, com link próprio
    // por pessoa. Faltava o empurrão — quem sai para dar uma volta não
    // recarrega a página.
    const entrada = await entrar(CARLOS);
    expect(await avisosDeFila()).toEqual([entrada.id]);
  });

  it('quem está atrás só é avisado quando a vez chega de fato', async () => {
    const primeiro = await entrar(CARLOS);
    const segundo = await entrar(JOAO);
    // O segundo não recebe nada enquanto o primeiro está na frente: "você é o
    // próximo" mandado para quem tem gente na frente é mentira.
    expect(await avisosDeFila()).toEqual([primeiro.id]);

    await seatQueueEntry({
      tenantId: TENANT,
      queueEntryId: primeiro.id,
      professionalId: RUAN,
      now: AGORA,
    });
    expect(await avisosDeFila()).toEqual([primeiro.id, segundo.id]);
  });

  it('desistência da frente avisa quem subiu', async () => {
    const primeiro = await entrar(CARLOS);
    const segundo = await entrar(JOAO);

    await moveQueueEntry({
      tenantId: TENANT,
      queueEntryId: primeiro.id,
      para: 'gave_up',
      now: AGORA,
    });
    expect(await avisosDeFila()).toEqual([primeiro.id, segundo.id]);
  });

  it('a mesma pessoa nunca recebe dois avisos na mesma visita', async () => {
    // Entrar primeiro, ser chamada, voltar a esperar e ser chamada de novo é o
    // caminho comum de quem foi tomar um café. Uma mensagem, não quatro.
    const entrada = await entrar(CARLOS);
    for (const para of ['called', 'waiting', 'called'] as const) {
      await moveQueueEntry({ tenantId: TENANT, queueEntryId: entrada.id, para, now: AGORA });
    }
    expect(await avisosDeFila()).toEqual([entrada.id]);
  });

  it('o aviso da fila é tarefa da própria barbearia', async () => {
    // A fila de trabalho não tem RLS de propósito; o que separa as barbearias é
    // o `tenant_id` da tarefa, que o handler usa para abrir `withTenant`.
    await entrar(CARLOS);
    const linhas = await admin.$queryRawUnsafe<{ tenant_id: string }[]>(
      `SELECT tenant_id FROM jobs WHERE kind = 'notificacao.sua_vez'`,
    );
    expect(linhas.map((l) => l.tenant_id)).toEqual([TENANT]);
  });
});
