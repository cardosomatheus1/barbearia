import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CatalogoController } from '../src/admin/catalogo.controller.js';
import { TeamController, MeController } from '../src/admin/team.controller.js';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { ConsoleMessagingProvider } from '@barbearia/identity';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';
import { limparBanco } from './limpar.js';

/**
 * O cadastro pela HTTP.
 *
 * Três perguntas: quem não tem `settings.manage` consegue mexer no catálogo da
 * casa? Um id de outra barbearia atravessa? E a borda recusa o que estragaria a
 * grade — duração de um minuto, jornada invertida, recurso inexistente?
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

let app: INestApplication;
let admin: PrismaClient;
let tenants: TenantService;

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const DONO = {
  name: 'Matheus Cardoso',
  email: 'dono@domari.com.br',
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

const JORNADA = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 540,
  endMinute: 1140,
}));

const SERVICO = {
  name: 'Corte na tesoura',
  categoryName: 'Cabelo',
  priceCents: 7500,
  durationMinutes: 45,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  bookableOnline: true,
};

describeIfDb('cadastro do admin pela HTTP', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [
        StaffAuthController,
        OnboardingController,
        CatalogoController,
        TeamController,
        MeController,
      ],
      providers: [
        TenantService,
        // O `TeamController` manda a senha de primeiro acesso; sem provedor o
        // Nest não monta o controller e a suíte inteira cai por injeção.
        { provide: MESSAGING_PROVIDER, useClass: ConsoleMessagingProvider },
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
    await limparBanco(admin, ['tenants', 'staff_directory']);
    for (const slug of ['domari-barber-club', 'rival-barbearia']) tenants.forget(slug);
  });

  const http = () => request(app.getHttpServer());
  const com = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  /** Barbearia publicada, com um serviço e um profissional do onboarding. */
  async function abrirBarbearia(conta = DONO): Promise<string> {
    await http().post('/v1/admin/signup').send(conta).expect(202);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email: conta.email, password: conta.password })
      .expect(201);
    const token: string = entrou.body.token;

    await com(token)(
      http()
        .put('/v1/admin/business')
        .send({ name: conta.businessName, city: 'Salvador', timezone: 'America/Bahia' }),
    ).expect(200);

    await com(token)(
      http()
        .put('/v1/admin/services')
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
        }),
    ).expect(200);

    await com(token)(
      http()
        .put('/v1/admin/professionals')
        .send({ professionals: [{ name: 'Ruan Nascimento', schedule: JORNADA }] }),
    ).expect(200);

    await com(token)(http().post('/v1/admin/publish')).expect(201);
    return token;
  }

  /** Recepcionista com senha já trocada — papel sem `settings.manage`. */
  async function recepcionista(dono: string) {
    const email = 'maria@domari.com.br';
    const criada = await com(dono)(
      http().post('/v1/admin/team').send({ name: 'Maria Recepção', email, role: 'receptionist' }),
    ).expect(201);

    const senhaInicial: string = criada.body.senhaInicial;
    const primeira = await http()
      .post('/v1/admin/login')
      .send({ email, password: senhaInicial })
      .expect(201);
    await com(primeira.body.token)(
      http()
        .put('/v1/admin/me/password')
        .send({ currentPassword: senhaInicial, newPassword: 'a-senha-dela-agora' }),
    ).expect(200);

    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email, password: 'a-senha-dela-agora' })
      .expect(201);
    return entrou.body.token as string;
  }

  // -- quem pode mexer --------------------------------------------------------

  it('sem sessão não se lê nem se escreve o catálogo', async () => {
    await http().get('/v1/admin/catalog/services').expect(401);
    await http().post('/v1/admin/catalog/services').send(SERVICO).expect(401);
    await http().put('/v1/admin/catalog/resources').send({ pools: [] }).expect(401);
  });

  it('a recepcionista não mexe no cadastro da casa', async () => {
    const dono = await abrirBarbearia();
    const maria = await recepcionista(dono);

    await com(maria)(http().get('/v1/admin/catalog/services')).expect(403);
    await com(maria)(http().post('/v1/admin/catalog/services').send(SERVICO)).expect(403);
    await com(maria)(http().get('/v1/admin/catalog/professionals')).expect(403);
    await com(maria)(
      http().put('/v1/admin/catalog/resources').send({ pools: [{ resourceType: 'cadeira', capacity: 2 }] }),
    ).expect(403);
  });

  // -- serviços ---------------------------------------------------------------

  it('cria, edita no lugar e desativa sem apagar', async () => {
    const dono = await abrirBarbearia();

    const criado = await com(dono)(
      http().post('/v1/admin/catalog/services').send(SERVICO),
    ).expect(201);
    const id: string = criado.body.id;

    await com(dono)(
      http()
        .put(`/v1/admin/catalog/services/${id}`)
        .send({ ...SERVICO, priceCents: 8500, name: 'Corte na tesoura premium' }),
    ).expect(200);

    const lista = await com(dono)(http().get('/v1/admin/catalog/services')).expect(200);
    const servico = lista.body.services.find((s: { id: string }) => s.id === id);
    expect(servico.priceCents).toBe(8500);
    expect(servico.name).toBe('Corte na tesoura premium');

    const desativado = await com(dono)(
      http().put(`/v1/admin/catalog/services/${id}/active`).send({ active: false }),
    ).expect(200);
    expect(desativado.body.futureAppointments).toBe(0);

    const depois = await com(dono)(http().get('/v1/admin/catalog/services')).expect(200);
    // Continua na lista: desativar tira da grade, não do banco.
    expect(depois.body.services.some((s: { id: string }) => s.id === id)).toBe(true);
  });

  it('a borda recusa o que estragaria a grade antes de tocar no banco', async () => {
    const dono = await abrirBarbearia();

    // Um minuto de duração vira centenas de horários por dia na página pública.
    await com(dono)(
      http().post('/v1/admin/catalog/services').send({ ...SERVICO, durationMinutes: 1 }),
    ).expect(400);

    await com(dono)(
      http().post('/v1/admin/catalog/services').send({ ...SERVICO, priceCents: -100 }),
    ).expect(400);

    // Centavos são inteiros: R$ 49,90 é 4990, não 49.9.
    await com(dono)(
      http().post('/v1/admin/catalog/services').send({ ...SERVICO, priceCents: 49.9 }),
    ).expect(400);
  });

  it('combo mais curto que as partes volta com o que corrigir, não com "dados inválidos"', async () => {
    const dono = await abrirBarbearia();
    const lista = await com(dono)(http().get('/v1/admin/catalog/services')).expect(200);
    const corte: string = lista.body.services[0].id;

    const barba = await com(dono)(
      http()
        .post('/v1/admin/catalog/services')
        .send({ ...SERVICO, name: 'Barba', durationMinutes: 30, bufferAfterMinutes: 0 }),
    ).expect(201);

    const recusa = await com(dono)(
      http().post('/v1/admin/catalog/services').send({
        ...SERVICO,
        name: 'Corte + barba',
        durationMinutes: 40,
        bufferAfterMinutes: 0,
        componentIds: [corte, barba.body.id],
      }),
    ).expect(422);

    expect(recusa.body.error.code).toBe('invalid_catalog');
    // Sem o detalhe, a tela só consegue dizer "não deu" e o dono não sabe que
    // faltam vinte minutos.
    expect(recusa.body.error.detail).toBeDefined();
  });

  // -- jornada ----------------------------------------------------------------

  it('jornada invertida não passa da borda', async () => {
    const dono = await abrirBarbearia();
    const lista = await com(dono)(http().get('/v1/admin/catalog/professionals')).expect(200);
    const id: string = lista.body.professionals[0].id;

    await com(dono)(
      http()
        .put(`/v1/admin/catalog/professionals/${id}/schedule`)
        .send({ faixas: [{ weekday: 1, startMinute: 1140, endMinute: 540, breaks: [] }] }),
    ).expect(400);
  });

  it('intervalo fora da jornada do dia não passa da borda', async () => {
    const dono = await abrirBarbearia();
    const lista = await com(dono)(http().get('/v1/admin/catalog/professionals')).expect(200);
    const id: string = lista.body.professionals[0].id;

    await com(dono)(
      http()
        .put(`/v1/admin/catalog/professionals/${id}/schedule`)
        .send({
          faixas: [
            { weekday: 1, startMinute: 540, endMinute: 720, breaks: [{ start: 800, end: 860 }] },
          ],
        }),
    ).expect(400);
  });

  it('grava a jornada e devolve o que foi gravado', async () => {
    const dono = await abrirBarbearia();
    const lista = await com(dono)(http().get('/v1/admin/catalog/professionals')).expect(200);
    const id: string = lista.body.professionals[0].id;

    const gravou = await com(dono)(
      http()
        .put(`/v1/admin/catalog/professionals/${id}/schedule`)
        .send({
          faixas: [
            { weekday: 2, startMinute: 540, endMinute: 1080, breaks: [{ start: 720, end: 780 }] },
          ],
        }),
    ).expect(200);
    expect(gravou.body.saved).toBe(true);

    const depois = await com(dono)(
      http().get(`/v1/admin/catalog/professionals/${id}/schedule`),
    ).expect(200);
    expect(depois.body.faixas).toHaveLength(1);
    expect(depois.body.faixas[0]).toMatchObject({ weekday: 2, startMinute: 540, endMinute: 1080 });
    expect(depois.body.faixas[0].breaks).toEqual([{ start: 720, end: 780 }]);
  });

  // -- recursos ---------------------------------------------------------------

  it('cadastra recurso e recusa exigir o que não existe', async () => {
    const dono = await abrirBarbearia();
    const lista = await com(dono)(http().get('/v1/admin/catalog/services')).expect(200);
    const servico: string = lista.body.services[0].id;

    await com(dono)(
      http().put('/v1/admin/catalog/resources').send({
        pools: [
          { resourceType: 'cadeira', capacity: 3 },
          { resourceType: 'lavatório', capacity: 1 },
        ],
      }),
    ).expect(200);

    await com(dono)(
      http()
        .put(`/v1/admin/catalog/services/${servico}/resources`)
        .send({ requirements: [{ resourceType: 'lavatório', quantity: 1 }] }),
    ).expect(200);

    const recusa = await com(dono)(
      http()
        .put(`/v1/admin/catalog/services/${servico}/resources`)
        .send({ requirements: [{ resourceType: 'helicóptero', quantity: 1 }] }),
    ).expect(422);
    expect(recusa.body.error.code).toBe('invalid_catalog');

    const recursos = await com(dono)(http().get('/v1/admin/catalog/resources')).expect(200);
    const lavatorio = recursos.body.resources.find(
      (r: { resourceType: string }) => r.resourceType === 'lavatório',
    );
    expect(lavatorio.usedBy).toHaveLength(1);
  });

  // -- a parede entre barbearias ---------------------------------------------

  it('id de outra barbearia não atravessa, nem para ler nem para escrever', async () => {
    const dono = await abrirBarbearia();
    const rival = await abrirBarbearia(RIVAL);

    const servicos = await com(rival)(http().get('/v1/admin/catalog/services')).expect(200);
    const servicoDoRival: string = servicos.body.services[0].id;
    const profissionais = await com(rival)(
      http().get('/v1/admin/catalog/professionals'),
    ).expect(200);
    const profissionalDoRival: string = profissionais.body.professionals[0].id;

    await com(dono)(
      http().put(`/v1/admin/catalog/services/${servicoDoRival}`).send(SERVICO),
    ).expect(404);
    await com(dono)(
      http().put(`/v1/admin/catalog/services/${servicoDoRival}/active`).send({ active: false }),
    ).expect(404);
    await com(dono)(
      http().put(`/v1/admin/catalog/professionals/${profissionalDoRival}`).send({
        name: 'Sequestrado',
        kind: 'professional',
        bookableOnline: true,
      }),
    ).expect(404);
    await com(dono)(
      http()
        .put(`/v1/admin/catalog/professionals/${profissionalDoRival}/schedule`)
        .send({ faixas: [] }),
    ).expect(404);

    // E o cadastro do rival continua intacto.
    const depois = await com(rival)(http().get('/v1/admin/catalog/services')).expect(200);
    expect(depois.body.services[0].id).toBe(servicoDoRival);
    expect(depois.body.services[0].active).toBe(true);
  });
});
