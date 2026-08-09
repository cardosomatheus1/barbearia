import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeMessagingProvider } from '@barbearia/identity';
import {
  AppointmentsController,
  GuestAppointmentsController,
} from '../src/booking/appointments.controller.js';
import { AuthController, SessionController } from '../src/auth/auth.controller.js';
import { CustomerGuard } from '../src/auth/customer.guard.js';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';
import { limparBanco } from './limpar.js';

/**
 * Fluxo completo do cliente: código no WhatsApp, sessão, agendar, listar,
 * remarcar, cancelar.
 *
 * O provedor de mensagem é o `fake`, que guarda o código em memória — é a única
 * forma de o teste conhecer o código sem que ele apareça em log.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const CABELO = 'eeeeeeee-0000-0000-0000-000000000001';

const CARLOS = '(71) 98888-7777';
const JOAO = '(71) 97777-6666';

let app: INestApplication;
let admin: PrismaClient;
let messaging: FakeMessagingProvider;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const statement of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(statement);
  }
}

/** Data futura o bastante para escapar da antecedência mínima. */
function proximaTerca(): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  do {
    date.setUTCDate(date.getUTCDate() + 1);
  } while (date.getUTCDay() !== 2);
  return date.toISOString().slice(0, 10);
}

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

describeIfDb('fluxo do cliente', () => {
  const DIA = proximaTerca();

  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
    messaging = new FakeMessagingProvider();

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [AuthController, SessionController, GuestAppointmentsController, AppointmentsController],
      providers: [
        TenantService,
        CustomerGuard,
        { provide: MESSAGING_PROVIDER, useValue: messaging },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    messaging.clear();
    await limparBanco(admin);
    await exec(admin, `
      INSERT INTO tenants (id, name) VALUES
        ('${TENANT}', 'Domari Barber Club'), ('${RIVAL}', 'Rival');

      INSERT INTO tenant_slugs (slug, tenant_id, is_primary) VALUES
        ('domari', '${TENANT}', true), ('rival', '${RIVAL}', true);

      INSERT INTO locations (id, tenant_id, name, timezone, granularity_minutes)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia', 20);

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', 'Cabelo', 4900, 20);

      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      VALUES ('${RUAN}', '${CABELO}', '${TENANT}');

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', '${RUAN}', d.weekday, 540, 1080
      FROM (VALUES (0), (1), (2), (3), (4), (5), (6)) AS d(weekday);
    `);
  });

  const http = () => request(app.getHttpServer());

  /** Percorre o fluxo de login e devolve o token. */
  async function login(phone: string, slug = 'domari'): Promise<string> {
    await http().post(`/v1/b/${slug}/auth/otp`).send({ phone, name: 'Carlos Souza' }).expect(201);
    const sent = messaging.sent.at(-1);
    if (!sent) throw new Error('nenhum código enviado');

    const response = await http()
      .post(`/v1/b/${slug}/auth/verify`)
      .send({ phone, code: sent.code })
      .expect(201);
    return response.body.token as string;
  }

  /** Agenda sem sessão: nome + celular, como o mercado faz. */
  const agendarComoConvidado = (phone: string, start = '09:00', key?: string) => {
    const req = http().post('/v1/b/domari/appointments');
    if (key) req.set('Idempotency-Key', key);
    return req.send({
      name: 'Carlos Souza',
      phone,
      locationId: LOCATION,
      professionalId: RUAN,
      serviceIds: [CABELO],
      date: DIA,
      start,
    });
  };

  const agendar = (token: string, start = '09:00', key?: string) => {
    const req = http()
      .post('/v1/b/domari/appointments')
      .set('Authorization', `Bearer ${token}`);
    if (key) req.set('Idempotency-Key', key);
    return req.send({
      locationId: LOCATION,
      professionalId: RUAN,
      serviceIds: [CABELO],
      date: DIA,
      start,
    });
  };

  // -- login -----------------------------------------------------------------

  it('percorre o fluxo do código até a sessão', async () => {
    const otp = await http()
      .post('/v1/b/domari/auth/otp')
      .send({ phone: CARLOS, name: 'Carlos Souza' })
      .expect(201);

    expect(otp.body.expiresInSeconds).toBe(300);
    expect(otp.body.resendAfterSeconds).toBe(30);
    // O código nunca volta na resposta.
    expect(JSON.stringify(otp.body)).not.toContain(messaging.sent[0]?.code);

    const verify = await http()
      .post('/v1/b/domari/auth/verify')
      .send({ phone: CARLOS, code: messaging.sent[0]?.code })
      .expect(201);

    expect(verify.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verify.body.customer.name).toBe('Carlos Souza');
  });

  it('código errado devolve 401 sem distinguir o motivo', async () => {
    await http().post('/v1/b/domari/auth/otp').send({ phone: CARLOS }).expect(201);

    const errado = await http()
      .post('/v1/b/domari/auth/verify')
      .send({ phone: CARLOS, code: '000000' })
      .expect(401);

    const semDesafio = await http()
      .post('/v1/b/domari/auth/verify')
      .send({ phone: JOAO, code: '000000' })
      .expect(401);

    expect(errado.body.error.message).toBe(semDesafio.body.error.message);
  });

  it('recusa código malformado sem consultar o banco', async () => {
    for (const code of ['12345', 'abcdef', '', '1234567']) {
      await http()
        .post('/v1/b/domari/auth/verify')
        .send({ phone: CARLOS, code })
        .expect(400);
    }
  });

  it('estabelecimento inexistente devolve 404', async () => {
    await http().post('/v1/b/nao-existe/auth/otp').send({ phone: CARLOS }).expect(404);
  });

  // -- guard -----------------------------------------------------------------

  it('ver agendamentos exige sessão', async () => {
    await http().get('/v1/b/domari/appointments').expect(401);
  });

  it('agendar não exige sessão — nome e celular bastam', async () => {
    const criado = await agendarComoConvidado(CARLOS).expect(201);
    expect(criado.body.priceCents).toBe(4900);
    expect(criado.body.status).toBe('pending');
  });

  it('agendar sem sessão e sem nome é recusado', async () => {
    await http()
      .post('/v1/b/domari/appointments')
      .send({
        locationId: LOCATION, professionalId: RUAN, serviceIds: [CABELO],
        date: DIA, start: '09:00',
      })
      .expect(400);
  });

  it('convidado não vê nem cancela o que agendou sem validar o número', async () => {
    const criado = await agendarComoConvidado(CARLOS).expect(201);

    // Sem código, não há sessão: ver e cancelar continuam fechados. É a mesma
    // fronteira do concorrente.
    await http().get('/v1/b/domari/appointments').expect(401);
    await http()
      .post(`/v1/b/domari/appointments/${criado.body.id}/cancel`)
      .send({})
      .expect(401);
  });

  it('o comprovante é legível sem sessão e não expõe o cliente', async () => {
    const criado = await agendarComoConvidado(CARLOS).expect(201);

    const comprovante = await http()
      .get(`/v1/b/domari/appointments/${criado.body.id}`)
      .expect(200);

    expect(comprovante.body.services).toEqual(['Cabelo']);
    expect(comprovante.body.professionalName).toBe('Ruan');
    expect(comprovante.body.priceCents).toBe(4900);
    expect(comprovante.body.state).toBe('active');

    // O link pode ser encaminhado. Quem o receber vê o horário, não a pessoa.
    const corpo = JSON.stringify(comprovante.body);
    expect(corpo).not.toContain('Carlos');
    expect(corpo).not.toContain('98888');
  });

  it('o comprovante de uma barbearia não é legível pelo slug de outra', async () => {
    const criado = await agendarComoConvidado(CARLOS).expect(201);

    // Mesmo id, slug do rival: a RLS não enxerga a linha e a rota devolve 404.
    await http().get(`/v1/b/rival/appointments/${criado.body.id}`).expect(404);
  });

  it('o comprovante acompanha o cancelamento', async () => {
    const criado = await agendarComoConvidado(CARLOS).expect(201);
    const token = await login(CARLOS);

    await http()
      .post(`/v1/b/domari/appointments/${criado.body.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);

    const depois = await http().get(`/v1/b/domari/appointments/${criado.body.id}`).expect(200);
    expect(depois.body.state).toBe('cancelled');
  });

  it('atendimento concluído não vira "cancelado" no comprovante', async () => {
    // `completed` não passa por rota de cliente; só o status final importa aqui.
    const criado = await agendarComoConvidado(CARLOS).expect(201);
    await admin.$executeRawUnsafe(
      `UPDATE appointments SET status = 'completed' WHERE id = '${criado.body.id}'`,
    );

    const depois = await http().get(`/v1/b/domari/appointments/${criado.body.id}`).expect(200);
    expect(depois.body.state).toBe('done');
  });

  it('comprovante de id inexistente devolve 404, não 500', async () => {
    await http()
      .get('/v1/b/domari/appointments/99999999-9999-4999-8999-999999999999')
      .expect(404);
  });

  it('validando o número depois, o convidado reencontra o agendamento', async () => {
    const criado = await agendarComoConvidado(CARLOS).expect(201);

    const token = await login(CARLOS);
    const lista = await http()
      .get('/v1/b/domari/appointments')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(lista.body.appointments.map((a: { id: string }) => a.id)).toContain(criado.body.id);
  });

  it('unidade que exige validação recusa agendamento sem sessão', async () => {
    await admin.$executeRawUnsafe(
      `UPDATE locations SET require_otp_for_booking = true WHERE id = '${LOCATION}'`,
    );
    const recusa = await agendarComoConvidado(CARLOS).expect(401);
    expect(recusa.body.error.code).toBe('otp_required');

    const token = await login(CARLOS);
    await agendar(token).expect(201);
  });

  it('recusa token inventado e cabeçalho malformado', async () => {
    for (const header of ['Bearer invalido', 'invalido', 'Basic abc', 'Bearer ']) {
      await http().get('/v1/b/domari/appointments').set('Authorization', header).expect(401);
    }
  });

  it('token de uma barbearia não vale em outra', async () => {
    const token = await login(CARLOS);
    await http()
      .get('/v1/b/rival/appointments')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  // -- agendamento -----------------------------------------------------------

  it('cria agendamento e ele aparece na lista do cliente', async () => {
    const token = await login(CARLOS);

    const criado = await agendar(token).expect(201);
    expect(criado.body.priceCents).toBe(4900);
    expect(criado.body.status).toBe('pending');

    const lista = await http()
      .get('/v1/b/domari/appointments')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(lista.body.appointments).toHaveLength(1);
    expect(lista.body.appointments[0]).toMatchObject({
      id: criado.body.id,
      professionalName: 'Ruan',
      services: ['Cabelo'],
      canCancel: true,
    });
  });

  it('a mesma Idempotency-Key não cria dois', async () => {
    const token = await login(CARLOS);

    const primeiro = await agendar(token, '09:00', 'chave-do-cliente').expect(201);
    const segundo = await agendar(token, '09:00', 'chave-do-cliente').expect(201);
    expect(segundo.body.id).toBe(primeiro.body.id);
  });

  it('clientes diferentes com a mesma chave não colidem', async () => {
    const tokenCarlos = await login(CARLOS);
    messaging.clear();
    const tokenJoao = await login(JOAO);

    const doCarlos = await agendar(tokenCarlos, '09:00', '1').expect(201);
    const doJoao = await agendar(tokenJoao, '09:20', '1').expect(201);

    expect(doJoao.body.id).not.toBe(doCarlos.body.id);
  });

  it('horário ocupado devolve 409', async () => {
    const token = await login(CARLOS);
    await agendar(token, '09:00', 'a').expect(201);
    const conflito = await agendar(token, '09:00', 'b').expect(409);
    expect(conflito.body.error.code).toBe('slot_not_available');
  });

  it('rejeita corpo malformado', async () => {
    const token = await login(CARLOS);
    const casos = [
      { locationId: 'x', professionalId: RUAN, serviceIds: [CABELO], date: DIA, start: '09:00' },
      { locationId: LOCATION, professionalId: RUAN, serviceIds: [], date: DIA, start: '09:00' },
      { locationId: LOCATION, professionalId: RUAN, serviceIds: [CABELO], date: '11/08', start: '09:00' },
      { locationId: LOCATION, professionalId: RUAN, serviceIds: [CABELO], date: DIA, start: '25:00' },
    ];
    for (const body of casos) {
      await http()
        .post('/v1/b/domari/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);
    }
  });

  // -- titularidade ----------------------------------------------------------

  it('cliente não vê agendamento de outro cliente', async () => {
    const tokenCarlos = await login(CARLOS);
    await agendar(tokenCarlos).expect(201);

    messaging.clear();
    const tokenJoao = await login(JOAO);
    const lista = await http()
      .get('/v1/b/domari/appointments')
      .set('Authorization', `Bearer ${tokenJoao}`)
      .expect(200);

    expect(lista.body.appointments).toEqual([]);
  });

  it('cliente não cancela agendamento de outro cliente', async () => {
    const tokenCarlos = await login(CARLOS);
    const criado = await agendar(tokenCarlos).expect(201);

    messaging.clear();
    const tokenJoao = await login(JOAO);
    await http()
      .post(`/v1/b/domari/appointments/${criado.body.id}/cancel`)
      .set('Authorization', `Bearer ${tokenJoao}`)
      .send({})
      .expect(404);

    const rows = await admin.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status FROM appointments WHERE id = '${criado.body.id}'`,
    );
    expect(rows[0]?.status).toBe('pending');
  });

  it('cliente não remarca agendamento de outro cliente', async () => {
    const tokenCarlos = await login(CARLOS);
    const criado = await agendar(tokenCarlos).expect(201);

    messaging.clear();
    const tokenJoao = await login(JOAO);
    await http()
      .post(`/v1/b/domari/appointments/${criado.body.id}/reschedule`)
      .set('Authorization', `Bearer ${tokenJoao}`)
      .send({ date: DIA, start: '14:00' })
      .expect(404);
  });

  // -- cancelar e remarcar ---------------------------------------------------

  it('o dono cancela e o horário volta a ficar livre', async () => {
    const token = await login(CARLOS);
    const criado = await agendar(token).expect(201);

    await http()
      .post(`/v1/b/domari/appointments/${criado.body.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);

    await agendar(token, '09:00', 'outra').expect(201);
  });

  it('o dono remarca', async () => {
    const token = await login(CARLOS);
    const criado = await agendar(token).expect(201);

    const novo = await http()
      .post(`/v1/b/domari/appointments/${criado.body.id}/reschedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({ date: DIA, start: '14:00' })
      .expect(201);

    expect(novo.body.id).not.toBe(criado.body.id);
  });

  it('identificador malformado não chega ao banco', async () => {
    const token = await login(CARLOS);
    await http()
      .post('/v1/b/domari/appointments/nao-e-uuid/cancel')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(400);
  });

  // -- janela de cancelamento e remarcação -----------------------------------

  /**
   * Aproxima o agendamento do agora, para exercitar a janela sem esperar.
   *
   * Desloca as quatro colunas pelo mesmo intervalo. Mexer só em
   * `service_starts_at` viola `appointments_service_within_occupied` — o banco
   * recusou, e com razão: o serviço tem que caber na janela ocupada.
   */
  async function aproximar(id: string, minutos: number): Promise<void> {
    await admin.$executeRawUnsafe(
      `UPDATE appointments
         SET starts_at = starts_at + deslocamento,
             ends_at = ends_at + deslocamento,
             service_starts_at = service_starts_at + deslocamento,
             service_ends_at = service_ends_at + deslocamento
       FROM (
         SELECT (now() + interval '${minutos} minutes') - service_starts_at AS deslocamento
         FROM appointments WHERE id = '${id}'
       ) AS shift
       WHERE id = '${id}'`,
    );
  }

  it('cliente não cancela dentro da janela de antecedência', async () => {
    const token = await login(CARLOS);
    const criado = await agendar(token).expect(201);
    await aproximar(criado.body.id, 90); // padrão da unidade: 2 horas

    const recusa = await http()
      .post(`/v1/b/domari/appointments/${criado.body.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(409);

    expect(recusa.body.error.code).toBe('too_late');
    // O texto carrega o número, senão o cliente não sabe qual é a regra.
    expect(recusa.body.error.message).toContain('2 horas');
  });

  it('cancelar continua valendo fora da janela', async () => {
    const token = await login(CARLOS);
    const criado = await agendar(token).expect(201);
    await aproximar(criado.body.id, 121);

    await http()
      .post(`/v1/b/domari/appointments/${criado.body.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
  });

  it('janela zero na unidade libera o cancelamento em cima da hora', async () => {
    // Prova que a regra é dado, não constante: mudar a coluna muda o resultado.
    await admin.$executeRawUnsafe(
      `UPDATE locations SET cancel_min_hours = 0 WHERE id = '${LOCATION}'`,
    );
    const token = await login(CARLOS);
    const criado = await agendar(token).expect(201);
    await aproximar(criado.body.id, 10);

    await http()
      .post(`/v1/b/domari/appointments/${criado.body.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
  });

  it('a lista avisa por que o botão sumiu', async () => {
    const token = await login(CARLOS);
    const criado = await agendar(token).expect(201);
    await aproximar(criado.body.id, 30);

    const lista = await http()
      .get('/v1/b/domari/appointments')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const item = lista.body.appointments.find(
      (a: { id: string }) => a.id === criado.body.id,
    );
    expect(item.canCancel).toBe(false);
    expect(item.canReschedule).toBe(false);
    expect(item.blockedReason).toBe('too_late');
    expect(item.minHoursToChange).toBe(2);
  });

  it('a lista libera os botões quando há folga', async () => {
    const token = await login(CARLOS);
    const criado = await agendar(token).expect(201);

    const lista = await http()
      .get('/v1/b/domari/appointments')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const item = lista.body.appointments.find(
      (a: { id: string }) => a.id === criado.body.id,
    );
    expect(item.canCancel).toBe(true);
    expect(item.blockedReason).toBe(null);
  });

  it('remarcar esgota no teto da unidade', async () => {
    await admin.$executeRawUnsafe(
      `UPDATE locations SET max_reschedules = 1 WHERE id = '${LOCATION}'`,
    );
    const token = await login(CARLOS);
    const criado = await agendar(token).expect(201);

    const primeira = await http()
      .post(`/v1/b/domari/appointments/${criado.body.id}/reschedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({ date: DIA, start: '10:00' })
      .expect(201);

    const segunda = await http()
      .post(`/v1/b/domari/appointments/${primeira.body.id}/reschedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({ date: DIA, start: '11:00' })
      .expect(409);

    expect(segunda.body.error.code).toBe('too_many_reschedules');
  });

  it('a contagem de remarcações segue a corrente, não o registro isolado', async () => {
    // Cada remarcação cria um agendamento novo. Contar só o registro atual
    // daria zero sempre e o teto nunca chegaria.
    const token = await login(CARLOS);
    const criado = await agendar(token).expect(201);

    const primeira = await http()
      .post(`/v1/b/domari/appointments/${criado.body.id}/reschedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({ date: DIA, start: '10:00' })
      .expect(201);

    const lista = await http()
      .get('/v1/b/domari/appointments')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const item = lista.body.appointments.find(
      (a: { id: string }) => a.id === primeira.body.id,
    );
    // Teto padrão 2, já usou 1: ainda pode.
    expect(item.canReschedule).toBe(true);
  });

  // -- grade de remarcação ---------------------------------------------------

  it('todo horário oferecido para remarcar é aceito pela remarcação', async () => {
    // O defeito que este teste tranca: a grade pública conta o horário atual do
    // cliente como ocupado, e com a estratégia `anchored` ele ancora os slots.
    // Na gravação o horário é ignorado, a grade recomeça da jornada e nenhum
    // dos horários exibidos existe mais — toda escolha voltava recusada.
    // Duração de 25 min numa grade de 20 é o caso que expõe a divergência: com
    // o horário atual ancorando, a grade sai 09:25, 09:45…; ignorando-o, sai
    // 09:00, 09:20, 09:40… — conjuntos sem interseção no começo do dia. Com
    // duração múltipla da granularidade o defeito fica escondido.
    const BARBA = 'eeeeeeee-0000-0000-0000-000000000009';
    await exec(admin, `
      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${BARBA}', '${TENANT}', 'Barba longa', 5500, 25);

      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      VALUES ('${RUAN}', '${BARBA}', '${TENANT}');
    `);

    const token = await login(CARLOS);
    const criado = await http()
      .post('/v1/b/domari/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        locationId: LOCATION, professionalId: RUAN, serviceIds: [BARBA],
        date: DIA, start: '09:00',
      })
      .expect(201);

    const grade = await http()
      .get(`/v1/b/domari/appointments/${criado.body.id}/availability?dateFrom=${DIA}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const primeiro = grade.body.days[0].slots[0];
    expect(primeiro).toBeDefined();

    await http()
      .post(`/v1/b/domari/appointments/${criado.body.id}/reschedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({ date: DIA, start: primeiro.start })
      .expect(201);
  });

  it('a grade de remarcação devolve o próprio horário como livre', async () => {
    const token = await login(CARLOS);
    const criado = await agendar(token, '09:00').expect(201);

    const grade = await http()
      .get(`/v1/b/domari/appointments/${criado.body.id}/availability?dateFrom=${DIA}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const inicios = grade.body.days[0].slots.map((s: { start: string }) => s.start);
    expect(inicios).toContain('09:00');
  });

  it('remarcar pode trocar de profissional', async () => {
    // Antes só dava para trocar de horário. Mudar de barbeiro exigia cancelar e
    // agendar de novo — jogando fora o horário atual antes de saber se havia
    // outro. Aqui o antigo só sai quando o novo entra.
    const GLEIDSON = 'bbbbbbbb-0000-0000-0000-000000000002';
    await exec(admin, `
      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${GLEIDSON}', '${TENANT}', '${LOCATION}', 'Gleidson', 'professional');

      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      VALUES ('${GLEIDSON}', '${CABELO}', '${TENANT}');

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', '${GLEIDSON}', d.weekday, 540, 1080
      FROM (VALUES (0), (1), (2), (3), (4), (5), (6)) AS d(weekday);
    `);

    const token = await login(CARLOS);
    const criado = await agendar(token, '09:00').expect(201);

    const grade = await http()
      .get(`/v1/b/domari/appointments/${criado.body.id}/availability?dateFrom=${DIA}&professionalId=${GLEIDSON}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(grade.body.currentProfessionalId).toBe(RUAN);
    const slots = grade.body.days[0].slots;
    expect(slots.length).toBeGreaterThan(0);
    expect(new Set(slots.map((s: { professionalId: string }) => s.professionalId))).toEqual(
      new Set([GLEIDSON]),
    );

    const remarcado = await http()
      .post(`/v1/b/domari/appointments/${criado.body.id}/reschedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({ date: DIA, start: slots[0].start, professionalId: GLEIDSON })
      .expect(201);

    expect(remarcado.body.professionalId).toBe(GLEIDSON);
  });

  it('a grade de "qualquer profissional" traz um horário por linha', async () => {
    const GLEIDSON = 'bbbbbbbb-0000-0000-0000-000000000002';
    await exec(admin, `
      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${GLEIDSON}', '${TENANT}', '${LOCATION}', 'Gleidson', 'professional');

      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      VALUES ('${GLEIDSON}', '${CABELO}', '${TENANT}');

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', '${GLEIDSON}', d.weekday, 540, 1080
      FROM (VALUES (0), (1), (2), (3), (4), (5), (6)) AS d(weekday);
    `);

    const token = await login(CARLOS);
    const criado = await agendar(token, '09:00').expect(201);

    const grade = await http()
      .get(`/v1/b/domari/appointments/${criado.body.id}/availability?dateFrom=${DIA}&professionalId=any`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Sem colapso a lista mostraria "09:20 Ruan" e "09:20 Gleidson" lado a lado,
    // gastando a tela para repetir a mesma informação.
    const inicios = grade.body.days[0].slots.map((s: { start: string }) => s.start);
    expect(new Set(inicios).size).toBe(inicios.length);
  });

  it('remarcar não aceita trocar o serviço pela URL', async () => {
    // Os serviços vêm do agendamento. Aceitá-los da requisição deixaria remarcar
    // para um serviço mais caro pelo preço do antigo.
    const token = await login(CARLOS);
    const criado = await agendar(token, '09:00').expect(201);

    const grade = await http()
      .get(`/v1/b/domari/appointments/${criado.body.id}/availability?dateFrom=${DIA}&serviceIds=${CABELO}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(grade.body.days[0].slots.length).toBeGreaterThan(0);
  });

  it('a grade de remarcação exige sessão e é do dono', async () => {
    const token = await login(CARLOS);
    const criado = await agendar(token, '09:00').expect(201);

    await http()
      .get(`/v1/b/domari/appointments/${criado.body.id}/availability?dateFrom=${DIA}`)
      .expect(401);

    const outro = await login(JOAO);
    await http()
      .get(`/v1/b/domari/appointments/${criado.body.id}/availability?dateFrom=${DIA}`)
      .set('Authorization', `Bearer ${outro}`)
      .expect(404);
  });

  it('sair revoga a sessão no servidor, não só no navegador', async () => {
    const token = await login(CARLOS);
    await http()
      .get('/v1/b/domari/appointments')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await http()
      .post('/v1/b/domari/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    // O mesmo token, que o navegador poderia ter guardado, deixa de valer.
    await http()
      .get('/v1/b/domari/appointments')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('nunca vaza detalhe interno em erro de rota autenticada', async () => {
    const token = await login(CARLOS);
    const response = await http()
      .post('/v1/b/domari/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({ locationId: 'x', professionalId: RUAN, serviceIds: [CABELO], date: DIA, start: '09:00' })
      .expect(400);

    const body = JSON.stringify(response.body).toLowerCase();
    for (const leak of ['select', 'insert', 'postgres', 'prisma', 'stack']) {
      expect(body).not.toContain(leak);
    }
  });
});
