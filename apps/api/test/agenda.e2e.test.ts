import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgendaController } from '../src/admin/agenda.controller.js';
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
import { limparBanco } from './limpar.js';

/**
 * A agenda do admin pela HTTP.
 *
 * Três perguntas: bloquear é operação de recepção ou de dono? Um id de outra
 * barbearia atravessa? E mover um agendamento respeita o motor, ou o admin
 * consegue empilhar dois clientes na mesma cadeira?
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
  startMinute: 480,
  endMinute: 1320,
}));

describeIfDb('agenda do admin pela HTTP', () => {
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
        AgendaController,
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
      http().put('/v1/admin/services').send({
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
      outroProfissional: resposta.body.professionals[1]?.id as string | undefined,
    };
  }

  function maisDias(data: string, dias: number): string {
    const d = new Date(`${data}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
  }

  async function hoje(token: string): Promise<string> {
    const dia = await com(token)(http().get('/v1/admin/day')).expect(200);
    return dia.body.today as string;
  }

  /** Marca alguém pelo balcão, no primeiro horário livre de amanhã. */
  async function marcar(token: string) {
    const { serviceId, professionalId } = await catalogo(token);
    const amanha = maisDias(await hoje(token), 1);

    const grade = await com(token)(
      http().get('/v1/admin/availability').query({
        serviceIds: serviceId,
        professionalId,
        dateFrom: amanha,
        dateTo: amanha,
      }),
    ).expect(200);

    const livre = grade.body.days[0]?.slots?.[0];
    expect(livre, 'sem horário livre amanhã').toBeDefined();

    const criado = await com(token)(
      http().post('/v1/admin/appointments').send({
        name: 'João da Silva',
        phone: '(71) 98888-1234',
        professionalId,
        serviceIds: [serviceId],
        date: amanha,
        start: livre.start,
      }),
    ).expect(201);

    return { id: criado.body.id as string, date: amanha, start: livre.start as string, professionalId };
  }

  // -- a agenda ---------------------------------------------------------------

  it('devolve o dia pedido com os agendamentos e os profissionais', async () => {
    const dono = await abrirBarbearia();
    const marcado = await marcar(dono);

    const agenda = await com(dono)(
      http().get('/v1/admin/agenda').query({ from: marcado.date }),
    ).expect(200);

    expect(agenda.body.days).toHaveLength(1);
    expect(agenda.body.days[0].entries).toHaveLength(1);
    expect(agenda.body.days[0].entries[0].customerName).toBe('João da Silva');
    expect(agenda.body.professionals.length).toBe(2);
  });

  it('a semana são sete dias na mesma consulta', async () => {
    const dono = await abrirBarbearia();
    const inicio = await hoje(dono);

    const agenda = await com(dono)(
      http().get('/v1/admin/agenda').query({ from: inicio, to: maisDias(inicio, 6) }),
    ).expect(200);

    expect(agenda.body.days).toHaveLength(7);
  });

  it('recusa intervalo absurdo em vez de varrer a base', async () => {
    const dono = await abrirBarbearia();
    await com(dono)(
      http().get('/v1/admin/agenda').query({ from: '2026-01-01', to: '2026-12-31' }),
    ).expect(400);
  });

  it('não devolve o telefone de ninguém', async () => {
    const dono = await abrirBarbearia();
    const marcado = await marcar(dono);

    const agenda = await com(dono)(
      http().get('/v1/admin/agenda').query({ from: marcado.date }),
    ).expect(200);

    expect(JSON.stringify(agenda.body)).not.toContain('988881234');
  });

  // -- bloquear ---------------------------------------------------------------

  it('a recepção bloqueia uma hora; o feriado é do dono', async () => {
    const dono = await abrirBarbearia();
    const amanha = maisDias(await hoje(dono), 1);

    const email = 'maria@domari.com.br';
    const criada = await com(dono)(
      http().post('/v1/admin/team').send({ name: 'Maria', email, role: 'receptionist' }),
    ).expect(201);
    const senha: string = criada.body.senhaInicial;
    const primeira = await http().post('/v1/admin/login').send({ email, password: senha }).expect(201);
    await com(primeira.body.token)(
      http().put('/v1/admin/me/password').send({ currentPassword: senha, newPassword: 'senha-nova-dela' }),
    ).expect(200);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email, password: 'senha-nova-dela' })
      .expect(201);
    const maria: string = entrou.body.token;

    // Bloquear uma hora é trabalho de recepção, feito dez vezes por semana.
    await com(maria)(
      http().post('/v1/admin/agenda/blocks').send({
        kind: 'block',
        date: amanha,
        startMinute: 840,
        endMinute: 900,
        reason: 'Dentista',
      }),
    ).expect(201);

    // Fechar a barbearia no feriado não é.
    await com(maria)(
      http().post('/v1/admin/agenda/exceptions').send({ kind: 'holiday', date: amanha }),
    ).expect(403);

    await com(dono)(
      http().post('/v1/admin/agenda/exceptions').send({ kind: 'holiday', date: amanha }),
    ).expect(201);
  });

  /**
   * A assimetria era a escalada.
   *
   * A recepcionista não cria feriado — mas apagava o que o dono criou, e com
   * isso reabria a barbearia no dia em que ela deveria estar fechada, sem
   * nenhuma permissão a mais. Criar e apagar precisam exigir o mesmo.
   */
  it('quem só cria bloqueio não apaga o feriado do dono', async () => {
    const dono = await abrirBarbearia();
    const amanha = maisDias(await hoje(dono), 1);

    const feriado = await com(dono)(
      http().post('/v1/admin/agenda/exceptions').send({ kind: 'holiday', date: amanha }),
    ).expect(201);

    const email = 'maria@domari.com.br';
    const criada = await com(dono)(
      http().post('/v1/admin/team').send({ name: 'Maria', email, role: 'receptionist' }),
    ).expect(201);
    const senha: string = criada.body.senhaInicial;
    const primeira = await http().post('/v1/admin/login').send({ email, password: senha }).expect(201);
    await com(primeira.body.token)(
      http().put('/v1/admin/me/password').send({ currentPassword: senha, newPassword: 'senha-nova-dela' }),
    ).expect(200);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email, password: 'senha-nova-dela' })
      .expect(201);
    const maria: string = entrou.body.token;

    await com(maria)(
      http().delete(`/v1/admin/agenda/exceptions/${feriado.body.id}`),
    ).expect(403);

    // O bloqueio que ela mesma pode criar, ela apaga.
    const bloqueio = await com(maria)(
      http().post('/v1/admin/agenda/blocks').send({
        kind: 'block', date: amanha, startMinute: 840, endMinute: 900,
      }),
    ).expect(201);
    await com(maria)(
      http().delete(`/v1/admin/agenda/exceptions/${bloqueio.body.id}`),
    ).expect(200);

    // E o feriado continua de pé.
    const dia = await com(dono)(
      http().get('/v1/admin/agenda').query({ from: amanha }),
    ).expect(200);
    expect(dia.body.days[0].exceptions.some((e: { kind: string }) => e.kind === 'holiday')).toBe(true);
  });

  it('a rota de bloqueio não aceita fechar o dia inteiro por outro nome', async () => {
    const dono = await abrirBarbearia();
    const amanha = maisDias(await hoje(dono), 1);

    await com(dono)(
      http().post('/v1/admin/agenda/blocks').send({ kind: 'day_off', date: amanha }),
    ).expect(400);
  });

  it('bloqueio em cima de quem marcou devolve os nomes e não grava', async () => {
    const dono = await abrirBarbearia();
    const marcado = await marcar(dono);
    const [hora, minuto] = marcado.start.split(':').map(Number);
    const inicio = (hora ?? 0) * 60 + (minuto ?? 0);

    const tentativa = await com(dono)(
      http().post('/v1/admin/agenda/blocks').send({
        kind: 'block',
        date: marcado.date,
        startMinute: inicio,
        endMinute: inicio + 60,
        professionalId: marcado.professionalId,
      }),
    ).expect(201);

    expect(tentativa.body.saved).toBe(false);
    expect(tentativa.body.conflitos).toHaveLength(1);
    expect(tentativa.body.conflitos[0].customerName).toBe('João da Silva');

    const agenda = await com(dono)(
      http().get('/v1/admin/agenda').query({ from: marcado.date }),
    ).expect(200);
    expect(agenda.body.days[0].exceptions).toHaveLength(0);
  });

  it('faixa invertida volta com o motivo, não com erro de banco', async () => {
    const dono = await abrirBarbearia();
    const amanha = maisDias(await hoje(dono), 1);

    const recusa = await com(dono)(
      http()
        .post('/v1/admin/agenda/blocks')
        .send({ kind: 'block', date: amanha, startMinute: 900, endMinute: 840 }),
    ).expect(400);

    expect(recusa.body.error.code).toBe('invalid_request');
  });

  it('bloqueio criado some da grade pública', async () => {
    const dono = await abrirBarbearia();
    const { serviceId, professionalId } = await catalogo(dono);
    const amanha = maisDias(await hoje(dono), 1);

    const antes = await com(dono)(
      http().get('/v1/admin/availability').query({
        serviceIds: serviceId, professionalId, dateFrom: amanha, dateTo: amanha,
      }),
    ).expect(200);
    const quantosAntes = antes.body.days[0]?.slots?.length ?? 0;
    expect(quantosAntes).toBeGreaterThan(0);

    await com(dono)(
      http().post('/v1/admin/agenda/blocks').send({
        kind: 'block', date: amanha, startMinute: 480, endMinute: 1320,
        professionalId, reason: 'Fechado',
      }),
    ).expect(201);

    const depois = await com(dono)(
      http().get('/v1/admin/availability').query({
        serviceIds: serviceId, professionalId, dateFrom: amanha, dateTo: amanha,
      }),
    ).expect(200);
    expect(depois.body.days[0]?.slots ?? []).toEqual([]);
  });

  it('remover o bloqueio devolve os horários', async () => {
    const dono = await abrirBarbearia();
    const { serviceId, professionalId } = await catalogo(dono);
    const amanha = maisDias(await hoje(dono), 1);

    const criado = await com(dono)(
      http().post('/v1/admin/agenda/blocks').send({
        kind: 'block', date: amanha, startMinute: 480, endMinute: 1320, professionalId,
      }),
    ).expect(201);

    await com(dono)(
      http().delete(`/v1/admin/agenda/exceptions/${criado.body.id}`),
    ).expect(200);

    const depois = await com(dono)(
      http().get('/v1/admin/availability').query({
        serviceIds: serviceId, professionalId, dateFrom: amanha, dateTo: amanha,
      }),
    ).expect(200);
    expect((depois.body.days[0]?.slots ?? []).length).toBeGreaterThan(0);
  });

  // -- mover ------------------------------------------------------------------

  it('mover um agendamento respeita o motor', async () => {
    const dono = await abrirBarbearia();
    const marcado = await marcar(dono);
    const { serviceId } = await catalogo(dono);

    const grade = await com(dono)(
      http().get('/v1/admin/availability').query({
        serviceIds: serviceId,
        professionalId: marcado.professionalId,
        dateFrom: marcado.date,
        dateTo: marcado.date,
      }),
    ).expect(200);

    const outro = grade.body.days[0].slots.find(
      (s: { start: string }) => s.start !== marcado.start,
    );
    expect(outro).toBeDefined();

    const movido = await com(dono)(
      http()
        .post(`/v1/admin/agenda/appointments/${marcado.id}/move`)
        .send({ date: marcado.date, start: outro.start }),
    ).expect(201);
    expect(movido.body.id).not.toBe(marcado.id);

    const agenda = await com(dono)(
      http().get('/v1/admin/agenda').query({ from: marcado.date }),
    ).expect(200);
    expect(agenda.body.days[0].entries).toHaveLength(1);
    expect(agenda.body.days[0].entries[0].start).toBe(outro.start);
  });

  it('mover para cima de outro cliente é recusado com 409', async () => {
    const dono = await abrirBarbearia();
    const primeiro = await marcar(dono);
    const { serviceId, outroProfissional } = await catalogo(dono);
    expect(outroProfissional).toBeDefined();

    // Um segundo agendamento no mesmo horário, com o outro profissional.
    const segundo = await com(dono)(
      http().post('/v1/admin/appointments').send({
        name: 'Carlos Pereira',
        phone: '(71) 98888-5678',
        professionalId: outroProfissional,
        serviceIds: [serviceId],
        date: primeiro.date,
        start: primeiro.start,
      }),
    ).expect(201);

    // Mover o segundo para a cadeira e o horário do primeiro.
    const recusa = await com(dono)(
      http().post(`/v1/admin/agenda/appointments/${segundo.body.id}/move`).send({
        date: primeiro.date,
        start: primeiro.start,
        professionalId: primeiro.professionalId,
      }),
    ).expect(409);

    expect(['slot_taken', 'slot_not_available']).toContain(recusa.body.error.code);
  });

  // -- o que a /security-review encontrou -------------------------------------

  /** Cria um barbeiro com conta, que não enxerga a agenda da casa. */
  async function barbeiroComConta(dono: string) {
    const email = 'ruan@domari.com.br';
    // Ligado a uma agenda: é o que `professionalId` existe para fazer, e sem
    // isso a conta não tem agenda própria — outro caso, testado abaixo.
    const { outroProfissional } = await catalogo(dono);
    const criada = await com(dono)(
      http().post('/v1/admin/team').send({
        name: 'Ruan',
        email,
        role: 'professional',
        professionalId: outroProfissional,
      }),
    ).expect(201);
    const senha: string = criada.body.senhaInicial;
    const primeira = await http().post('/v1/admin/login').send({ email, password: senha }).expect(201);
    await com(primeira.body.token)(
      http().put('/v1/admin/me/password').send({ currentPassword: senha, newPassword: 'a-senha-dele' }),
    ).expect(200);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email, password: 'a-senha-dele' })
      .expect(201);
    return entrou.body.token as string;
  }

  /**
   * A primeira chamada devolve conflitos e **não grava**, então era um oráculo.
   *
   * Quem enxerga só a própria agenda pedia um bloqueio do dia inteiro e recebia
   * de volta o livro da casa — nome de cliente, hora e id de todo mundo — sem
   * criar nada e sem aparecer em lugar nenhum.
   */
  it('a lista de conflitos respeita quem só enxerga a própria agenda', async () => {
    const dono = await abrirBarbearia();
    const marcado = await marcar(dono);
    const ruan = await barbeiroComConta(dono);

    // A faixa precisa **conter** o agendamento, senão o teste passa por vazio —
    // que é exatamente o defeito que a /security-review encontrou no teste
    // vizinho: parecia prova e não era.
    const [hora, minuto] = marcado.start.split(':').map(Number);
    const inicio = (hora ?? 0) * 60 + (minuto ?? 0);

    const tentativa = await com(ruan)(
      http().post('/v1/admin/agenda/blocks').send({
        kind: 'block',
        date: marcado.date,
        startMinute: inicio,
        endMinute: inicio + 60,
        professionalId: marcado.professionalId,
      }),
    );

    // Ou é recusado, ou grava sem entregar o livro do colega. O que não pode é
    // devolver o nome de quem ele não enxerga na própria agenda.
    expect(JSON.stringify(tentativa.body)).not.toContain('João da Silva');
    expect(JSON.stringify(tentativa.body)).not.toContain(marcado.id);
  });

  /**
   * Recusar o **nome** não bastava.
   *
   * Bloqueio das 00:00 às 24:00 sem profissional é feriado com outra etiqueta:
   * o motor subtrai bloqueio da unidade do dia de todo mundo, e a barbearia
   * some da grade pública. O primeiro teste desta rota conferia só a grafia.
   */
  it('quem não administra não fecha a barbearia com um bloqueio do dia inteiro', async () => {
    const dono = await abrirBarbearia();
    const amanha = maisDias(await hoje(dono), 1);
    const { serviceId, professionalId } = await catalogo(dono);
    const ruan = await barbeiroComConta(dono);

    // Sem profissional = a barbearia toda.
    await com(ruan)(
      http().post('/v1/admin/agenda/blocks').send({
        kind: 'block', date: amanha, startMinute: 0, endMinute: 1440,
      }),
    ).expect(403);

    // Com profissional, mas cobrindo o dia: isso é folga.
    await com(ruan)(
      http().post('/v1/admin/agenda/blocks').send({
        kind: 'block', date: amanha, startMinute: 0, endMinute: 1440, professionalId,
      }),
    ).expect(403);

    // O bloqueio de verdade continua passando.
    await com(ruan)(
      http().post('/v1/admin/agenda/blocks').send({
        kind: 'block', date: amanha, startMinute: 840, endMinute: 900, professionalId,
      }),
    ).expect(201);

    // E a grade pública continua de pé.
    const grade = await com(dono)(
      http().get('/v1/admin/availability').query({
        serviceIds: serviceId, professionalId, dateFrom: amanha, dateTo: amanha,
      }),
    ).expect(200);
    expect((grade.body.days[0]?.slots ?? []).length).toBeGreaterThan(0);
  });

  it('o barbeiro não remarca o cliente do colega', async () => {
    const dono = await abrirBarbearia();
    const marcado = await marcar(dono);
    const ruan = await barbeiroComConta(dono);

    // `appointments.reschedule` está no papel dele — o que falta é a agenda ser
    // dele. RLS separa barbearias, não profissionais dentro de uma.
    await com(ruan)(
      http()
        .post(`/v1/admin/agenda/appointments/${marcado.id}/move`)
        .send({ date: marcado.date, start: '19:00' }),
    ).expect(404);

    // E não empurra ninguém para a cadeira de um terceiro.
    await com(ruan)(
      http().post(`/v1/admin/agenda/appointments/${marcado.id}/move`).send({
        date: marcado.date,
        start: '19:00',
        professionalId: marcado.professionalId,
      }),
    ).expect(403);

    // O agendamento continua onde estava.
    const agenda = await com(dono)(
      http().get('/v1/admin/agenda').query({ from: marcado.date }),
    ).expect(200);
    expect(agenda.body.days[0].entries[0].start).toBe(marcado.start);
  });

  it('conta de equipe sem agenda própria não move o atendimento de ninguém', async () => {
    const dono = await abrirBarbearia();
    const marcado = await marcar(dono);

    const email = 'solto@domari.com.br';
    const criada = await com(dono)(
      http().post('/v1/admin/team').send({ name: 'Sem Agenda', email, role: 'professional' }),
    ).expect(201);
    const senha: string = criada.body.senhaInicial;
    const primeira = await http().post('/v1/admin/login').send({ email, password: senha }).expect(201);
    await com(primeira.body.token)(
      http().put('/v1/admin/me/password').send({ currentPassword: senha, newPassword: 'a-senha-dele' }),
    ).expect(200);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email, password: 'a-senha-dele' })
      .expect(201);

    // `recorte` devolve `null` para essa conta, e `null` significa "sem
    // restrição" — o padrão errado para uma escrita no cliente dos outros.
    await com(entrou.body.token)(
      http()
        .post(`/v1/admin/agenda/appointments/${marcado.id}/move`)
        .send({ date: marcado.date, start: '19:00' }),
    ).expect(403);
  });

  // -- permissão e a parede ---------------------------------------------------

  it('a agenda exige sessão de equipe', async () => {
    await abrirBarbearia();
    await http().get('/v1/admin/agenda').query({ from: '2026-08-14' }).expect(401);
    await http().post('/v1/admin/agenda/blocks').send({ kind: 'block' }).expect(401);
  });

  it('a agenda de uma barbearia não é vista nem alterada pela outra', async () => {
    const dono = await abrirBarbearia();
    const marcado = await marcar(dono);
    const rival = await abrirBarbearia(RIVAL);

    const doRival = await com(rival)(
      http().get('/v1/admin/agenda').query({ from: marcado.date }),
    ).expect(200);
    expect(doRival.body.days[0].entries).toEqual([]);

    await com(rival)(
      http()
        .post(`/v1/admin/agenda/appointments/${marcado.id}/move`)
        .send({ date: marcado.date, start: '09:00' }),
    ).expect(404);

    await com(rival)(
      http().post('/v1/admin/agenda/blocks').send({
        kind: 'block',
        date: marcado.date,
        startMinute: 840,
        endMinute: 900,
        professionalId: marcado.professionalId,
      }),
    ).expect(404);

    // E a agenda da casa continua intacta.
    const daCasa = await com(dono)(
      http().get('/v1/admin/agenda').query({ from: marcado.date }),
    ).expect(200);
    expect(daCasa.body.days[0].entries).toHaveLength(1);
  });
});
