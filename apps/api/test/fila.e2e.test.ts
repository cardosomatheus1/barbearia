import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FilaController } from '../src/admin/fila.controller.js';
import { FilaPublicaController } from '../src/booking/fila-publica.controller.js';
import { BoardController } from '../src/admin/board.controller.js';
import { MeController, TeamController } from '../src/admin/team.controller.js';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { ConsoleMessagingProvider } from '@barbearia/identity';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';

/**
 * A fila presencial pela HTTP.
 *
 * Três perguntas: o link do celular vaza a fila da casa? Um token de outra
 * barbearia atravessa? E quem só tem `appointments.view` consegue mexer na fila
 * em vez de só olhá-la?
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

const JORNADA = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 0,
  endMinute: 1439,
}));

describeIfDb('fila presencial pela HTTP', () => {
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
        FilaController,
        FilaPublicaController,
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
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE staff_directory CASCADE');
    for (const slug of ['domari-barber-club', 'rival-barbearia']) tenants.forget(slug);
  });

  const http = () => request(app.getHttpServer());
  const com = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

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
        .send({
          professionals: [
            { name: 'Ruan Nascimento', schedule: JORNADA },
            { name: 'Gleidson Alves', schedule: JORNADA },
          ],
        }),
    ).expect(200);

    await com(token)(http().post('/v1/admin/publish')).expect(201);
    return token;
  }

  async function catalogo(token: string) {
    const resposta = await com(token)(http().get('/v1/admin/catalog')).expect(200);
    return {
      serviceId: resposta.body.services[0].id as string,
      professionalId: resposta.body.professionals[0].id as string,
    };
  }

  async function entrarNaFila(
    token: string,
    cliente = { name: 'João da Silva', phone: '(71) 98888-1234' },
    professionalId?: string,
  ) {
    const { serviceId } = await catalogo(token);
    const criada = await com(token)(
      http()
        .post('/v1/admin/queue')
        .send({ ...cliente, serviceIds: [serviceId], ...(professionalId ? { professionalId } : {}) }),
    ).expect(201);
    return { ...criada.body, serviceId } as { id: string; token: string; serviceId: string };
  }

  // -- o essencial ------------------------------------------------------------

  it('põe alguém na fila e mostra a posição no balcão', async () => {
    const dono = await abrirBarbearia();
    await entrarNaFila(dono);

    const fila = await com(dono)(http().get('/v1/admin/queue')).expect(200);
    expect(fila.body.entries).toHaveLength(1);
    expect(fila.body.entries[0].posicao).toBe(1);
    expect(fila.body.totals.esperando).toBe(1);
    expect(fila.body.cadeiras.length).toBeGreaterThan(0);
  });

  it('a listagem do balcão não devolve o token de ninguém', async () => {
    // Devolvê-lo transformaria a tela do balcão numa lista de chaves para a
    // posição de cada cliente — e a tela fica virada para o salão.
    const dono = await abrirBarbearia();
    const entrada = await entrarNaFila(dono);

    const fila = await com(dono)(http().get('/v1/admin/queue')).expect(200);
    expect(JSON.stringify(fila.body)).not.toContain(entrada.token);
    expect(JSON.stringify(fila.body)).not.toContain('token');
  });

  it('não devolve o telefone completo de quem está na fila', async () => {
    const dono = await abrirBarbearia();
    await entrarNaFila(dono, { name: 'João da Silva', phone: '(71) 98888-1234' });

    const fila = await com(dono)(http().get('/v1/admin/queue')).expect(200);
    const corpo = JSON.stringify(fila.body);
    expect(corpo).not.toContain('988881234');
    expect(corpo).not.toContain('+5571988881234');
    expect(fila.body.entries[0].customerPhoneTail).toBe('1234');
  });

  it('duplo toque com a mesma chave não põe a pessoa duas vezes', async () => {
    const dono = await abrirBarbearia();
    const { serviceId } = await catalogo(dono);
    const cliente = { name: 'João da Silva', phone: '(71) 98888-1234' };

    const primeira = await com(dono)(
      http()
        .post('/v1/admin/queue')
        .set('idempotency-key', 'balcao-1')
        .send({ ...cliente, serviceIds: [serviceId] }),
    ).expect(201);

    const repetida = await com(dono)(
      http()
        .post('/v1/admin/queue')
        .set('idempotency-key', 'balcao-1')
        .send({ ...cliente, serviceIds: [serviceId] }),
    ).expect(201);

    expect(repetida.body.id).toBe(primeira.body.id);

    const fila = await com(dono)(http().get('/v1/admin/queue')).expect(200);
    expect(fila.body.entries).toHaveLength(1);
  });

  it('sem chave, a segunda tentativa da mesma pessoa é recusada com 409', async () => {
    const dono = await abrirBarbearia();
    const { serviceId } = await catalogo(dono);
    const cliente = { name: 'João da Silva', phone: '(71) 98888-1234' };

    await com(dono)(
      http().post('/v1/admin/queue').send({ ...cliente, serviceIds: [serviceId] }),
    ).expect(201);

    const segunda = await com(dono)(
      http().post('/v1/admin/queue').send({ ...cliente, serviceIds: [serviceId] }),
    ).expect(409);
    expect(segunda.body.error.code).toBe('already_in_queue');
  });

  it('o custo do encaixe vem por cadeira, com o nome de quem atende', async () => {
    const dono = await abrirBarbearia();
    const { serviceId } = await catalogo(dono);

    const custo = await com(dono)(
      http().get('/v1/admin/queue/fit').query({ serviceIds: serviceId }),
    ).expect(200);

    expect(custo.body.cadeiras.length).toBeGreaterThan(0);
    expect(custo.body.cadeiras[0]).toHaveProperty('cabe');
    expect(custo.body.cadeiras[0].professionalName).toBeTruthy();
  });

  it('sentar cria o atendimento e tira a pessoa da fila', async () => {
    const dono = await abrirBarbearia();
    const { professionalId } = await catalogo(dono);
    const entrada = await entrarNaFila(dono);

    const sentado = await com(dono)(
      http().post(`/v1/admin/queue/${entrada.id}/seat`).send({ professionalId }),
    ).expect(201);
    expect(sentado.body.appointmentId).toBeTruthy();

    const fila = await com(dono)(http().get('/v1/admin/queue')).expect(200);
    expect(fila.body.entries).toHaveLength(0);
    expect(fila.body.totals.atendendo).toBe(1);

    // E aparece no painel do dia, que é onde a recepção acompanha.
    const dia = await com(dono)(http().get('/v1/admin/day')).expect(200);
    expect(dia.body.entries.some((e: { status: string }) => e.status === 'in_progress')).toBe(true);
  });

  it('a segunda pessoa a tocar o mesmo botão recebe 409, não silêncio', async () => {
    const dono = await abrirBarbearia();
    const { professionalId } = await catalogo(dono);
    const entrada = await entrarNaFila(dono);

    await com(dono)(
      http().post(`/v1/admin/queue/${entrada.id}/seat`).send({ professionalId }),
    ).expect(201);

    const segunda = await com(dono)(
      http().post(`/v1/admin/queue/${entrada.id}/seat`).send({ professionalId }),
    ).expect(409);
    expect(segunda.body.error.code).toBe('transition_not_allowed');
  });

  it('recusa mover para um estado que a fila não tem', async () => {
    const dono = await abrirBarbearia();
    const entrada = await entrarNaFila(dono);

    await com(dono)(
      http().post(`/v1/admin/queue/${entrada.id}/move`).send({ para: 'in_service' }),
    ).expect(400);
  });

  // -- o link do celular ------------------------------------------------------

  it('o link mostra a posição de quem o tem, sem nome de mais ninguém', async () => {
    const dono = await abrirBarbearia();
    const joao = await entrarNaFila(dono, { name: 'João da Silva', phone: '(71) 98888-1234' });
    await entrarNaFila(dono, { name: 'Carlos Pereira', phone: '(71) 98888-5678' });

    const minha = await http()
      .get(`/v1/b/domari-barber-club/queue/${joao.token}`)
      .expect(200);

    expect(minha.body.nome).toBe('João da Silva');
    expect(JSON.stringify(minha.body)).not.toContain('Carlos');
    expect(minha.body).not.toHaveProperty('entries');
    // Nem o telefone de quem tem o link volta: ele já sabe o próprio número, e
    // o link pode acabar num grupo de família.
    expect(JSON.stringify(minha.body)).not.toContain('1234');
  });

  it('link inventado responde igual a link de outra barbearia', async () => {
    const dono = await abrirBarbearia();
    const entrada = await entrarNaFila(dono);
    await abrirBarbearia(RIVAL);

    const chute = await http()
      .get('/v1/b/domari-barber-club/queue/token-que-nao-existe-mas-tem-tamanho')
      .expect(404);

    // Mesmo token, barbearia errada: a resposta é idêntica. A diferença diria a
    // quem varre links que aquele existe em algum lugar.
    const cruzado = await http()
      .get(`/v1/b/rival-barbearia/queue/${entrada.token}`)
      .expect(404);

    expect(cruzado.body.error.code).toBe(chute.body.error.code);
  });

  it('token curto demais é recusado antes de tocar o banco', async () => {
    await abrirBarbearia();
    await http().get('/v1/b/domari-barber-club/queue/curto').expect(400);
  });

  // -- permissão --------------------------------------------------------------

  it('a fila exige sessão de equipe', async () => {
    await abrirBarbearia();
    await http().get('/v1/admin/queue').expect(401);
    await http().post('/v1/admin/queue').send({ serviceIds: [] }).expect(401);
  });

  /**
   * O barbeiro **pode** pôr alguém na fila, e isso não é descuido: quem
   * trabalha sozinho é a própria recepção, e `appointments.create` está no
   * papel dele por padrão. A pergunta que importa é outra — a permissão decide
   * alguma coisa? Aqui ela é retirada do papel, que é uma linha em
   * `role_permissions`, e o mesmo barbeiro passa a ser recusado.
   *
   * A primeira versão deste teste esperava 403 direto e recebeu 404: o
   * barbeiro passou pela guarda e esbarrou num serviço inexistente. O suspeito
   * era o código e era a expectativa.
   */
  it('tirar a permissão do papel recusa o mesmo barbeiro na requisição seguinte', async () => {
    const dono = await abrirBarbearia();
    const { serviceId } = await catalogo(dono);

    const email = 'barbeiro@domari.com.br';
    const criada = await com(dono)(
      http().post('/v1/admin/team').send({ name: 'Ruan', email, role: 'professional' }),
    ).expect(201);

    const senha: string = criada.body.senhaInicial;
    const primeira = await http()
      .post('/v1/admin/login')
      .send({ email, password: senha })
      .expect(201);
    await com(primeira.body.token)(
      http()
        .put('/v1/admin/me/password')
        .send({ currentPassword: senha, newPassword: 'a-senha-dele-agora' }),
    ).expect(200);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email, password: 'a-senha-dele-agora' })
      .expect(201);
    const barbeiro: string = entrou.body.token;

    const cliente = { name: 'Alguém da Porta', phone: '(71) 98888-9999' };
    await com(barbeiro)(
      http().post('/v1/admin/queue').send({ ...cliente, serviceIds: [serviceId] }),
    ).expect(201);

    await admin.$executeRawUnsafe(
      `DELETE FROM role_permissions WHERE role = 'professional' AND permission = 'appointments.create'`,
    );

    // Sem novo login: a permissão é resolvida a cada requisição.
    await com(barbeiro)(
      http()
        .post('/v1/admin/queue')
        .send({ name: 'Outro', phone: '(71) 98888-0000', serviceIds: [serviceId] }),
    ).expect(403);

    // E continua enxergando a fila, que é `appointments.view`.
    await com(barbeiro)(http().get('/v1/admin/queue')).expect(200);
  });

  // -- a parede entre barbearias ---------------------------------------------

  it('a fila de uma barbearia não é vista nem movida pela outra', async () => {
    const dono = await abrirBarbearia();
    const entrada = await entrarNaFila(dono);
    const rival = await abrirBarbearia(RIVAL);

    const filaDoRival = await com(rival)(http().get('/v1/admin/queue')).expect(200);
    expect(filaDoRival.body.entries).toEqual([]);

    await com(rival)(
      http().post(`/v1/admin/queue/${entrada.id}/move`).send({ para: 'gave_up' }),
    ).expect(404);

    // E a pessoa continua na fila da casa.
    const daCasa = await com(dono)(http().get('/v1/admin/queue')).expect(200);
    expect(daCasa.body.entries).toHaveLength(1);
  });
});
