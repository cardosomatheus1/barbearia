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
import { AvisosController } from '../src/admin/avisos.controller.js';
import { FichaController } from '../src/admin/ficha.controller.js';
import { CatalogoController } from '../src/admin/catalogo.controller.js';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { ConsoleMessagingProvider } from '@barbearia/identity';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
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
        AvisosController,
        FichaController,
        CatalogoController,
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

  // -- o que cada um enxerga -------------------------------------------------

  it('o barbeiro vê a própria agenda, não a da casa', async () => {
    // `appointments.view_all_professionals` é negada ao barbeiro no padrão de
    // fábrica e não decidia nada: o painel devolvia a casa inteira sob
    // `appointments.view`, que todo papel tem — e a tela de equipe promete "a
    // própria agenda" para esse papel.
    const dono = await entrarComoDono();
    const equipe = await com(dono)(
      http().put('/v1/admin/professionals').send({
        professionals: [
          { name: 'Ruan', schedule: [{ weekday: 2, startMinute: 540, endMinute: 1080 }] },
          { name: 'Gleidson', schedule: [{ weekday: 2, startMinute: 540, endMinute: 1080 }] },
        ],
      }),
    ).expect(200);
    expect(equipe.body.created).toBe(2);

    const catalogo = await com(dono)(http().get('/v1/admin/catalog')).expect(200);
    // Por nome, não por posição: o catálogo vem ordenado alfabeticamente e
    // "Gleidson" vem antes de "Ruan".
    const ruan = catalogo.body.professionals.find((p: { name: string }) => p.name === 'Ruan');
    expect(ruan, 'Ruan não apareceu no catálogo').toBeDefined();

    const criada = await com(dono)(
      http().post('/v1/admin/team').send({
        name: 'Ruan',
        email: 'ruan@domari.com.br',
        role: 'professional',
        professionalId: ruan.id,
      }),
    ).expect(201);

    const primeira = await http()
      .post('/v1/admin/login')
      .send({ email: 'ruan@domari.com.br', password: criada.body.senhaInicial })
      .expect(201);
    await com(primeira.body.token)(
      http().put('/v1/admin/me/password').send({
        currentPassword: criada.body.senhaInicial,
        newPassword: 'a-senha-do-ruan',
      }),
    ).expect(200);
    const dele = await http()
      .post('/v1/admin/login')
      .send({ email: 'ruan@domari.com.br', password: 'a-senha-do-ruan' })
      .expect(201);

    const dia = await com(dele.body.token)(http().get('/v1/admin/day')).expect(200);
    // Nem o nome do colega na lista de filtro: seria dizer quem mais atende.
    expect(dia.body.professionals.map((p: { name: string }) => p.name)).toEqual(['Ruan']);

    // E o dono continua vendo os dois.
    const daCasa = await com(dono)(http().get('/v1/admin/day')).expect(200);
    expect(daCasa.body.professionals).toHaveLength(2);
  });

  it('o painel não devolve faturamento para ninguém', async () => {
    // `finance.view` é do dono e do gerente. Entregar o número sob
    // `appointments.view` daria a receita do dia a quem abre o balcão. Ele volta
    // no bloco 18, com o caixa e com o segundo fator.
    const dono = await entrarComoDono();
    const dia = await com(dono)(http().get('/v1/admin/day')).expect(200);
    expect(JSON.stringify(dia.body.totals)).not.toContain('realizado');
  });

  // -- o dono continua protegido ---------------------------------------------

  it('nem quem administra a equipe reemite a senha do dono', async () => {
    // Hoje só o dono tem `team.manage`, mas `role_permissions` é editável de
    // propósito. No dia em que um gerente receber a permissão, esta rota seria
    // tomada de conta numa requisição: devolve a senha nova em claro e derruba
    // as sessões do dono junto.
    const dono = await entrarComoDono();
    const equipe = await com(dono)(http().get('/v1/admin/team')).expect(200);
    const oDono = equipe.body.members.find((m: { role: string }) => m.role === 'owner');

    const resposta = await com(dono)(
      http().post(`/v1/admin/team/${oDono.id}/reset-password`),
    ).expect(409);
    expect(resposta.body.error.code).toBe('owner_protected');
  });

  // -- o e-mail não vira oráculo ---------------------------------------------

  it('e-mail de outra barbearia não é confirmado nem negado especificamente', async () => {
    // `staff_directory` não tem escopo de tenant de propósito — o login resolve
    // e-mail para tenant antes de existir tenant. Consultar sem filtro fazia
    // esta rota devolver "já existe" para conta de qualquer barbearia, que é o
    // oráculo que o cadastro público paga caro para fechar.
    await http()
      .post('/v1/admin/signup')
      .send({ ...DONO, email: 'rival@rival.com.br', businessName: 'Rival Barbearia' })
      .expect(202);

    const dono = await entrarComoDono();
    const resposta = await com(dono)(
      http()
        .post('/v1/admin/team')
        .send({ name: 'Alguém', email: 'rival@rival.com.br', role: 'receptionist' }),
    ).expect(409);

    // Genérico: não confirma que o endereço pertence a alguém na plataforma.
    expect(resposta.body.error.code).toBe('email_unavailable');
    expect(resposta.body.error.message).not.toMatch(/plataforma|já tem conta/i);

    // Já o e-mail da própria barbearia pode ser dito com todas as letras: quem
    // pergunta já enxerga essa lista pela tela de equipe.
    const daCasa = await com(dono)(
      http().post('/v1/admin/team').send({ name: 'Outro', email: DONO.email, role: 'receptionist' }),
    ).expect(409);
    expect(daCasa.body.error.code).toBe('email_taken');
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
  // -- avisos ao cliente -------------------------------------------------------

  it('a recepcionista não muda o que a barbearia manda ao cliente', async () => {
    // Desligar o lembrete de 24h é configuração da casa, do mesmo tipo que a
    // janela de cancelamento — e é o aviso que mais derruba falta.
    const dono = await entrarComoDono();
    const maria = await recepcionista(dono);

    await com(maria.token)(http().get('/v1/admin/notifications')).expect(403);
    await com(maria.token)(
      http().put('/v1/admin/notifications').send({
        confirmacao: false,
        lembrete24h: false,
        lembrete2h: false,
        retorno: false,
        diasParaRetorno: 45,
      }),
    ).expect(403);
  });

  it('o dono liga e desliga cada aviso, e o prazo de retorno tem piso', async () => {
    const dono = await entrarComoDono();

    const antes = await com(dono)(http().get('/v1/admin/notifications')).expect(200);
    expect(antes.body.settings).toMatchObject({ lembrete2h: true, retorno: false });
    expect(antes.body.log).toEqual([]);

    await com(dono)(
      http().put('/v1/admin/notifications').send({
        confirmacao: true,
        lembrete24h: true,
        lembrete2h: false,
        retorno: true,
        diasParaRetorno: 30,
      }),
    ).expect(200);

    const depois = await com(dono)(http().get('/v1/admin/notifications')).expect(200);
    expect(depois.body.settings).toMatchObject({
      lembrete2h: false,
      retorno: true,
      diasParaRetorno: 30,
    });

    // Dois dias sem voltar não é lembrete, é perseguição. O piso é o mesmo da
    // CHECK do banco — a borda recusa antes de chegar lá.
    const recusado = await com(dono)(
      http().put('/v1/admin/notifications').send({
        confirmacao: true,
        lembrete24h: true,
        lembrete2h: true,
        retorno: true,
        diasParaRetorno: 2,
      }),
    ).expect(400);
    expect(recusado.body.error.code).toBe('invalid_request');
  });

  it('a senha de primeiro acesso sai por mensagem e não vira registro legível', async () => {
    const dono = await entrarComoDono();
    const criada = await com(dono)(
      http().post('/v1/admin/team').send({
        name: 'Maria Recepção',
        email: 'maria2@domari.com.br',
        phone: '(71) 97777-6666',
        role: 'receptionist',
      }),
    ).expect(201);

    expect(criada.body.entrega).toBe('enviada');

    const avisos = await com(dono)(http().get('/v1/admin/notifications')).expect(200);
    const senha = avisos.body.log.find((linha: { tipo: string }) => linha.tipo === 'senha_de_acesso');
    expect(senha).toMatchObject({ status: 'sent', quem: 'Maria Recepção' });
    // O telefone sai mascarado e a credencial não aparece em lugar nenhum.
    expect(senha.telefone).not.toContain('977776666');
    expect(JSON.stringify(avisos.body)).not.toContain(criada.body.senhaInicial);
  });
  // -- o convite e a ficha ------------------------------------------------------

  /** Cria a cadeira pelo cadastro e devolve o id. */
  async function cadeira(dono: string, nome = 'Ruan'): Promise<string> {
    await com(dono)(
      http().put('/v1/admin/professionals').send({
        professionals: [{ name: nome, schedule: [{ weekday: 2, startMinute: 540, endMinute: 1080 }] }],
      }),
    ).expect(200);
    const catalogo = await com(dono)(http().get('/v1/admin/catalog')).expect(200);
    const achado = catalogo.body.professionals.find((p: { name: string }) => p.name === nome);
    expect(achado, `${nome} não apareceu no catálogo`).toBeDefined();
    return achado.id;
  }

  /** Convida e devolve a sessão do barbeiro, já com a senha trocada. */
  async function barbeiro(dono: string, email = 'ruan@domari.com.br') {
    const id = await cadeira(dono);
    const convite = await com(dono)(
      http().post('/v1/admin/team/invite').send({ professionalId: id, email }),
    ).expect(201);

    const primeira = await http()
      .post('/v1/admin/login')
      .send({ email, password: convite.body.senhaInicial })
      .expect(201);
    await com(primeira.body.token)(
      http().put('/v1/admin/me/password').send({
        currentPassword: convite.body.senhaInicial,
        newPassword: 'a-senha-do-ruan',
      }),
    ).expect(200);
    const dele = await http()
      .post('/v1/admin/login')
      .send({ email, password: 'a-senha-do-ruan' })
      .expect(201);

    return { token: dele.body.token as string, professionalId: id, convite: convite.body };
  }

  /** Um cliente na base. Criar cliente é do balcão, não deste bloco. */
  async function cliente(dono: string, nome = 'Carlos Souza'): Promise<string> {
    const estado = await com(dono)(http().get('/v1/admin/state')).expect(200);
    const linhas = await admin.$queryRawUnsafe<{ id: string }[]>(`
      INSERT INTO customers (tenant_id, name, phone_e164)
      VALUES ('${estado.body.tenantId}', '${nome}', '+55719888877${Math.floor(Math.random() * 90) + 10}')
      RETURNING id
    `);
    const id = linhas[0]?.id;
    if (!id) throw new Error('não deu para criar o cliente');
    return id;
  }

  it('convidar cria a conta do barbeiro ligada à cadeira dele', async () => {
    const dono = await entrarComoDono();
    const ruan = await barbeiro(dono);

    expect(ruan.convite.member.role).toBe('professional');
    expect(ruan.convite.member.professionalId).toBe(ruan.professionalId);

    // E ele entra já vendo só a própria agenda.
    const dia = await com(ruan.token)(http().get('/v1/admin/day')).expect(200);
    expect(dia.body.professionals.map((p: { name: string }) => p.name)).toEqual(['Ruan']);
  });

  it('convidar é criar conta, e nem quem configura a barbearia pode', async () => {
    /**
     * O caminho da tela sai do cadastro de profissionais, que é
     * `settings.manage`. A permissão **não** acompanha o caminho.
     *
     * O caso que separa as duas é o **gerente**: ele tem `settings.manage` e
     * não tem `team.manage`. Provar com a recepcionista não provaria nada —
     * ela não tem nenhuma das duas, e a rota a recusaria de qualquer jeito.
     */
    const dono = await entrarComoDono();
    const id = await cadeira(dono);

    const criada = await com(dono)(
      http().post('/v1/admin/team').send({
        name: 'Bruno Gerente',
        email: 'bruno@domari.com.br',
        role: 'manager',
      }),
    ).expect(201);
    const primeira = await http()
      .post('/v1/admin/login')
      .send({ email: 'bruno@domari.com.br', password: criada.body.senhaInicial })
      .expect(201);
    await com(primeira.body.token)(
      http().put('/v1/admin/me/password').send({
        currentPassword: criada.body.senhaInicial,
        newPassword: 'a-senha-do-bruno',
      }),
    ).expect(200);
    const gerente = await http()
      .post('/v1/admin/login')
      .send({ email: 'bruno@domari.com.br', password: 'a-senha-do-bruno' })
      .expect(201);

    // Ele configura a barbearia...
    await com(gerente.body.token)(http().get('/v1/admin/catalog')).expect(200);
    // ...e não cria conta por isso.
    await com(gerente.body.token)(
      http().post('/v1/admin/team/invite').send({
        professionalId: id,
        email: 'complice@domari.com.br',
      }),
    ).expect(403);
  });

  it('a mesma cadeira não recebe dois convites', async () => {
    const dono = await entrarComoDono();
    const ruan = await barbeiro(dono);

    const segundo = await com(dono)(
      http().post('/v1/admin/team/invite').send({
        professionalId: ruan.professionalId,
        email: 'outro@domari.com.br',
      }),
    ).expect(409);
    expect(segundo.body.error.code).toBe('professional_already_invited');
  });

  it('o barbeiro lê e escreve a ficha do cliente', async () => {
    // `customers.view_notes` está no padrão de fábrica do papel `professional`
    // desde o bloco 12 — e até agora não havia anotação nenhuma para ver.
    const dono = await entrarComoDono();
    const ruan = await barbeiro(dono);

    const carlos = await cliente(dono);

    const antes = await com(ruan.token)(
      http().get(`/v1/admin/customers/${carlos}/ficha`),
    ).expect(200);
    expect(antes.body.preferencias.conversa).toBe('indiferente');
    expect(antes.body.linhaDoTempo).toEqual([]);

    await com(ruan.token)(
      http().put(`/v1/admin/customers/${carlos}/preferences`).send({
        produtosEvitar: 'Álcool no pós-barba',
        conversa: 'silencioso',
      }),
    ).expect(200);

    const depois = await com(ruan.token)(
      http().get(`/v1/admin/customers/${carlos}/ficha`),
    ).expect(200);
    expect(depois.body.preferencias.produtosEvitar).toBe('Álcool no pós-barba');
    expect(depois.body.anotadoPor).toBe('Ruan');
  });

  it('a recepção não lê nem escreve a anotação do cliente', async () => {
    /**
     * Ela precisa **achar** o cliente, não ler o que anotaram sobre ele.
     * `customers.view_notes` é negada ao papel `receptionist` no padrão de
     * fábrica desde o bloco 12; agora existe dado atrás disso.
     */
    const dono = await entrarComoDono();
    const maria = await recepcionista(dono);
    const carlos = await cliente(dono);

    await com(maria.token)(http().get(`/v1/admin/customers/${carlos}/ficha`)).expect(403);

    await com(maria.token)(
      http().put(`/v1/admin/customers/${carlos}/preferences`).send({
        conversa: 'conversa',
        observacoes: 'anotação indevida',
      }),
    ).expect(403);
  });

  it('vocabulário de conversa fora da lista é recusado na borda', async () => {
    const dono = await entrarComoDono();
    const carlos = await cliente(dono);

    await com(dono)(
      http().put(`/v1/admin/customers/${carlos}/preferences`).send({ conversa: 'quieto' }),
    ).expect(400);
  });

  it('anotação longa demais é recusada na borda, não pelo banco', async () => {
    /**
     * A CHECK da migração 0021 tem o mesmo teto. Deixar o banco recusar
     * transformaria "escrevi demais" em erro de banco na cara do barbeiro, em
     * vez de uma mensagem que diz o que fazer.
     */
    const dono = await entrarComoDono();
    const carlos = await cliente(dono);

    const recusado = await com(dono)(
      http().put(`/v1/admin/customers/${carlos}/preferences`).send({
        conversa: 'indiferente',
        observacoes: 'a'.repeat(1001),
      }),
    ).expect(400);
    expect(recusado.body.error.code).toBe('invalid_request');
  });

  it('a ficha de um cliente da outra barbearia é 404, não 403', async () => {
    /**
     * 403 confirmaria que o id existe em algum lugar da plataforma. A RLS
     * devolve zero linhas, e a resposta é a mesma de um id inventado.
     */
    const dono = await entrarComoDono();
    const carlos = await cliente(dono);

    await http().post('/v1/admin/signup').send({
      ...DONO,
      email: 'rival@rival.com.br',
      businessName: 'Rival Barbearia',
    }).expect(202);
    const rival = await http()
      .post('/v1/admin/login')
      .send({ email: 'rival@rival.com.br', password: DONO.password })
      .expect(201);

    await com(rival.body.token)(http().get(`/v1/admin/customers/${carlos}/ficha`)).expect(404);
  });
});
