import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeMessagingProvider } from '@barbearia/identity';
import { BookingController } from '../src/booking/booking.controller.js';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { ChavesController } from '../src/admin/chaves.controller.js';
import { PublicaController } from '../src/publica/publica.controller.js';
import { ChaveGuard } from '../src/publica/chave.guard.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';
import { limparBanco } from './limpar.js';

/**
 * A API pública pela HTTP (bloco 78, SPEC §5.6).
 *
 * O que só se prova aqui: que a chave abre **a porta certa e nada além**. Um
 * teste de unidade sobre `autenticarChave` prova que o segredo confere; ele não
 * prova que a rota recusa o escopo que a chave não tem, nem que a grade que a
 * integração recebe é a mesma que a página pública mostraria.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

let app: INestApplication;
let admin: PrismaClient;
let tenants: TenantService;

const DONO = {
  name: 'Matheus Cardoso',
  email: 'dono@domari.com.br',
  password: 'senha-bem-comprida',
  phone: '(71) 98888-7777',
  businessName: 'Domari Barber Club',
};

const SLUG = 'domari-barber-club';

const JORNADA = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 480,
  endMinute: 1320,
}));

describeIfDb('a API pública pela HTTP', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    process.env['MFA_SECRET_KEY'] = Buffer.alloc(32, 9).toString('base64');
    process.env['API_KEY_PEPPER'] = 'pepper-da-api-0123456789';
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [
        StaffAuthController,
        OnboardingController,
        BookingController,
        ChavesController,
        PublicaController,
      ],
      providers: [
        TenantService,
        { provide: MESSAGING_PROVIDER, useValue: new FakeMessagingProvider() },
        StaffGuard,
        PermissaoGuard,
        ChaveGuard,
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
    await limparBanco(admin, ['tenants', 'staff_directory']);
    tenants.forget(SLUG);
  });

  const http = () => request(app.getHttpServer());
  const com = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  async function abrirBarbearia(): Promise<string> {
    await http().post('/v1/admin/signup').send(DONO).expect(202);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email: DONO.email, password: DONO.password })
      .expect(201);
    const token: string = entrou.body.token;

    await com(token)(
      http()
        .put('/v1/admin/business')
        .send({ name: DONO.businessName, city: 'Salvador', timezone: 'America/Bahia' }),
    ).expect(200);

    await com(token)(
      http().put('/v1/admin/services').send({
        services: [
          {
            key: 'corte',
            name: 'Corte',
            category: 'Cabelo',
            durationMinutes: 30,
            bufferAfterMinutes: 0,
            priceCents: 5000,
          },
        ],
      }),
    ).expect(200);

    await com(token)(
      http().put('/v1/admin/professionals').send({ professionals: [{ name: 'João', schedule: JORNADA }] }),
    ).expect(200);

    await com(token)(http().post('/v1/admin/publish').send({})).expect(201);
    return token;
  }

  const emitir = async (token: string, escopos: readonly string[]): Promise<string> => {
    const r = await com(token)(
      http().post('/v1/admin/chaves').send({ nome: 'Integração', escopos }),
    ).expect(201);
    return r.body.chave;
  };

  const comChave = (chave: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${chave}`);

  it('sem chave, com chave errada e com chave revogada a porta não abre', async () => {
    const token = await abrirBarbearia();
    const chave = await emitir(token, ['appointments.view']);

    await http().get('/v1/publica/servicos').expect(401);
    await comChave('bd_000000000000.qualquercoisadotamanhocerto123456')(
      http().get('/v1/publica/servicos'),
    ).expect(401);
    await comChave('lixo')(http().get('/v1/publica/servicos')).expect(401);

    // A boa abre.
    await comChave(chave)(http().get('/v1/publica/servicos')).expect(200);

    const [linha] = await admin.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM api_keys`);
    await com(token)(
      http().post(`/v1/admin/chaves/${linha?.id}/revogacao`).send({ motivo: 'desligada' }),
    ).expect(201);

    const depois = await comChave(chave)(http().get('/v1/publica/servicos')).expect(401);
    expect(depois.body.error.code).toBe('chave_revogada');
  });

  it('a chave não alcança o que o escopo dela não cobre', async () => {
    /**
     * O escopo é uma permissão do mesmo catálogo do painel. Uma chave de
     * leitura não marca horário — e a recusa é 403, não 401: ela se
     * identificou, e o que faltou foi permissão.
     */
    const token = await abrirBarbearia();
    const soLeitura = await emitir(token, ['appointments.view']);

    const negado = await comChave(soLeitura)(
      http()
        .post('/v1/publica/agendamentos')
        .set('Idempotency-Key', 'k1')
        .send({
          locationId: '00000000-0000-0000-0000-000000000000',
          serviceIds: ['00000000-0000-0000-0000-000000000000'],
          professionalId: '00000000-0000-0000-0000-000000000000',
          date: '2026-12-01',
          start: '10:00',
          telefone: '+5571988887777',
          nome: 'Carlos',
        }),
    ).expect(403);
    expect(negado.body.error.code).toBe('escopo_insuficiente');
  });

  it('dinheiro não vira escopo, nem pela rota que emite a chave', async () => {
    // A borda recusa antes do domínio, e o domínio antes do banco. As três.
    const token = await abrirBarbearia();
    const r = await com(token)(
      http().post('/v1/admin/chaves').send({ nome: 'Ampla', escopos: ['finance.view'] }),
    ).expect(403);
    expect(r.body.error.code).toBe('escopo_de_dinheiro');
  });

  it('a grade que a integração recebe é a mesma da página pública', async () => {
    /**
     * A regra que a SPEC escreve em letras: uma segunda noção de "horário
     * livre" é a agenda vendida duas vezes. O motor é o mesmo, e a prova é a
     * lista bater.
     */
    const token = await abrirBarbearia();
    const chave = await emitir(token, ['appointments.view']);

    const casa = await comChave(chave)(http().get('/v1/publica/barbearia')).expect(200);
    const local = casa.body.unidades[0].id;
    const servicos = await comChave(chave)(http().get('/v1/publica/servicos')).expect(200);
    const servico = servicos.body.servicos[0].id;

    const amanha = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const daApi = await comChave(chave)(
      http().get(
        `/v1/publica/disponibilidade?locationId=${local}&serviceIds=${servico}&de=${amanha}`,
      ),
    ).expect(200);

    const daPagina = await http()
      .get(`/v1/b/${SLUG}/availability?locationId=${local}&serviceIds=${servico}&dateFrom=${amanha}`)
      .expect(200);

    const horarios = (dia: { slots?: { start: string }[] }) =>
      (dia.slots ?? []).map((s) => s.start);

    expect(horarios(daApi.body.dias[0])).toEqual(horarios(daPagina.body.days[0]));
    expect(horarios(daApi.body.dias[0]).length).toBeGreaterThan(0);
  });

  it('o agendamento pela API exige Idempotency-Key, e a repetição não cria o segundo', async () => {
    /**
     * Obrigatória aqui, e não opcional como na porta do cliente: ali quem
     * repete é um dedo no botão; aqui é um laço de integração com retentativa,
     * e a segunda chamada sem chave cria o segundo horário.
     */
    const token = await abrirBarbearia();
    const chave = await emitir(token, ['appointments.view', 'appointments.create']);

    const casa = await comChave(chave)(http().get('/v1/publica/barbearia')).expect(200);
    const local = casa.body.unidades[0].id;
    const profissional = casa.body.profissionais[0].id;
    const servicos = await comChave(chave)(http().get('/v1/publica/servicos')).expect(200);
    const servico = servicos.body.servicos[0].id;

    const amanha = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const grade = await comChave(chave)(
      http().get(
        `/v1/publica/disponibilidade?locationId=${local}&serviceIds=${servico}&de=${amanha}`,
      ),
    ).expect(200);
    const horario: string = grade.body.dias[0].slots[0].start;

    const corpo = {
      locationId: local,
      serviceIds: [servico],
      professionalId: profissional,
      date: amanha,
      start: horario,
      telefone: '+5571988887777',
      nome: 'Carlos Souza',
    };

    const semChave = await comChave(chave)(
      http().post('/v1/publica/agendamentos').send(corpo),
    ).expect(400);
    expect(semChave.body.error.code).toBe('idempotency_key_obrigatoria');

    const primeiro = await comChave(chave)(
      http().post('/v1/publica/agendamentos').set('Idempotency-Key', 'integracao-1').send(corpo),
    ).expect(201);

    const repetido = await comChave(chave)(
      http().post('/v1/publica/agendamentos').set('Idempotency-Key', 'integracao-1').send(corpo),
    ).expect(201);

    expect(repetido.body.id).toBe(primeiro.body.id);

    const [contagem] = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM appointments WHERE source = 'api'`,
    );
    expect(Number(contagem?.n)).toBe(1);
  });

  it('conta bloqueada não opera pela integração, e a chave para junto', async () => {
    /**
     * O `StaffGuard` confere o bloqueio a cada requisição, e a página pública
     * some porque `TenantService.resolve` devolve nulo. Esta porta descobre o
     * tenant pela **chave** e não passava por nenhum dos dois: a barbearia
     * bloqueada continuaria vendendo agenda pela integração — e revogar a chave
     * exige o painel, que o bloqueio trancou.
     */
    const token = await abrirBarbearia();
    const chave = await emitir(token, ['appointments.view']);
    await comChave(chave)(http().get('/v1/publica/servicos')).expect(200);

    await admin.$executeRawUnsafe(
      `UPDATE tenant_platform SET blocked_at = now(), blocked_reason = 'inadimplente'`,
    );
    const [casa] = await admin.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM tenants`);
    tenants.forget(SLUG);
    tenants.esquecerBloqueio(casa?.id ?? '');

    const negado = await comChave(chave)(http().get('/v1/publica/servicos')).expect(403);
    expect(negado.body.error.code).toBe('conta_bloqueada');
  });

  it('a chave de uma barbearia não alcança a agenda da outra', async () => {
    /**
     * O `locationId` vem do corpo, e a checagem de integridade referencial do
     * Postgres ignora row security. Quem separa é a RLS da consulta que roda
     * `withTenant` com o tenant **da chave** — nunca um id do pedido.
     */
    const token = await abrirBarbearia();
    const chave = await emitir(token, ['appointments.view']);

    const [vizinha] = await admin.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO tenants (name) VALUES ('Casa Vizinha') RETURNING id`,
    );
    const [local] = await admin.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO locations (tenant_id, name, timezone)
       VALUES ('${vizinha?.id}', 'Matriz', 'America/Bahia') RETURNING id`,
    );

    const amanha = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const r = await comChave(chave)(
      http().get(
        `/v1/publica/disponibilidade?locationId=${local?.id}` +
          `&serviceIds=00000000-0000-0000-0000-000000000000&de=${amanha}`,
      ),
    ).expect(200);

    // Unidade de outra barbearia é unidade desconhecida: grade vazia, e não a
    // agenda da vizinha.
    expect(r.body.dias[0].slots ?? []).toEqual([]);
  });
});
