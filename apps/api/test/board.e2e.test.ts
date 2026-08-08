import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BoardController } from '../src/admin/board.controller.js';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';

/**
 * O balcão pela HTTP.
 *
 * A pergunta central é a mesma do painel do gestor, com uma agravante: aqui
 * circulam nome e telefone de cliente. Além do isolamento entre barbearias,
 * estes testes verificam que nenhuma rota devolve o telefone completo e que
 * ninguém opera o dia sem sessão.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

let app: INestApplication;
let admin: PrismaClient;
let tenants: TenantService;

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const CONTA = {
  name: 'Matheus Cardoso',
  email: 'matheus@domari.com.br',
  password: 'senha-bem-comprida',
  phone: '(71) 98888-7777',
  businessName: 'Domari Barber Club',
};

const RIVAL = {
  name: 'Dono Rival',
  email: 'dono@rival.com.br',
  password: 'outra-senha-comprida',
  phone: '(71) 97777-6666',
  businessName: 'Rival Barbearia',
};

// Jornada larga o bastante para o teste marcar em qualquer horário útil.
const JORNADA = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 480,
  endMinute: 1320,
}));

describeIfDb('balcão', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [StaffAuthController, OnboardingController, BoardController],
      providers: [
        TenantService,
        StaffGuard,
        PermissaoGuard,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
      ],
    }).compile();

    tenants = moduleRef.get(TenantService);
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE staff_directory CASCADE');
    for (const slug of ['domari-barber-club', 'rival-barbearia']) {
      tenants.forget(slug);
    }
  });

  const http = () => request(app.getHttpServer());

  async function abrirBarbearia(conta = CONTA): Promise<string> {
    await http().post('/v1/admin/signup').send(conta).expect(202);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email: conta.email, password: conta.password })
      .expect(201);
    const token: string = entrou.body.token;

    await http()
      .put('/v1/admin/business')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: conta.businessName, city: 'Salvador', timezone: 'America/Bahia' })
      .expect(200);

    await http()
      .put('/v1/admin/services')
      .set('Authorization', `Bearer ${token}`)
      .send({
        services: [
          {
            key: 'cabelo',
            name: 'Corte de cabelo',
            category: 'Cabelo',
            durationMinutes: 30,
            bufferAfterMinutes: 0,
            priceCents: 4900,
          },
        ],
      })
      .expect(200);

    await http()
      .put('/v1/admin/professionals')
      .set('Authorization', `Bearer ${token}`)
      .send({ professionals: [{ name: 'Ruan Nascimento', schedule: JORNADA }] })
      .expect(200);

    await http()
      .post('/v1/admin/publish')
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    return token;
  }

  const comAuth = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  async function catalogo(token: string) {
    const resposta = await comAuth(token)(http().get('/v1/admin/catalog')).expect(200);
    return {
      serviceId: resposta.body.services[0].id as string,
      professionalId: resposta.body.professionals[0].id as string,
    };
  }

  function maisDias(data: string, dias: number): string {
    const d = new Date(`${data}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Primeiro horário que a grade do balcão oferecer nos próximos dias.
   *
   * Varre uma faixa em vez de fixar "hoje" porque a suíte roda a qualquer hora:
   * às onze da noite não sobra horário no dia, e o teste passaria a falhar por
   * causa do relógio e não por causa do código. A regra de antecedência tem
   * prova própria, com relógio injetado, em `packages/scheduling`.
   */
  async function primeiroHorario(token: string, query: Record<string, string> = {}) {
    const { serviceId, professionalId } = await catalogo(token);
    const dia = await comAuth(token)(http().get('/v1/admin/day')).expect(200);
    const hoje: string = dia.body.today;

    const grade = await comAuth(token)(
      http().get('/v1/admin/availability').query({
        serviceIds: serviceId,
        professionalId,
        dateFrom: hoje,
        dateTo: maisDias(hoje, 2),
        ...query,
      }),
    ).expect(200);

    const livre = grade.body.days.find((d: { slots: unknown[] }) => d.slots.length > 0);
    return { serviceId, professionalId, hoje, livre };
  }

  /** O primeiro horário livre, marcado pelo balcão. */
  async function marcarPeloBalcao(
    token: string,
    cliente = { name: 'João da Silva', phone: '(71) 98888-1234' },
  ) {
    const { serviceId, professionalId, hoje, livre } = await primeiroHorario(token);
    expect(livre, 'a grade do balcão não ofereceu horário nenhum em três dias').toBeDefined();

    const criado = await comAuth(token)(
      http().post('/v1/admin/appointments').send({
        ...cliente,
        professionalId,
        serviceIds: [serviceId],
        date: livre.date,
        start: livre.slots[0].start,
      }),
    ).expect(201);

    return {
      id: criado.body.id as string,
      hoje,
      date: livre.date as string,
      start: livre.slots[0].start as string,
      serviceId,
      professionalId,
    };
  }

  // -- acesso ----------------------------------------------------------------

  it('ninguém opera o balcão sem sessão', async () => {
    const chamadas = [
      () => http().get('/v1/admin/day'),
      () => http().get('/v1/admin/catalog'),
      () => http().get('/v1/admin/customers').query({ q: 'silva' }),
      () => http().post('/v1/admin/appointments').send({}),
    ];
    for (const chamada of chamadas) {
      await chamada().expect(401);
    }
  });

  // -- o dia -----------------------------------------------------------------

  it('mostra o dia da barbearia, com totais e ações possíveis', async () => {
    const token = await abrirBarbearia();
    const { id, date } = await marcarPeloBalcao(token);

    const dia = await comAuth(token)(http().get('/v1/admin/day').query({ date })).expect(200);

    expect(dia.body.timezone).toBe('America/Bahia');
    expect(dia.body.totals.esperados).toBe(1);
    const item = dia.body.entries.find((e: { id: string }) => e.id === id);
    expect(item.customerName).toBe('João da Silva');
    // Quem acabou de ser marcado ainda não chegou: check-in e falta, não
    // "concluir".
    expect(item.actions).toContain('check_in');
    expect(item.actions).not.toContain('complete');
  });

  it('não devolve o telefone completo do cliente em lugar nenhum', async () => {
    // A tela do balcão fica virada para o salão. Quem passa na frente do
    // notebook não leva a base de contatos junto.
    const token = await abrirBarbearia();
    await marcarPeloBalcao(token, { name: 'João da Silva', phone: '(71) 98888-1234' });

    const dia = await comAuth(token)(http().get('/v1/admin/day')).expect(200);
    const busca = await comAuth(token)(
      http().get('/v1/admin/customers').query({ q: 'silva' }),
    ).expect(200);

    for (const corpo of [dia.body, busca.body]) {
      expect(JSON.stringify(corpo)).not.toContain('+5571988881234');
    }
    expect(busca.body.customers[0].phoneMasked).toBe('+55719****1234');
  });

  it('a data pedida é validada antes de chegar ao banco', async () => {
    const token = await abrirBarbearia();
    await comAuth(token)(http().get('/v1/admin/day').query({ date: 'ontem' })).expect(400);
    await comAuth(token)(http().get('/v1/admin/day').query({ date: "2026-08-11'" })).expect(400);
  });

  // -- atendimento -----------------------------------------------------------

  it('percorre chegada, início e fim pelo balcão', async () => {
    const token = await abrirBarbearia();
    const { id, date } = await marcarPeloBalcao(token);

    for (const action of ['check_in', 'start', 'complete']) {
      await comAuth(token)(
        http().post(`/v1/admin/appointments/${id}/attendance`).send({ action }),
      ).expect(201);
    }

    const dia = await comAuth(token)(http().get('/v1/admin/day').query({ date })).expect(200);
    expect(dia.body.totals.concluidos).toBe(1);
    expect(dia.body.totals.realizadoCents).toBe(4900);
  });

  it('a segunda pessoa a tocar o mesmo cartão recebe 409, não silêncio', async () => {
    const token = await abrirBarbearia();
    const { id } = await marcarPeloBalcao(token);

    await comAuth(token)(
      http().post(`/v1/admin/appointments/${id}/attendance`).send({ action: 'check_in' }),
    ).expect(201);

    const repetido = await comAuth(token)(
      http().post(`/v1/admin/appointments/${id}/attendance`).send({ action: 'check_in' }),
    ).expect(409);
    expect(repetido.body.error.code).toBe('transition_not_allowed');
  });

  it('recusa ação que não existe na máquina de estados', async () => {
    const token = await abrirBarbearia();
    const { id } = await marcarPeloBalcao(token);

    await comAuth(token)(
      http().post(`/v1/admin/appointments/${id}/attendance`).send({ action: 'apagar' }),
    ).expect(400);
  });

  // -- marcação pelo balcão --------------------------------------------------

  it('marca mesmo quando a antecedência mínima esvazia a grade do site', async () => {
    // Quatro dias de antecedência mínima: pelo site não sobra horário nenhum
    // na faixa consultada. Com a pessoa de pé na frente da recepção, a grade do
    // balcão precisa oferecer e a gravação precisa aceitar — as duas pela mesma
    // regra, senão o operador clica e leva 409.
    const token = await abrirBarbearia();
    await admin.$executeRawUnsafe('UPDATE locations SET min_lead_minutes = 5760');

    const { id } = await marcarPeloBalcao(token);
    expect(id).toBeTruthy();
  });

  it('duplo toque no botão não cria dois agendamentos', async () => {
    const token = await abrirBarbearia();
    const { serviceId, professionalId, livre } = await primeiroHorario(token);
    expect(livre).toBeDefined();

    const corpo = {
      name: 'João da Silva',
      phone: '(71) 98888-1234',
      professionalId,
      serviceIds: [serviceId],
      date: livre.date,
      start: livre.slots[0].start,
    };

    const primeiro = await comAuth(token)(
      http().post('/v1/admin/appointments').set('Idempotency-Key', 'balcao-1').send(corpo),
    ).expect(201);
    const segundo = await comAuth(token)(
      http().post('/v1/admin/appointments').set('Idempotency-Key', 'balcao-1').send(corpo),
    ).expect(201);

    expect(segundo.body.id).toBe(primeiro.body.id);
  });

  it('recusa telefone inválido com mensagem, não com erro de banco', async () => {
    const token = await abrirBarbearia();
    const { serviceId, professionalId, hoje } = await primeiroHorario(token);

    const resposta = await comAuth(token)(
      http().post('/v1/admin/appointments').send({
        name: 'João da Silva',
        phone: '11111111',
        professionalId,
        serviceIds: [serviceId],
        date: hoje,
        start: '09:00',
      }),
    ).expect(400);

    expect(resposta.body.error.code).toBe('invalid_phone');
  });

  it('marca para um cliente que a busca achou, sem pedir o celular de novo', async () => {
    // O balcão nunca vê o número completo; sem poder mandar o id, teria que
    // criar o terceiro cadastro do mesmo João para marcar o horário dele.
    const token = await abrirBarbearia();
    await marcarPeloBalcao(token);

    const busca = await comAuth(token)(
      http().get('/v1/admin/customers').query({ q: 'silva' }),
    ).expect(200);
    const customerId: string = busca.body.customers[0].id;

    const { serviceId, professionalId, livre } = await primeiroHorario(token);
    const segundo = livre.slots[1] ?? livre.slots[0];

    await comAuth(token)(
      http().post('/v1/admin/appointments').send({
        customerId,
        professionalId,
        serviceIds: [serviceId],
        date: livre.date,
        start: segundo.start,
      }),
    ).expect(201);

    // Continua sendo o mesmo cliente: nada de cadastro duplicado.
    const clientes = await admin.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT count(*) FROM customers',
    );
    expect(Number(clientes[0]?.count)).toBe(1);
  });

  it('recusa marcar em nome de cliente de outra barbearia', async () => {
    // A chave estrangeira de `customer_id` não conhece tenant e a checagem de
    // integridade do Postgres não passa pela RLS: sem a conferência explícita,
    // este id seria gravado e o nome de um cliente alheio apareceria no painel.
    const domari = await abrirBarbearia();
    await marcarPeloBalcao(domari);
    const busca = await comAuth(domari)(
      http().get('/v1/admin/customers').query({ q: 'silva' }),
    ).expect(200);
    const alheio: string = busca.body.customers[0].id;

    const rival = await abrirBarbearia(RIVAL);
    const { serviceId, professionalId, livre } = await primeiroHorario(rival);

    const resposta = await comAuth(rival)(
      http().post('/v1/admin/appointments').send({
        customerId: alheio,
        professionalId,
        serviceIds: [serviceId],
        date: livre.date,
        start: livre.slots[0].start,
      }),
    ).expect(404);
    expect(resposta.body.error.code).toBe('customer_not_found');
  });

  it('recusa marcar sem dizer para quem', async () => {
    const token = await abrirBarbearia();
    const { serviceId, professionalId, livre } = await primeiroHorario(token);

    await comAuth(token)(
      http().post('/v1/admin/appointments').send({
        professionalId,
        serviceIds: [serviceId],
        date: livre.date,
        start: livre.slots[0].start,
      }),
    ).expect(400);
  });

  // -- busca -----------------------------------------------------------------

  it('não lista a base de clientes para quem digita pouco', async () => {
    const token = await abrirBarbearia();
    await marcarPeloBalcao(token);

    const curta = await comAuth(token)(
      http().get('/v1/admin/customers').query({ q: 'jo' }),
    ).expect(200);
    expect(curta.body.customers).toEqual([]);

    await comAuth(token)(http().get('/v1/admin/customers').query({ q: '' })).expect(400);
  });

  it('curinga não transforma a busca em exportação da base', async () => {
    // O escape mora no SQL, depois de `sem_acento`. Este teste guarda o caminho
    // inteiro: se alguém voltar a escapar em JavaScript, `％` (largura inteira)
    // volta a virar `%` na conversão e a rota devolve a base da barbearia.
    const token = await abrirBarbearia();
    await marcarPeloBalcao(token);

    for (const q of ['%%%', '\u{FF05}\u{FF05}\u{FF05}', '\u{FF3F}\u{FF3F}\u{FF3F}']) {
      const resposta = await comAuth(token)(
        http().get('/v1/admin/customers').query({ q }),
      ).expect(200);
      expect(resposta.body.customers, `busca por ${JSON.stringify(q)}`).toEqual([]);
    }
  });

  // -- isolamento ------------------------------------------------------------

  it('o balcão de uma barbearia não vê nem move o dia da outra', async () => {
    const domari = await abrirBarbearia();
    const { id } = await marcarPeloBalcao(domari);
    const rival = await abrirBarbearia(RIVAL);

    const dia = await comAuth(rival)(http().get('/v1/admin/day')).expect(200);
    expect(dia.body.entries).toEqual([]);

    // Nem com o id em mãos: o tenant vem do token, e a RLS não enxerga a linha.
    await comAuth(rival)(
      http().post(`/v1/admin/appointments/${id}/attendance`).send({ action: 'check_in' }),
    ).expect(404);

    const busca = await comAuth(rival)(
      http().get('/v1/admin/customers').query({ q: 'silva' }),
    ).expect(200);
    expect(busca.body.customers).toEqual([]);
  });
});
