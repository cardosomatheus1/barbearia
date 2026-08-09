import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConsoleMessagingProvider, codigoDoPasso, passoAgora } from '@barbearia/identity';
import { CaixaController } from '../src/admin/caixa.controller.js';
import { MfaController } from '../src/admin/mfa.controller.js';
import { ComissaoController } from '../src/admin/comissao.controller.js';
import { BoardController } from '../src/admin/board.controller.js';
import { MeController, TeamController } from '../src/admin/team.controller.js';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';
import { limparBanco } from './limpar.js';

/**
 * O dinheiro pela HTTP.
 *
 * O que só se prova aqui, com a pilha inteira de pé: que **nenhuma rota de
 * dinheiro responde sem o segundo fator**, mesmo para o dono, que tem todas as
 * permissões. É a regra do `CLAUDE.md` que passou seis blocos escrita e sem
 * mecanismo — e o que a torna verdadeira é a guarda derivar a exigência da
 * permissão declarada, não um decorador que alguém precise lembrar de pôr.
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

describeIfDb('caixa e comanda pela HTTP', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    process.env['MFA_SECRET_KEY'] = Buffer.alloc(32, 9).toString('base64');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [
        StaffAuthController,
        OnboardingController,
        BoardController,
        CaixaController,
        MfaController,
        ComissaoController,
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
            // O segundo existe para o recorte da comissão poder ser provado:
            // com um só, o barbeiro e o executor da venda seriam a mesma pessoa
            // e "ele não vê o do colega" não afirmaria nada.
            { name: 'Gleidson Alves', schedule: JORNADA },
          ],
        }),
    ).expect(200);

    await com(token)(http().post('/v1/admin/publish')).expect(201);
    return token;
  }

  /** Liga o segundo fator e o prova para esta sessão. */
  async function comSegundoFator(token: string): Promise<string> {
    const inicio = await com(token)(http().post('/v1/admin/mfa/setup')).expect(201);
    const segredo: string = inicio.body.segredoBase32;

    const passo = passoAgora(new Date());
    await com(token)(
      http().post('/v1/admin/mfa/confirm').send({ codigo: codigoDoPasso(segredo, passo) }),
    ).expect(201);

    /**
     * O passo da confirmação foi queimado, então o código do **passo seguinte**
     * é o que serve. Vale reparar em como não fazer isto: a primeira versão
     * gerava o código a partir de `now + 31s` e falhava sozinha algumas vezes
     * em dez. Quando a confirmação caía perto do fim de uma janela, trinta e um
     * segundos adiante já eram *dois* passos à frente — fora da tolerância de
     * ±1 que o servidor aplica ao relógio real, que não andou junto.
     *
     * Somar 1 ao passo é a mesma intenção sem inventar relógio: se o tempo real
     * virar a janela no meio disto, o código passa a ser o do passo atual, e
     * continua valendo.
     */
    await com(token)(
      http().post('/v1/admin/mfa/verify').send({ codigo: codigoDoPasso(segredo, passo + 1) }),
    ).expect(201);

    return segredo;
  }


  /** Cria a recepcionista, troca a senha de primeiro acesso e devolve a sessão. */
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

  const abrirCaixa = (token: string, openingCents = 20000) =>
    com(token)(http().post('/v1/admin/cash/open').send({ openingCents }));

  async function comandaCom(token: string, precoCents: number): Promise<string> {
    const aberta = await com(token)(http().post('/v1/admin/orders').send({})).expect(201);
    const id: string = aberta.body.id;

    await com(token)(
      http().post(`/v1/admin/orders/${id}/items`).send({
        tipo: 'service',
        descricao: 'Corte de cabelo',
        quantidade: 1,
        precoUnitarioCents: precoCents,
      }),
    ).expect(201);

    return id;
  }

  // -- a porta ----------------------------------------------------------------

  it('o dono, com todas as permissões, não abre o caixa sem cadastrar o segundo fator', async () => {
    const token = await abrirBarbearia();
    const recusa = await abrirCaixa(token).expect(403);
    // Código próprio: a tela precisa mandar cadastrar, não dizer "sem permissão"
    // a quem tem permissão.
    expect(recusa.body.error.code).toBe('mfa_setup_required');
  });

  it('com o segundo fator cadastrado mas não provado nesta sessão, ainda recusa', async () => {
    const token = await abrirBarbearia();

    const inicio = await com(token)(http().post('/v1/admin/mfa/setup')).expect(201);
    await com(token)(
      http()
        .post('/v1/admin/mfa/confirm')
        .send({ codigo: codigoDoPasso(inicio.body.segredoBase32, passoAgora(new Date())) }),
    ).expect(201);

    // Confirmar o cadastro não é provar o aparelho: a exigência é por sessão.
    const recusa = await abrirCaixa(token).expect(403);
    expect(recusa.body.error.code).toBe('mfa_required');
  });

  it('provado o código, o caixa abre', async () => {
    const token = await abrirBarbearia();
    await comSegundoFator(token);
    await abrirCaixa(token).expect(201);

    const caixa = await com(token)(http().get('/v1/admin/cash')).expect(200);
    expect(caixa.body.aberto.openingCents).toBe(20000);
    expect(caixa.body.aberto.esperadoAgoraCents).toBe(20000);
    expect(caixa.body.timezone).toBe('America/Bahia');
  });

  it('sem sessão nenhuma é 401, não 403', async () => {
    await http().get('/v1/admin/cash').expect(401);
  });

  // -- permissão --------------------------------------------------------------

  it('tirar cashier.open do papel fecha a porta na requisição seguinte', async () => {
    const token = await abrirBarbearia();
    await comSegundoFator(token);
    await abrirCaixa(token).expect(201);

    await admin.$executeRawUnsafe(
      `DELETE FROM role_permissions WHERE role = 'owner' AND permission = 'cashier.open'`,
    );

    // Mesma sessão, mesmo segundo fator provado: o que mudou foi o papel.
    const recusa = await com(token)(
      http().post('/v1/admin/cash/open').send({ openingCents: 100 }),
    ).expect(403);
    expect(recusa.body.error.code).toBe('forbidden');
  });

  // -- o caixa ----------------------------------------------------------------

  it('sangria maior que a gaveta é recusada com o motivo', async () => {
    const token = await abrirBarbearia();
    await comSegundoFator(token);
    await abrirCaixa(token).expect(201);

    const recusa = await com(token)(
      http()
        .post('/v1/admin/cash/movements')
        .send({ kind: 'withdrawal', amountCents: 999999, reason: 'Engano de digitação' }),
    ).expect(400);
    expect(recusa.body.error.code).toBe('sangria_maior_que_a_gaveta');
  });

  it('sangria sem motivo não passa da borda', async () => {
    const token = await abrirBarbearia();
    await comSegundoFator(token);
    await abrirCaixa(token).expect(201);

    await com(token)(
      http().post('/v1/admin/cash/movements').send({ kind: 'withdrawal', amountCents: 100, reason: '' }),
    ).expect(400);
  });

  it('valor com centavo fracionário é recusado na borda, não arredondado', async () => {
    // Dinheiro é inteiro em todo o sistema. Aceitar 49.905 e arredondar aqui
    // faria a gaveta divergir por um centavo que ninguém consegue explicar.
    const token = await abrirBarbearia();
    await comSegundoFator(token);
    await com(token)(http().post('/v1/admin/cash/open').send({ openingCents: 200.5 })).expect(400);
  });

  it('fecha registrando a divergência, e o esperado só volta na resposta', async () => {
    const token = await abrirBarbearia();
    await comSegundoFator(token);
    await abrirCaixa(token).expect(201);

    const fechado = await com(token)(
      http().post('/v1/admin/cash/close').send({ countedCents: 19500 }),
    ).expect(201);

    expect(fechado.body).toMatchObject({
      esperadoCents: 20000,
      contadoCents: 19500,
      divergenciaCents: -500,
    });
  });

  // -- a comanda --------------------------------------------------------------

  it('sem caixa aberto a comanda não fecha', async () => {
    const token = await abrirBarbearia();
    await comSegundoFator(token);
    const id = await comandaCom(token, 4900);

    const recusa = await com(token)(
      http().post(`/v1/admin/orders/${id}/close`).send({
        pagamentos: [{ forma: 'cash', valorCents: 4900 }],
      }),
    ).expect(409);
    expect(recusa.body.error.code).toBe('caixa_fechado');
  });

  it('dinheiro entra na gaveta e o troco sai', async () => {
    const token = await abrirBarbearia();
    await comSegundoFator(token);
    await abrirCaixa(token).expect(201);
    const id = await comandaCom(token, 4900);

    const paga = await com(token)(
      http().post(`/v1/admin/orders/${id}/close`).send({
        pagamentos: [{ forma: 'cash', valorCents: 5000 }],
      }),
    ).expect(201);

    expect(paga.body.status).toBe('paid');
    expect(paga.body.trocoCents).toBe(100);

    const caixa = await com(token)(http().get('/v1/admin/cash')).expect(200);
    // 20000 de abertura + 4900 líquido da venda.
    expect(caixa.body.aberto.esperadoAgoraCents).toBe(24900);
  });

  it('cartão não entra na gaveta, mas entra no faturamento', async () => {
    const token = await abrirBarbearia();
    await comSegundoFator(token);
    await abrirCaixa(token).expect(201);
    const id = await comandaCom(token, 4900);

    await com(token)(
      http().post(`/v1/admin/orders/${id}/close`).send({
        pagamentos: [{ forma: 'credit', valorCents: 4900 }],
      }),
    ).expect(201);

    const caixa = await com(token)(http().get('/v1/admin/cash')).expect(200);
    expect(caixa.body.aberto.esperadoAgoraCents).toBe(20000);

    const receita = await com(token)(http().get('/v1/admin/revenue')).expect(200);
    expect(receita.body.recebidoCents).toBe(4900);
  });

  it('a mesma comanda não fecha duas vezes', async () => {
    const token = await abrirBarbearia();
    await comSegundoFator(token);
    await abrirCaixa(token).expect(201);
    const id = await comandaCom(token, 4900);

    const pagamento = { pagamentos: [{ forma: 'cash', valorCents: 4900 }] };
    await com(token)(http().post(`/v1/admin/orders/${id}/close`).send(pagamento)).expect(201);
    const segunda = await com(token)(http().post(`/v1/admin/orders/${id}/close`).send(pagamento));

    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('comanda_fechada');
  });

  it('a chave de idempotência é por operador, não por barbearia', async () => {
    // Ela vem do cliente e é livre. Escopada só pelo tenant, duas pessoas
    // mandando "1" receberiam a comanda uma da outra — com o id, que basta
    // para fechá-la.
    const token = await abrirBarbearia();
    await comSegundoFator(token);

    const primeira = await com(token)(
      http().post('/v1/admin/orders').set('Idempotency-Key', '1').send({}),
    ).expect(201);
    const repetida = await com(token)(
      http().post('/v1/admin/orders').set('Idempotency-Key', '1').send({}),
    ).expect(201);

    expect(repetida.body.id).toBe(primeira.body.id);
  });

  // -- a parede entre barbearias ----------------------------------------------

  it('a comanda de uma barbearia não existe para a outra', async () => {
    const token = await abrirBarbearia();
    await comSegundoFator(token);
    await abrirCaixa(token).expect(201);
    const id = await comandaCom(token, 4900);

    const rival = await abrirBarbearia(RIVAL);
    await comSegundoFator(rival);

    await com(rival)(http().get(`/v1/admin/orders/${id}`)).expect(404);
    await com(rival)(
      http().post(`/v1/admin/orders/${id}/close`).send({
        pagamentos: [{ forma: 'cash', valorCents: 4900 }],
      }),
    ).expect(404);

    // E a comanda da casa continua aberta.
    const minha = await com(token)(http().get(`/v1/admin/orders/${id}`)).expect(200);
    expect(minha.body.status).toBe('open');
  });

  it('o caixa aberto de uma barbearia não aparece na outra', async () => {
    const token = await abrirBarbearia();
    await comSegundoFator(token);
    await abrirCaixa(token, 55500).expect(201);

    const rival = await abrirBarbearia(RIVAL);
    await comSegundoFator(rival);

    const caixa = await com(rival)(http().get('/v1/admin/cash')).expect(200);
    expect(caixa.body.aberto).toBeNull();
    expect(caixa.body.historico).toEqual([]);
  });

  // -- quem pode o quê ---------------------------------------------------------

  it('a recepcionista opera o balcão inteiro: abre o caixa e registra a venda', async () => {
    /**
     * A `/security-review` pegou o inverso disto. A primeira versão pôs todas as
     * rotas de comanda sob `finance.view` — uma permissão de **leitura**
     * autorizando escrita de dinheiro. O efeito prático era pior que o teórico:
     * a recepcionista tem `cashier.open` e não tem `finance.view`, então ela
     * conseguia abrir o caixa e não conseguia registrar uma única venda.
     */
    const dono = await abrirBarbearia();
    const dela = await recepcionista(dono);
    await comSegundoFator(dela);

    await abrirCaixa(dela).expect(201);
    const id = await comandaCom(dela, 4900);
    await com(dela)(
      http().post(`/v1/admin/orders/${id}/close`).send({
        pagamentos: [{ forma: 'cash', valorCents: 4900 }],
      }),
    ).expect(201);

    await com(dela)(http().get('/v1/admin/debts')).expect(200);
  });

  it('mas não dá desconto nem vê o faturamento do dia', async () => {
    // A separação que a SPEC quer: abrir mão de receita e ler o resultado do
    // dia são do dono e do gerente, não de quem opera o balcão.
    const dono = await abrirBarbearia();
    const dela = await recepcionista(dono);
    await comSegundoFator(dela);
    await abrirCaixa(dela).expect(201);
    const id = await comandaCom(dela, 4900);

    await com(dela)(
      http().patch(`/v1/admin/orders/${id}`).send({
        desconto: { tipo: 'percent', valor: 100, motivo: 'amigo' },
      }),
    ).expect(403);

    await com(dela)(http().get('/v1/admin/revenue')).expect(403);

    // E o dono dá o desconto sem problema.
    await comSegundoFator(dono);
    await com(dono)(
      http().patch(`/v1/admin/orders/${id}`).send({
        desconto: { tipo: 'amount', valor: 500, motivo: 'Cliente antigo' },
      }),
    ).expect(200);
  });

  it('o segundo fator vale para a recepcionista igual ao dono', async () => {
    const dono = await abrirBarbearia();
    const dela = await recepcionista(dono);

    const recusa = await abrirCaixa(dela).expect(403);
    expect(recusa.body.error.code).toBe('mfa_setup_required');
  });

  it('a mesma chave no fechamento devolve a comanda paga, não um 409', async () => {
    const token = await abrirBarbearia();
    await comSegundoFator(token);
    await abrirCaixa(token).expect(201);
    const id = await comandaCom(token, 4900);

    const pagamento = { pagamentos: [{ forma: 'cash', valorCents: 4900 }] };
    const primeira = await com(token)(
      http().post(`/v1/admin/orders/${id}/close`).set('Idempotency-Key', 'toque-1').send(pagamento),
    ).expect(201);
    const repetida = await com(token)(
      http().post(`/v1/admin/orders/${id}/close`).set('Idempotency-Key', 'toque-1').send(pagamento),
    ).expect(201);

    expect(repetida.body.id).toBe(primeira.body.id);

    // E a gaveta recebeu a venda uma vez só.
    const caixa = await com(token)(http().get('/v1/admin/cash')).expect(200);
    expect(caixa.body.aberto.esperadoAgoraCents).toBe(24900);
  });

  // -- comissão ----------------------------------------------------------------

  /** Cria um barbeiro com conta própria, vinculado à agenda indicada. */
  async function barbeiroComConta(dono: string, indice = 0) {
    const catalogo = await com(dono)(http().get('/v1/admin/catalog')).expect(200);
    const professionalId: string = catalogo.body.professionals[indice].id;

    const email = `barbeiro${indice}@domari.com.br`;
    const criada = await com(dono)(
      http().post('/v1/admin/team').send({
        name: 'Ruan Nascimento', email, role: 'professional', professionalId,
      }),
    ).expect(201);

    const senhaInicial: string = criada.body.senhaInicial;
    const primeira = await http().post('/v1/admin/login')
      .send({ email, password: senhaInicial }).expect(201);
    await com(primeira.body.token)(
      http().put('/v1/admin/me/password')
        .send({ currentPassword: senhaInicial, newPassword: 'a-senha-dele-agora' }),
    ).expect(200);

    const entrou = await http().post('/v1/admin/login')
      .send({ email, password: 'a-senha-dele-agora' }).expect(201);
    return { token: entrou.body.token as string, professionalId };
  }

  it('o barbeiro vê a própria comissão sem precisar de segundo fator', async () => {
    /**
     * `commission.view_own` fica de fora do grupo de dinheiro de propósito: é o
     * profissional olhando o próprio holerite. Um código de seis dígitos entre
     * ele e a primeira tela que abre todo dia é como a barbearia acaba
     * procurando como desligar a proteção inteira.
     */
    const dono = await abrirBarbearia();
    const { token } = await barbeiroComConta(dono);

    const extrato = await com(token)(http().get('/v1/admin/commission/mine')).expect(200);
    expect(extrato.body.linhas).toEqual([]);
  });

  it('o barbeiro não vê a comissão do colega, mesmo pedindo', async () => {
    // O recorte não é parâmetro: quem só tem `view_own` recebe o próprio id
    // cravado na consulta. Motivo nº 1 de briga interna em barbearia.
    const dono = await abrirBarbearia();
    await comSegundoFator(dono);
    await abrirCaixa(dono).expect(201);

    const catalogo = await com(dono)(http().get('/v1/admin/catalog')).expect(200);
    const outroId: string = catalogo.body.professionals[0].id;

    await com(dono)(
      http().put('/v1/admin/commission/rules').send({ modo: 'percent', valor: 4000 }),
    ).expect(200);

    // Venda executada pelo profissional do catálogo.
    const aberta = await com(dono)(http().post('/v1/admin/orders').send({})).expect(201);
    await com(dono)(
      http().post(`/v1/admin/orders/${aberta.body.id}/items`).send({
        tipo: 'service', descricao: 'Corte', quantidade: 1,
        precoUnitarioCents: 10_000, professionalId: outroId,
      }),
    ).expect(201);
    await com(dono)(
      http().post(`/v1/admin/orders/${aberta.body.id}/close`).send({
        pagamentos: [{ forma: 'cash', valorCents: 10_000 }],
      }),
    ).expect(201);

    // O dono vê.
    const doDono = await com(dono)(http().get('/v1/admin/commission')).expect(200);
    expect(doDono.body.linhas).toHaveLength(1);

    // O **outro** barbeiro não vê nada: a venda não foi dele.
    const { token: doOutro } = await barbeiroComConta(dono, 1);
    const dele = await com(doOutro)(http().get('/v1/admin/commission/mine')).expect(200);
    expect(dele.body.linhas).toEqual([]);

    // E o que executou vê a própria, sem segundo fator nenhum.
    const { token: doExecutor } = await barbeiroComConta(dono, 0);
    const dela = await com(doExecutor)(http().get('/v1/admin/commission/mine')).expect(200);
    expect(dela.body.linhas).toHaveLength(1);
    expect(dela.body.totalComissaoCents).toBe(4_000);
  });

  it('o barbeiro não fecha o período nem mexe nas regras', async () => {
    const dono = await abrirBarbearia();
    const { token } = await barbeiroComConta(dono);

    await com(token)(http().get('/v1/admin/commission/rules')).expect(403);
    await com(token)(
      http().put('/v1/admin/commission/rules').send({ modo: 'percent', valor: 9000 }),
    ).expect(403);
    await com(token)(
      http().post('/v1/admin/commission/closures').send({ de: '2026-09-01', ate: '2026-09-30' }),
    ).expect(403);
  });

  it('mexer em regra de comissão exige segundo fator', async () => {
    // `commission.edit_rules` muda quanto cada um recebe: entrou no grupo de
    // dinheiro no bloco 19, pelo mesmo motivo que `cashier.withdraw` no 18.
    const dono = await abrirBarbearia();
    const recusa = await com(dono)(
      http().put('/v1/admin/commission/rules').send({ modo: 'percent', valor: 4000 }),
    ).expect(403);
    expect(recusa.body.error.code).toBe('mfa_setup_required');
  });

  it('alíquota fracionária é recusada na borda', async () => {
    // Pontos-base inteiros: 40% é 4000. Aceitar 0.4 poria ponto flutuante na
    // única porta que ainda não tinha.
    const dono = await abrirBarbearia();
    await comSegundoFator(dono);
    await com(dono)(
      http().put('/v1/admin/commission/rules').send({ modo: 'percent', valor: 40.5 }),
    ).expect(400);
  });

  /**
   * A taxa do adquirente (bloco 36).
   *
   * Ela muda quanto o barbeiro recebe quando o rateio está ligado — então tem
   * exatamente a mesma porta da regra de comissão, e não a de "ver dinheiro".
   */
  it('a alíquota do adquirente é rota de dinheiro: sem segundo fator, recusa', async () => {
    const dono = await abrirBarbearia();
    const recusa = await com(dono)(
      http().put('/v1/admin/commission/fees').send({ forma: 'credit', bps: 319 }),
    ).expect(403);
    expect(recusa.body.error.code).toBe('mfa_setup_required');
  });

  it('o barbeiro não vê nem muda a alíquota do adquirente', async () => {
    const dono = await abrirBarbearia();
    const { token } = await barbeiroComConta(dono);

    await com(token)(http().get('/v1/admin/commission/fees')).expect(403);
    await com(token)(
      http().put('/v1/admin/commission/fees').send({ forma: 'credit', bps: 319 }),
    ).expect(403);
  });

  it('alíquota absurda é recusada na borda, antes do banco', async () => {
    // 3,19 virando 319 é o erro de digitação plausível, e o estrago seria a
    // comissão do mês inteiro de todo mundo.
    const dono = await abrirBarbearia();
    await comSegundoFator(dono);

    await com(dono)(
      http().put('/v1/admin/commission/fees').send({ forma: 'credit', bps: 31900 }),
    ).expect(400);
    await com(dono)(
      http().put('/v1/admin/commission/fees').send({ forma: 'credit', bps: -1 }),
    ).expect(400);
    // Pontos-base inteiros, como toda alíquota do produto.
    await com(dono)(
      http().put('/v1/admin/commission/fees').send({ forma: 'credit', bps: 31.9 }),
    ).expect(400);
  });

  it('meio de pagamento inventado não passa da borda', async () => {
    const dono = await abrirBarbearia();
    await comSegundoFator(dono);
    await com(dono)(
      http().put('/v1/admin/commission/fees').send({ forma: 'boleto', bps: 319 }),
    ).expect(400);
  });

  it('a alíquota salva volta na leitura, e some quando zerada', async () => {
    const dono = await abrirBarbearia();
    await comSegundoFator(dono);

    await com(dono)(
      http().put('/v1/admin/commission/fees').send({ forma: 'credit', bps: 319 }),
    ).expect(200);
    const lida = await com(dono)(http().get('/v1/admin/commission/fees')).expect(200);
    expect(lida.body.aliquotas).toEqual([{ forma: 'credit', bps: 319 }]);

    // Zero apaga a linha: guardar zero explícito e ausência como coisas
    // diferentes criaria duas maneiras de dizer a mesma coisa.
    await com(dono)(
      http().put('/v1/admin/commission/fees').send({ forma: 'credit', bps: 0 }),
    ).expect(200);
    const vazia = await com(dono)(http().get('/v1/admin/commission/fees')).expect(200);
    expect(vazia.body.aliquotas).toEqual([]);
  });

  it('a alíquota de uma barbearia não aparece na outra', async () => {
    const dono = await abrirBarbearia();
    await comSegundoFator(dono);
    await com(dono)(
      http().put('/v1/admin/commission/fees').send({ forma: 'credit', bps: 319 }),
    ).expect(200);

    const rival = await abrirBarbearia(RIVAL);
    await comSegundoFator(rival);
    const dela = await com(rival)(http().get('/v1/admin/commission/fees')).expect(200);
    expect(dela.body.aliquotas).toEqual([]);
  });

  it('modo por faixas sem faixa nenhuma não passa da borda', async () => {
    const dono = await abrirBarbearia();
    await comSegundoFator(dono);
    await com(dono)(
      http().put('/v1/admin/commission/rules').send({ modo: 'tiers', valor: 0, faixas: [] }),
    ).expect(400);
  });

  it('fechar o mesmo período duas vezes é 409, não silêncio', async () => {
    const dono = await abrirBarbearia();
    await comSegundoFator(dono);
    await abrirCaixa(dono).expect(201);
    await com(dono)(
      http().put('/v1/admin/commission/rules').send({ modo: 'percent', valor: 4000 }),
    ).expect(200);

    const catalogo = await com(dono)(http().get('/v1/admin/catalog')).expect(200);
    const aberta = await com(dono)(http().post('/v1/admin/orders').send({})).expect(201);
    await com(dono)(
      http().post(`/v1/admin/orders/${aberta.body.id}/items`).send({
        tipo: 'service', descricao: 'Corte', quantidade: 1, precoUnitarioCents: 10_000,
        professionalId: catalogo.body.professionals[0].id,
      }),
    ).expect(201);
    const paga = await com(dono)(
      http().post(`/v1/admin/orders/${aberta.body.id}/close`).send({
        pagamentos: [{ forma: 'cash', valorCents: 10_000 }],
      }),
    ).expect(201);
    expect(paga.body.status).toBe('paid');

    // O período do mês da venda, resolvido pelo extrato padrão.
    const extrato = await com(dono)(http().get('/v1/admin/commission')).expect(200);
    const periodo = { de: extrato.body.de, ate: extrato.body.ate };

    await com(dono)(http().post('/v1/admin/commission/closures').send(periodo)).expect(201);
    const segunda = await com(dono)(
      http().post('/v1/admin/commission/closures').send(periodo),
    ).expect(409);
    expect(segunda.body.error.code).toBe('periodo_ja_fechado');
  });

  it('a comissão de uma barbearia não aparece na outra', async () => {
    const dono = await abrirBarbearia();
    await comSegundoFator(dono);
    await com(dono)(
      http().put('/v1/admin/commission/rules').send({ modo: 'percent', valor: 4000 }),
    ).expect(200);

    const rival = await abrirBarbearia(RIVAL);
    await comSegundoFator(rival);
    const dela = await com(rival)(http().get('/v1/admin/commission/rules')).expect(200);
    expect(dela.body.regras).toEqual([]);
  });

  it('ler a folha inteira exige segundo fator; o próprio holerite não', async () => {
    /**
     * O defeito que a `/security-review` encontrou neste bloco.
     *
     * Havia uma rota só, declarando `commission.view_own` e decidindo por
     * dentro se devolvia a folha da casa. A `PermissaoGuard` deriva a exigência
     * de segundo fator da permissão **declarada** — então a rota era liberada
     * pela permissão barata e servia o dado da cara: o dono lia quanto cada
     * barbeiro ganhou, sem código nenhum, com a sessão do balcão.
     */
    const dono = await abrirBarbearia();

    const folha = await com(dono)(http().get('/v1/admin/commission')).expect(403);
    expect(folha.body.error.code).toBe('mfa_setup_required');

    const fechamentos = await com(dono)(http().get('/v1/admin/commission/closures')).expect(403);
    expect(fechamentos.body.error.code).toBe('mfa_setup_required');

    // E o próprio holerite continua a um toque de distância.
    await com(dono)(http().get('/v1/admin/commission/mine')).expect(200);
    await com(dono)(http().get('/v1/admin/commission/mine/closures')).expect(200);
  });

  it('o gerente lê a folha — ele tem view_all e não tem view_own', async () => {
    /**
     * O outro lado do mesmo defeito, e ele não era de segurança: com a rota
     * única exigindo `view_own`, o gerente — que tem `view_all` e **não** tem
     * `view_own` — levava 403 na própria tela que a permissão dele existe para
     * abrir. O controle estava invertido nos dois sentidos.
     */
    const dono = await abrirBarbearia();

    const email = 'gerente@domari.com.br';
    const criada = await com(dono)(
      http().post('/v1/admin/team').send({ name: 'Gerente', email, role: 'manager' }),
    ).expect(201);
    const primeira = await http().post('/v1/admin/login')
      .send({ email, password: criada.body.senhaInicial }).expect(201);
    await com(primeira.body.token)(
      http().put('/v1/admin/me/password')
        .send({ currentPassword: criada.body.senhaInicial, newPassword: 'senha-do-gerente' }),
    ).expect(200);
    const entrou = await http().post('/v1/admin/login')
      .send({ email, password: 'senha-do-gerente' }).expect(201);

    await comSegundoFator(entrou.body.token);
    const folha = await com(entrou.body.token)(http().get('/v1/admin/commission')).expect(200);
    expect(folha.body.linhas).toEqual([]);
  });
});
