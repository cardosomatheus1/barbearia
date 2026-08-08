import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BoardController } from '../src/admin/board.controller.js';
import { MeController, TeamController } from '../src/admin/team.controller.js';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';

/**
 * RBAC pela HTTP.
 *
 * A pergunta central: a recepcionista consegue tocar no que não é dela? Até o
 * bloco 11 a resposta era sim para tudo — havia uma conta só, a do dono, e era
 * ela que ficava aberta no balcão.
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

describeIfDb('equipe e permissões pela HTTP', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [
        StaffAuthController,
        OnboardingController,
        BoardController,
        TeamController,
        MeController,
      ],
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
    for (const slug of ['domari-barber-club', 'rival-barbearia']) tenants.forget(slug);
  });

  const http = () => request(app.getHttpServer());
  const com = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  async function entrarComoDono(): Promise<string> {
    await http().post('/v1/admin/signup').send(DONO).expect(202);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email: DONO.email, password: DONO.password })
      .expect(201);
    return entrou.body.token;
  }

  /** Cria a recepcionista, troca a senha inicial e devolve a sessão dela. */
  async function recepcionista(dono: string, email = 'maria@domari.com.br') {
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

    return { token: entrou.body.token as string, id: criada.body.member.id as string, senhaInicial };
  }

  // -- o que a recepcionista pode ------------------------------------------

  it('a recepcionista opera o balcão', async () => {
    const dono = await entrarComoDono();
    const maria = await recepcionista(dono);

    await com(maria.token)(http().get('/v1/admin/day')).expect(200);
    await com(maria.token)(http().get('/v1/admin/customers').query({ q: 'silva' })).expect(200);
    await com(maria.token)(http().get('/v1/admin/state')).expect(200);
  });

  it('a recepcionista não administra a equipe nem a configuração', async () => {
    // O incidente que este bloco existe para impedir: abrir o balcão para ela
    // entregava junto o catálogo, o preço e a base de clientes.
    const dono = await entrarComoDono();
    const maria = await recepcionista(dono);

    const equipe = await com(maria.token)(http().get('/v1/admin/team')).expect(403);
    expect(equipe.body.error.code).toBe('forbidden');

    await com(maria.token)(
      http().put('/v1/admin/business').send({ name: 'Renomeada por engano' }),
    ).expect(403);

    await com(maria.token)(
      http().put('/v1/admin/change-window').send({
        cancelMinHours: 0,
        rescheduleMinHours: 0,
        maxReschedules: 50,
      }),
    ).expect(403);

    await com(maria.token)(
      http().post('/v1/admin/team').send({
        name: 'Cúmplice',
        email: 'complice@domari.com.br',
        role: 'manager',
      }),
    ).expect(403);
  });

  it('recusa é 403 com mensagem, não 500 nem 404', async () => {
    // Quem opera precisa entender que é acesso, não defeito — senão liga para o
    // dono pedindo a senha dele, que é como o RBAC morre na prática.
    const dono = await entrarComoDono();
    const maria = await recepcionista(dono);

    const resposta = await com(maria.token)(http().get('/v1/admin/team')).expect(403);
    expect(resposta.body.error.message).toMatch(/acesso/i);
  });

  // -- primeiro acesso -------------------------------------------------------

  it('a conta nova não faz nada até trocar a senha de primeiro acesso', async () => {
    const dono = await entrarComoDono();
    const criada = await com(dono)(
      http()
        .post('/v1/admin/team')
        .send({ name: 'João Barbeiro', email: 'joao@domari.com.br', role: 'professional' }),
    ).expect(201);

    const primeira = await http()
      .post('/v1/admin/login')
      .send({ email: 'joao@domari.com.br', password: criada.body.senhaInicial })
      .expect(201);
    const token: string = primeira.body.token;

    // A senha foi escolhida pelo sistema e entregue por outra pessoa: enquanto
    // valer, quem a sabe não é necessariamente quem deveria estar ali.
    const bloqueado = await com(token)(http().get('/v1/admin/day')).expect(403);
    expect(bloqueado.body.error.code).toBe('must_change_password');

    // Mas chega à rota que destranca.
    const eu = await com(token)(http().get('/v1/admin/me')).expect(200);
    expect(eu.body.mustChangePassword).toBe(true);

    await com(token)(
      http().put('/v1/admin/me/password').send({
        currentPassword: criada.body.senhaInicial,
        newPassword: 'a-senha-que-ele-escolheu',
      }),
    ).expect(200);

    await com(token)(http().get('/v1/admin/day')).expect(200);
  });

  it('a senha inicial aparece uma vez e nunca mais', async () => {
    const dono = await entrarComoDono();
    const criada = await com(dono)(
      http()
        .post('/v1/admin/team')
        .send({ name: 'Maria Recepção', email: 'maria@domari.com.br', role: 'receptionist' }),
    ).expect(201);
    expect(criada.body.senhaInicial).toBeTruthy();

    const lista = await com(dono)(http().get('/v1/admin/team')).expect(200);
    expect(JSON.stringify(lista.body)).not.toContain(criada.body.senhaInicial);
    // E nenhum hash de senha vaza na listagem.
    expect(JSON.stringify(lista.body)).not.toContain('scrypt$');
  });

  // -- o dono é protegido ----------------------------------------------------

  it('não dá para criar um segundo dono pela API', async () => {
    const dono = await entrarComoDono();
    // `owner` está fora do enum do schema: a recusa vem na borda, antes do
    // domínio, e é 400 e não 409.
    await com(dono)(
      http()
        .post('/v1/admin/team')
        .send({ name: 'Sócio', email: 'socio@domari.com.br', role: 'owner' }),
    ).expect(400);
  });

  // -- desligar --------------------------------------------------------------

  it('desligar derruba a sessão aberta no mesmo instante', async () => {
    const dono = await entrarComoDono();
    const maria = await recepcionista(dono);
    await com(maria.token)(http().get('/v1/admin/day')).expect(200);

    await com(dono)(http().put(`/v1/admin/team/${maria.id}/active`).send({ active: false })).expect(
      200,
    );

    // Não fica esperando o token expirar: quem foi desligado sai agora.
    await com(maria.token)(http().get('/v1/admin/day')).expect(401);
  });

  it('promover muda o que a pessoa alcança, sem novo login', async () => {
    const dono = await entrarComoDono();
    const maria = await recepcionista(dono);
    await com(maria.token)(http().get('/v1/admin/templates')).expect(403);

    await com(dono)(
      http().put(`/v1/admin/team/${maria.id}/role`).send({ role: 'manager' }),
    ).expect(200);

    // A sessão resolve o papel a cada requisição, então não carrega a foto
    // antiga das permissões.
    await com(maria.token)(http().get('/v1/admin/templates')).expect(200);
    // E gerente continua sem administrar equipe.
    await com(maria.token)(http().get('/v1/admin/team')).expect(403);
  });

  // -- isolamento ------------------------------------------------------------

  it('o dono de uma barbearia não mexe na equipe da outra', async () => {
    const dono = await entrarComoDono();
    const maria = await recepcionista(dono);

    await http()
      .post('/v1/admin/signup')
      .send({ ...DONO, email: 'rival@rival.com.br', businessName: 'Rival Barbearia' })
      .expect(202);
    const rival = await http()
      .post('/v1/admin/login')
      .send({ email: 'rival@rival.com.br', password: DONO.password })
      .expect(201);

    const equipe = await com(rival.body.token)(http().get('/v1/admin/team')).expect(200);
    expect(equipe.body.members).toHaveLength(1);

    // Com o id em mãos e `team.manage` na própria barbearia: a RLS não enxerga.
    await com(rival.body.token)(
      http().put(`/v1/admin/team/${maria.id}/active`).send({ active: false }),
    ).expect(404);
  });
});
