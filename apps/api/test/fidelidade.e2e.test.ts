import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeMessagingProvider } from '@barbearia/identity';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { FidelidadeController } from '../src/admin/fidelidade.controller.js';
import { TeamController, MeController } from '../src/admin/team.controller.js';
import { BoardController } from '../src/admin/board.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';
import { limparBanco } from './limpar.js';

/**
 * A fidelidade pela HTTP (bloco 41).
 *
 * Três perguntas: um modelo por barbearia é fato ou promessa? Criar saldo à mão
 * exige o segundo fator, como toda rota de dinheiro? E o saldo de uma barbearia
 * atravessa para a outra?
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

let app: INestApplication;
let admin: PrismaClient;
let tenants: TenantService;
let mensagens: FakeMessagingProvider;

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

const PROGRAMA = {
  modo: 'pontos',
  pontosPorReal: 1,
  valorDoPontoCents: 1,
  visitasParaPremio: 10,
  cashbackBps: 500,
  validadeDias: null,
};

describeIfDb('fidelidade pela HTTP', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    process.env['MFA_SECRET_KEY'] = 'chave-de-teste-com-32-bytes-aqui!';
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
    mensagens = new FakeMessagingProvider();

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [
        StaffAuthController,
        OnboardingController,
        BoardController,
        FidelidadeController,
        TeamController,
        MeController,
      ],
      providers: [
        TenantService,
        { provide: MESSAGING_PROVIDER, useValue: mensagens },
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
    mensagens.clear();
  });

  const http = () => request(app.getHttpServer());
  const com = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  async function abrirBarbearia(conta = DONO) {
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

    return { token, tenantId: entrou.body.tenantId as string };
  }

  /** Um cliente, criado direto no banco: não é o que este arquivo prova. */
  async function cliente(tenantId: string, telefone = '+5571966665555'): Promise<string> {
    const linhas = await admin.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO customers (tenant_id, name, phone_e164)
       VALUES ('${tenantId}', 'Carlos Souza', '${telefone}') RETURNING id`,
    );
    return linhas[0]!.id;
  }

  // -- o programa --------------------------------------------------------------

  it('barbearia nova nasce sem programa', async () => {
    const casa = await abrirBarbearia();
    const resposta = await com(casa.token)(http().get('/v1/admin/fidelidade/programa')).expect(200);
    expect(resposta.body.modo).toBe('nenhum');
  });

  it('trocar de modelo substitui o anterior, nunca soma', async () => {
    /**
     * "Você tem 340 pontos, 3 visitas e R$ 12 de cashback" é a frase que ninguém
     * entende no balcão. A SPEC §4.8 manda escolher **um**, e a chave primária
     * do banco é quem garante.
     */
    const casa = await abrirBarbearia();
    await com(casa.token)(
      http().put('/v1/admin/fidelidade/programa').send(PROGRAMA),
    ).expect(200);
    await com(casa.token)(
      http().put('/v1/admin/fidelidade/programa').send({ ...PROGRAMA, modo: 'cashback' }),
    ).expect(200);

    const resposta = await com(casa.token)(http().get('/v1/admin/fidelidade/programa')).expect(200);
    expect(resposta.body.modo).toBe('cashback');

    const linhas = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM loyalty_programs WHERE tenant_id = '${casa.tenantId}'`,
    );
    expect(Number(linhas[0]?.n)).toBe(1);
  });

  it('cem por cento de cashback é recusado na borda, com mensagem', async () => {
    // O banco também recusa; a borda é o que devolve "confira os números" em vez
    // de um erro de constraint.
    const casa = await abrirBarbearia();
    await com(casa.token)(
      http().put('/v1/admin/fidelidade/programa').send({ ...PROGRAMA, cashbackBps: 10000 }),
    ).expect(400);
  });

  // -- o saldo -----------------------------------------------------------------

  it('o saldo de um cliente sai com o extrato que o explica', async () => {
    const casa = await abrirBarbearia();
    const carlos = await cliente(casa.tenantId);
    await com(casa.token)(http().put('/v1/admin/fidelidade/programa').send(PROGRAMA)).expect(200);

    await com(casa.token)(
      http()
        .post(`/v1/admin/fidelidade/clientes/${carlos}/ajuste`)
        .send({ quantidade: 100, motivo: 'cortesia de reabertura da loja' }),
    ).expect(201);

    const resposta = await com(casa.token)(
      http().get(`/v1/admin/fidelidade/clientes/${carlos}`),
    ).expect(200);

    expect(resposta.body).toMatchObject({ modo: 'pontos', saldo: 100 });
    expect(resposta.body.extrato).toHaveLength(1);
    expect(resposta.body.extrato[0]).toMatchObject({ tipo: 'ajuste', quantidade: 100 });
  });

  it('ajuste sem motivo escrito é recusado', async () => {
    // O ajuste **cria** dinheiro: ele vira pagamento no balcão da operação
    // seguinte, e um sem explicação é indefensável na primeira pergunta do dono.
    const casa = await abrirBarbearia();
    const carlos = await cliente(casa.tenantId);
    await com(casa.token)(http().put('/v1/admin/fidelidade/programa').send(PROGRAMA)).expect(200);

    await com(casa.token)(
      http()
        .post(`/v1/admin/fidelidade/clientes/${carlos}/ajuste`)
        .send({ quantidade: 100, motivo: 'oi' }),
    ).expect(400);
  });

  it('sem programa ligado, não há saldo para ajustar', async () => {
    const casa = await abrirBarbearia();
    const carlos = await cliente(casa.tenantId);

    const recusa = await com(casa.token)(
      http()
        .post(`/v1/admin/fidelidade/clientes/${carlos}/ajuste`)
        .send({ quantidade: 100, motivo: 'cortesia de reabertura da loja' }),
    ).expect(409);
    expect(recusa.body.error.code).toBe('sem_programa');
  });

  // -- o isolamento e as permissões -------------------------------------------

  it('o saldo de uma barbearia não atravessa para a outra', async () => {
    const casa = await abrirBarbearia();
    const carlos = await cliente(casa.tenantId);
    await com(casa.token)(http().put('/v1/admin/fidelidade/programa').send(PROGRAMA)).expect(200);
    await com(casa.token)(
      http()
        .post(`/v1/admin/fidelidade/clientes/${carlos}/ajuste`)
        .send({ quantidade: 100, motivo: 'cortesia de reabertura da loja' }),
    ).expect(201);

    const rival = await abrirBarbearia(RIVAL);
    const alheio = await com(rival.token)(
      http().get(`/v1/admin/fidelidade/clientes/${carlos}`),
    ).expect(200);

    // A RLS não acha o cliente, então não há extrato nem saldo.
    expect(alheio.body).toMatchObject({ saldo: 0 });
    expect(alheio.body.extrato).toHaveLength(0);
  });

  it('quem não tem a permissão de dinheiro não cria saldo', async () => {
    /**
     * `finance.loyalty_adjust` cai no grupo de dinheiro pelo prefixo. Sem ela, a
     * rota que mais se parece com "imprimir dinheiro" ficaria aberta para toda a
     * recepção.
     */
    const casa = await abrirBarbearia();
    const carlos = await cliente(casa.tenantId);
    await com(casa.token)(http().put('/v1/admin/fidelidade/programa').send(PROGRAMA)).expect(200);

    const criada = await com(casa.token)(
      http()
        .post('/v1/admin/team')
        .send({ name: 'Maria Recepção', email: 'maria@domari.com.br', role: 'receptionist' }),
    ).expect(201);

    const primeira = await http()
      .post('/v1/admin/login')
      .send({ email: 'maria@domari.com.br', password: criada.body.senhaInicial })
      .expect(201);
    await com(primeira.body.token)(
      http().put('/v1/admin/me/password').send({
        currentPassword: criada.body.senhaInicial,
        newPassword: 'a-senha-que-ela-escolheu',
      }),
    ).expect(200);

    const maria = await http()
      .post('/v1/admin/login')
      .send({ email: 'maria@domari.com.br', password: 'a-senha-que-ela-escolheu' })
      .expect(201);

    const negado = await com(maria.body.token)(
      http()
        .post(`/v1/admin/fidelidade/clientes/${carlos}/ajuste`)
        .send({ quantidade: 100, motivo: 'cortesia de reabertura da loja' }),
    ).expect(403);
    expect(negado.body.error.code).toBe('forbidden');
  });

  it('com o segundo fator ligado na casa, ajustar saldo passa a exigi-lo', async () => {
    /**
     * A exigência não está escrita na rota: ela é **derivada** do prefixo
     * `finance.` da permissão. É o mesmo mecanismo do caixa, e é o que garante
     * que uma rota de dinheiro nova nasça coberta — sem ninguém lembrar.
     */
    const casa = await abrirBarbearia();
    const carlos = await cliente(casa.tenantId);
    await com(casa.token)(http().put('/v1/admin/fidelidade/programa').send(PROGRAMA)).expect(200);

    await admin.$executeRawUnsafe(
      `UPDATE tenants SET require_mfa_for_money = true WHERE id = '${casa.tenantId}'`,
    );

    const recusa = await com(casa.token)(
      http()
        .post(`/v1/admin/fidelidade/clientes/${carlos}/ajuste`)
        .send({ quantidade: 100, motivo: 'cortesia de reabertura da loja' }),
    ).expect(403);
    expect(['mfa_required', 'mfa_setup_required']).toContain(recusa.body.error.code);
  });
});
