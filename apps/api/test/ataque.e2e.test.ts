import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConsoleMessagingProvider } from '@barbearia/identity';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { CatalogoController } from '../src/admin/catalogo.controller.js';
import { FichaController } from '../src/admin/ficha.controller.js';
import { TeamController, MeController } from '../src/admin/team.controller.js';
import { BoardController } from '../src/admin/board.controller.js';
import { AgendaController } from '../src/admin/agenda.controller.js';
import { AvaliacaoController } from '../src/admin/avaliacao.controller.js';
import { MetricaController } from '../src/admin/metrica.controller.js';
import { CaixaController } from '../src/admin/caixa.controller.js';
import { WhatsAppController } from '../src/admin/whatsapp.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { BookingController } from '../src/booking/booking.controller.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';
import { limparBanco } from './limpar.js';

/**
 * O ataque, e não a leitura.
 *
 * As outras suítes provam que o produto **funciona**. Esta prova que ele
 * **recusa** — e a diferença importa porque as duas classes de defeito são
 * diferentes. Uma revisão automatizada lê o código e acha muito; há uma classe
 * que só aparece quando alguém executa o ataque, e é esta:
 *
 * - o id da vizinha aceito por uma chave estrangeira, porque a checagem de
 *   integridade referencial do Postgres **ignora** row security;
 * - o 500 em cima de entrada malformada, que é falta de validação na borda
 *   vestida de erro de servidor;
 * - o campo privilegiado colado no corpo (`role: 'owner'`, `tenantId`), que
 *   nenhum teste de caminho feliz manda;
 * - a resposta que **difere** entre "existe" e "não existe", que transforma uma
 *   rota pública em oráculo de enumeração.
 *
 * Duas barbearias em toda a suíte, de propósito: é o que torna o ataque
 * possível de escrever. E toda recusa é conferida **no banco** — 403 na resposta
 * com a linha alterada seria pior que 200.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

let app: INestApplication;
let admin: PrismaClient;
let tenants: TenantService;

const CASA = {
  name: 'Matheus Cardoso',
  email: 'dono@domari.com.br',
  password: 'senha-bem-comprida',
  phone: '(71) 98888-7777',
  businessName: 'Domari Barber Club',
};

const VIZINHA = {
  name: 'Dono Rival',
  email: 'dono@rival.com.br',
  password: 'outra-senha-comprida',
  phone: '(71) 97777-6666',
  businessName: 'Rival Barbearia',
};

// Sete dias, e não a semana comercial: a semente marca "amanhã", e num sábado
// o motor recusa por não haver jornada — falha do arsenal com cara de recusa do
// produto, e ela só apareceria em dois dias da semana.
const JORNADA = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 540,
  endMinute: 1140,
}));

describeIfDb('ataque: o que o produto precisa recusar', () => {
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
        FichaController,
        TeamController,
        MeController,
        BoardController,
        AgendaController,
        AvaliacaoController,
        MetricaController,
        CaixaController,
        WhatsAppController,
        BookingController,
        AuthController,
      ],
      providers: [
        TenantService,
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
    // O contador do horário reinicia com o banco: sem isto ele passa das 19h da
    // jornada depois de alguns testes, e a recusa do motor vira "falha do
    // produto" numa semente.
    proximoHorario = 9;
  });

  const http = () => request(app.getHttpServer());
  const com = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  async function abrirBarbearia(conta = CASA): Promise<string> {
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
        .send({ professionals: [{ name: 'Ruan Nascimento', schedule: JORNADA }] }),
    ).expect(200);
    await com(token)(http().post('/v1/admin/publish')).expect(201);
    return token;
  }

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
    return { token: entrou.body.token as string, id: criada.body.member.id as string };
  }

  let proximoHorario = 9;
  const amanha = () => new Date(Date.now() + 24 * 3_600_000).toISOString().slice(0, 10);

  /**
   * Um cliente de verdade, criado pelo caminho de verdade.
   *
   * O balcão não tem rota de "cadastrar cliente": ele nasce do agendamento, com
   * nome e telefone. Semear direto no banco produziria um cadastro que o
   * produto nunca cria — e o ataque tem que rodar contra o que existe.
   */
  async function cliente(
    token: string,
    nome: string,
    telefone: string,
    minuto?: string,
  ): Promise<string> {
    // Horário distinto a cada chamada: a constraint anti-overbooking é real, e
    // duas sementes no mesmo minuto morrem nela — falha do arsenal que parece
    // falha do produto.
    const hora = minuto ?? `${String((proximoHorario += 1)).padStart(2, '0')}:00`;
    const profissional: string = (
      await com(token)(http().get('/v1/admin/catalog/professionals')).expect(200)
    ).body.professionals[0].id;
    const servico: string = (
      await com(token)(http().get('/v1/admin/catalog/services')).expect(200)
    ).body.services[0].id;

    const marcado = await com(token)(
      http()
        .post('/v1/admin/appointments')
        .set('Idempotency-Key', `semente-${telefone}-${hora}`)
        .send({
          name: nome,
          phone: telefone,
          professionalId: profissional,
          serviceIds: [servico],
          date: amanha(),
          start: hora,
        }),
    ).expect(201);
    return marcado.body.appointment?.customerId ?? marcado.body.customerId;
  }

  // =========================================================================
  // 1 — IDOR entre barbearias
  // =========================================================================

  it('o id da vizinha não lê, não escreve e não apaga — e o dado dela fica intacto', async () => {
    const casa = await abrirBarbearia(CASA);
    const vizinha = await abrirBarbearia(VIZINHA);

    const servicoDaVizinha: string = (
      await com(vizinha)(http().get('/v1/admin/catalog/services')).expect(200)
    ).body.services[0].id;
    const profissionalDaVizinha: string = (
      await com(vizinha)(http().get('/v1/admin/catalog/professionals')).expect(200)
    ).body.professionals[0].id;

    /**
     * Ler devolve **200 com nada**, e é o certo.
     *
     * A primeira versão deste ataque exigia 403 e ficou vermelha sobre código
     * correto. Um 403 aqui distinguiria "existe na vizinha" de "não existe em
     * lugar nenhum" — o oráculo que o OTP evita respondendo igual. O que
     * importa é o conteúdo: a RLS filtrou, e não veio faixa nenhuma.
     */
    const leitura = await com(casa)(
      http().get(`/v1/admin/catalog/professionals/${profissionalDaVizinha}/schedule`),
    );
    expect(leitura.status).toBeLessThan(500);
    expect(leitura.body.faixas ?? []).toHaveLength(0);

    // Escrever.
    const escrita = await com(casa)(
      http()
        .put(`/v1/admin/catalog/services/${servicoDaVizinha}`)
        .send({ name: 'SEQUESTRADO', priceCents: 1, durationMinutes: 5 }),
    );
    expect([400, 403, 404]).toContain(escrita.status);

    // Desativar — o mais próximo de apagar que o produto tem.
    const desativar = await com(casa)(
      http().put(`/v1/admin/catalog/services/${servicoDaVizinha}/active`).send({ active: false }),
    );
    expect([400, 403, 404]).toContain(desativar.status);

    /**
     * E o dado da vizinha continua **intacto**.
     *
     * Este é o pedaço que a leitura de código não dá: um 403 na resposta com a
     * linha já alterada seria pior que um 200, porque ninguém investigaria.
     */
    const depois = await com(vizinha)(http().get('/v1/admin/catalog/services')).expect(200);
    expect(depois.body.services[0].name).toBe('Corte de cabelo');
    expect(depois.body.services[0].priceCents).toBe(4900);
    expect(depois.body.services[0].active).toBe(true);
  });

  it('a chave estrangeira aceita o id alheio; a aplicação tem que recusar antes', async () => {
    /**
     * O ataque que só o Postgres explica: a checagem de integridade referencial
     * **ignora row security**. `appointment_services.service_id` referencia
     * `services.id`, e a FK aceita o id da vizinha sem reclamar — a política
     * não é consultada. Quem precisa recusar é a aplicação, conferindo o id
     * sob RLS antes de gravar.
     */
    const casa = await abrirBarbearia(CASA);
    const vizinha = await abrirBarbearia(VIZINHA);

    const servicoDaVizinha: string = (
      await com(vizinha)(http().get('/v1/admin/catalog/services')).expect(200)
    ).body.services[0].id;
    const meuProfissional: string = (
      await com(casa)(http().get('/v1/admin/catalog/professionals')).expect(200)
    ).body.professionals[0].id;
    const meuCliente = await cliente(casa, 'Carlos Souza', '(71) 98888-1111');

    const resposta = await com(casa)(
      http()
        .post('/v1/admin/appointments')
        .set('Idempotency-Key', 'ataque-fk-1')
        .send({
          customerId: meuCliente,
          professionalId: meuProfissional,
          serviceIds: [servicoDaVizinha],
          date: amanha(),
          start: '11:00',
        }),
    );
    expect([400, 403, 404, 409, 422]).toContain(resposta.status);
    expect(resposta.status).not.toBe(500);

    // Nada foi gravado com o serviço alheio.
    const vinculos = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM appointment_services WHERE service_id = '${servicoDaVizinha}'`,
    );
    expect(Number(vinculos[0]!.n)).toBe(0);
  });

  it('a ficha do cliente da vizinha não abre pelo id', async () => {
    const casa = await abrirBarbearia(CASA);
    const vizinha = await abrirBarbearia(VIZINHA);
    const clienteDaVizinha = await cliente(vizinha, 'Ana Ribeiro', '(71) 96666-5555');

    /**
     * O que importa é o **conteúdo**, e o código da recusa é secundário: 400,
     * 403 e 404 são todos recusas legítimas, e exigir um deles em particular
     * seria o teste cobrando gosto em vez de regra.
     */
    const resposta = await com(casa)(http().get(`/v1/admin/customers/${clienteDaVizinha}/ficha`));
    expect(resposta.status).toBeGreaterThanOrEqual(400);
    expect(resposta.status).toBeLessThan(500);
    expect(JSON.stringify(resposta.body)).not.toContain('Ana Ribeiro');
    expect(JSON.stringify(resposta.body)).not.toContain('96666');
  });

  // =========================================================================
  // 2 — escalada de privilégio
  // =========================================================================

  it('a recepcionista não se promove, não promove ninguém e não mexe no dono', async () => {
    const dono = await abrirBarbearia(CASA);
    const maria = await recepcionista(dono);

    // Promover a si mesma.
    const auto = await com(maria.token)(
      http().put(`/v1/admin/team/${maria.id}/role`).send({ role: 'manager' }),
    );
    expect([400, 403]).toContain(auto.status);

    // Criar cúmplice com papel alto.
    await com(maria.token)(
      http()
        .post('/v1/admin/team')
        .send({ name: 'Cúmplice', email: 'x@domari.com.br', role: 'manager' }),
    ).expect(403);

    // Mexer nas permissões do papel.
    const permissoes = await com(maria.token)(
      http()
        .put('/v1/admin/team/permissions')
        .send({ role: 'receptionist', permissions: ['finance.view', 'team.manage'] }),
    );
    expect([400, 403, 404]).toContain(permissoes.status);

    // E ela continua sem alcançar o que a permissão guarda.
    const equipe = await com(maria.token)(http().get('/v1/admin/team'));
    expect(equipe.status).toBe(403);
  });

  it('o papel do dono não se cria pelo convite nem se muda pela rota', async () => {
    const dono = await abrirBarbearia(CASA);

    // `owner` no corpo do convite: a borda recusa com enum, não silenciosamente.
    const convite = await com(dono)(
      http()
        .post('/v1/admin/team')
        .send({ name: 'Segundo dono', email: 'dois@domari.com.br', role: 'owner' }),
    );
    expect([400, 403]).toContain(convite.status);

    const donos = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM staff_users WHERE role = 'owner'`,
    );
    expect(Number(donos[0]!.n)).toBe(1);
  });

  it('campo privilegiado colado no corpo é ignorado, nunca obedecido', async () => {
    /**
     * O ataque clássico do guia: injetar `is_superadmin: true` num cadastro.
     * Aqui os equivalentes são o `tenantId` (que decidiria de quem é o dado) e
     * o `role` (que decidiria o poder).
     */
    const dono = await abrirBarbearia(CASA);
    const vizinha = await abrirBarbearia(VIZINHA);

    const tenantDaVizinha = await admin.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM tenants WHERE name = 'Rival Barbearia'`,
    );
    const alvo = tenantDaVizinha[0]!.id;

    const profissional: string = (
      await com(dono)(http().get('/v1/admin/catalog/professionals')).expect(200)
    ).body.professionals[0].id;
    const servico: string = (
      await com(dono)(http().get('/v1/admin/catalog/services')).expect(200)
    ).body.services[0].id;

    await com(dono)(
      http()
        .post('/v1/admin/appointments')
        .set('Idempotency-Key', 'ataque-tenant-1')
        .send({
          name: 'Plantado na vizinha',
          phone: '(71) 95555-4444',
          professionalId: profissional,
          serviceIds: [servico],
          date: amanha(),
          start: '14:00',
          tenantId: alvo,
          tenant_id: alvo,
        }),
    );

    // O cliente não pode ter nascido na barbearia alheia.
    const plantados = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM customers WHERE tenant_id = '${alvo}' AND name = 'Plantado na vizinha'`,
    );
    expect(Number(plantados[0]!.n)).toBe(0);

    // E a vizinha não enxerga nada de novo.
    const dela = await com(vizinha)(http().get('/v1/admin/customers').query({ q: 'Plantado' }));
    expect(JSON.stringify(dela.body)).not.toContain('Plantado na vizinha');
  });

  // =========================================================================
  // 3 — a borda: entrada malformada é 400, nunca 500
  // =========================================================================

  it('entrada malformada devolve 4xx com motivo, nunca 500', async () => {
    /**
     * O guia registra esta cicatriz em letras: `GET /users/<qualquer-coisa>`
     * sem validar o `:id` mandava a string ao banco e devolvia **500**. Um 500
     * em entrada malformada é sempre falta de validação na borda — e ele vaza
     * o interno junto.
     */
    const dono = await abrirBarbearia(CASA);

    const ataques: [string, () => request.Test][] = [
      ['id que não é uuid', () => http().get('/v1/admin/customers/nao-sou-um-uuid/ficha')],
      // Aspas e espaços crus no caminho quebram o cliente HTTP antes de sair da
      // máquina — o ataque de injeção que importa é o do filtro de texto, no
      // teste abaixo. Aqui o que se prova é que o `:id` valida formato.
      ['id com travessia de caminho', () => http().get('/v1/admin/customers/..%2F..%2Fetc%2Fpasswd/ficha')],
      ['id gigante', () => http().get(`/v1/admin/customers/${'9'.repeat(5000)}/ficha`)],
      ['id vazio na ficha', () => http().get('/v1/admin/customers/%20/ficha')],
      [
        'corpo com tipo errado',
        () =>
          http()
            .post('/v1/admin/appointments')
            .send({ name: { $ne: null }, phone: ['a', 'b'], serviceIds: 'nao-e-lista' }),
      ],
      ['corpo vazio', () => http().post('/v1/admin/appointments').send({})],
      [
        'número absurdo',
        () =>
          http()
            .post('/v1/admin/catalog/services')
            .send({ name: 'x', priceCents: Number.MAX_SAFE_INTEGER, durationMinutes: -5 }),
      ],
      [
        'string gigante',
        () =>
          http()
            .post('/v1/admin/catalog/services')
            .send({ name: 'a'.repeat(100_000), priceCents: 100, durationMinutes: 30 }),
      ],
      ['data impossível', () => http().get('/v1/admin/agenda').query({ from: 'ontem', to: '31/02/2026' })],
      ['telefone que não é E.164', () => http().post('/v1/admin/appointments').send({
        name: 'X', phone: '(71) 3333-4444', professionalId: 'x', serviceIds: [], date: 'x', start: 'x',
      })],
    ];

    /**
     * Cada pedido é construído **na hora**, e não numa lista montada antes.
     *
     * `supertest` abre um servidor efêmero por instância: construir os nove de
     * uma vez faz um fechar o do outro, e o teste acusa "conexão recusada" sobre
     * um servidor que está de pé. Foi o que aconteceu na primeira versão, e o
     * relatório culpou o produto por um defeito do arsenal.
     */
    for (const [nome, montar] of ataques) {
      const resposta = await com(dono)(montar()).catch((erro: Error) => {
        throw new Error(`${nome} derrubou a conexão: ${erro.message}`);
      });
      expect(resposta.status, `${nome} devolveu ${resposta.status}`).toBeLessThan(500);
      // E o corpo não pode carregar o interno.
      const corpo = JSON.stringify(resposta.body);
      expect(corpo, `${nome} vazou stack`).not.toMatch(/at .*\.ts:\d+|node_modules|PrismaClient/);
      expect(corpo, `${nome} vazou nome de tabela`).not.toMatch(/relation "|column "/);
    }
  });

  it('injeção de SQL num filtro de texto devolve zero, nunca a tabela toda', async () => {
    const dono = await abrirBarbearia(CASA);
    await cliente(dono, 'Carlos Souza', '(71) 98888-1111');
    await cliente(dono, 'Bruno Lima', '(71) 97777-2222');

    for (const carga of ["' OR '1'='1", "'; DROP TABLE customers; --", "%' OR 1=1 --", "\\'"]) {
      const resposta = await com(dono)(http().get('/v1/admin/customers').query({ q: carga }));
      expect(resposta.status).toBeLessThan(500);
      const achados = resposta.body?.customers ?? [];
      expect(achados.length, `"${carga}" devolveu ${achados.length} clientes`).toBe(0);
    }

    // E a tabela continua de pé.
    const vivos = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM customers`,
    );
    expect(Number(vivos[0]!.n)).toBe(2);
  });

  // =========================================================================
  // 4 — sessão
  // =========================================================================

  it('token forjado, adulterado ou de outra casa é 401', async () => {
    const casa = await abrirBarbearia(CASA);
    const vizinha = await abrirBarbearia(VIZINHA);

    const [tenantDaCasa, segredo] = casa.split('.');

    for (const [nome, token] of [
      ['inventado', 'nao-e-token-nenhum'],
      ['vazio', ''],
      ['só o tenant', `${tenantDaCasa}.`],
      ['segredo trocado', `${tenantDaCasa}.${'a'.repeat((segredo ?? '').length)}`],
      // O corte que interessa: o segredo é real, o tenant é o da vizinha.
      ['tenant trocado', `${vizinha.split('.')[0]}.${segredo}`],
    ] as const) {
      const resposta = await http()
        .get('/v1/admin/state')
        .set('Authorization', `Bearer ${token}`);
      expect(resposta.status, `token ${nome} devolveu ${resposta.status}`).toBe(401);
    }
  });

  it('trocar a senha derruba a OUTRA sessão, e mantém a de quem trocou', async () => {
    /**
     * Trocar a senha é o que a pessoa faz quando desconfia, e a sessão roubada
     * é a que precisa cair. A **dela** é preservada de propósito: derrubar quem
     * acabou de digitar a senha certa obrigaria a entrar de novo sem motivo.
     *
     * A primeira versão deste ataque cobrava o contrário e ficou vermelha sobre
     * código correto — o `CLAUDE.md` diz "revoga todas" e o código diz
     * "todas menos a minha". Quem estava errado era a frase.
     */
    const dono = await abrirBarbearia(CASA);
    const maria = await recepcionista(dono);

    // A segunda sessão: o navegador do atacante.
    const roubada = (
      await http()
        .post('/v1/admin/login')
        .send({ email: 'maria@domari.com.br', password: 'a-senha-dela-agora' })
        .expect(201)
    ).body.token as string;
    await com(roubada)(http().get('/v1/admin/day')).expect(200);

    await com(maria.token)(
      http()
        .put('/v1/admin/me/password')
        .send({ currentPassword: 'a-senha-dela-agora', newPassword: 'terceira-senha-comprida' }),
    ).expect(200);

    expect((await com(roubada)(http().get('/v1/admin/day'))).status).toBe(401);
    expect((await com(maria.token)(http().get('/v1/admin/day'))).status).toBe(200);
  });

  // =========================================================================
  // 5 — enumeração
  // =========================================================================

  it('a rota pública responde igual para telefone que existe e que não existe', async () => {
    /**
     * Com uma lista de números se descobre quem é cliente de quem. A resposta
     * tem que ser indistinguível — corpo **e** status.
     */
    const dono = await abrirBarbearia(CASA);
    await cliente(dono, 'Carlos Souza', '(71) 98888-1111');

    const existe = await http()
      .post('/v1/b/domari-barber-club/auth/otp')
      .send({ phone: '(71) 98888-1111' });
    const naoExiste = await http()
      .post('/v1/b/domari-barber-club/auth/otp')
      .send({ phone: '(71) 91234-5678' });

    expect(existe.status).toBe(naoExiste.status);
    expect(existe.body).toEqual(naoExiste.body);
  });

  it('o login responde igual para conta que existe e que não existe', async () => {
    await abrirBarbearia(CASA);

    const existe = await http()
      .post('/v1/admin/login')
      .send({ email: CASA.email, password: 'senha-errada-mas-comprida' });
    const naoExiste = await http()
      .post('/v1/admin/login')
      .send({ email: 'ninguem@lugar-nenhum.com.br', password: 'senha-errada-mas-comprida' });

    expect(existe.status).toBe(naoExiste.status);
    expect(existe.body.error?.code).toBe(naoExiste.body.error?.code);
    expect(existe.body.error?.message).toBe(naoExiste.body.error?.message);
  });

  // =========================================================================
  // 6 — sem sessão não se alcança nada do painel
  // =========================================================================

  it('nenhuma rota do painel responde sem sessão', async () => {
    await abrirBarbearia(CASA);

    const rotas = [
      '/v1/admin/state',
      '/v1/admin/day',
      '/v1/admin/team',
      '/v1/admin/customers',
      '/v1/admin/catalog/services',
      '/v1/admin/catalog/professionals',
      '/v1/admin/agenda',
      '/v1/admin/avaliacoes',
    ];

    for (const rota of rotas) {
      const resposta = await http().get(rota);
      expect(resposta.status, `${rota} respondeu ${resposta.status} sem sessão`).toBe(401);
    }
  });

  // =========================================================================
  // 7 — os achados da revisão, reproduzidos
  //
  // Cada um destes ficou vermelho quando foi escrito. É a diferença entre
  // "a revisão disse" e "eu vi acontecer" — e é a única forma de saber que o
  // conserto consertou.
  // =========================================================================

  it('o assistente não entrega faturamento sem o segundo fator', async () => {
    /**
     * O piso baixo do assistente é decisão escrita e certa: quem decide é o
     * catálogo, métrica por métrica. O que ninguém viu é que **outras duas**
     * decisões da guarda saem do mesmo `@Exige` — o segundo fator e o limite da
     * sessão de suporte. Com `appointments.view` declarado, `mexeEmDinheiro` é
     * falso e a cobrança de TOTP nem chega a acontecer.
     *
     * A rota do DRE, ao lado, cobra. É o mesmo dinheiro.
     */
    const dono = await abrirBarbearia(CASA);
    const tenantId = (
      await admin.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM tenants WHERE name = 'Domari Barber Club'`,
      )
    )[0]!.id;
    await admin.$executeRawUnsafe(
      `UPDATE tenants SET require_mfa_for_money = true WHERE id = '${tenantId}'`,
    );

    // A sessão do dono não tem prova de segundo fator: ele acabou de entrar.
    const pergunta = await com(dono)(
      http().post('/v1/admin/metricas/perguntar').send({
        metrica: 'faturamento',
        dimensao: 'profissional',
        de: '2026-01-01',
        ate: '2026-08-14',
      }),
    );

    expect(
      pergunta.status,
      `o assistente devolveu ${pergunta.status} — faturamento sem TOTP`,
    ).toBe(403);
    expect(['mfa_required', 'mfa_setup_required']).toContain(pergunta.body.error?.code);
  });

  it('quem recebe team.manage não se promove ao papel que ele não alcança', async () => {
    /**
     * "Ninguém concede o que não tem" está escrito e implementado em
     * `definirPermissoesDoPapel` — e **não** em `changeStaffRole`. Atribuir um
     * papel é conceder o conjunto inteiro dele de uma vez: é a mesma concessão,
     * pela porta ao lado.
     *
     * O cenário é a configuração que o produto passou a suportar no bloco 30: o
     * dono delega a gestão de contas para a recepção.
     */
    const dono = await abrirBarbearia(CASA);
    const maria = await recepcionista(dono);

    // O dono delega a gestão de contas — pela tela, como o produto oferece.
    const daRecepcao: string[] = (
      await com(dono)(http().get('/v1/admin/team')).expect(200)
    ).body.permissionsByRole.receptionist;
    await com(dono)(
      http()
        .put('/v1/admin/team/permissoes/receptionist')
        .send({ permissoes: [...daRecepcao, 'team.manage'] }),
    ).expect(200);

    // Ela não tem `finance.view` — a guarda do bloco 30 recusa concedê-la.
    await com(maria.token)(
      http()
        .put('/v1/admin/team/permissoes/receptionist')
        .send({ permissoes: [...daRecepcao, 'finance.view'] }),
    ).expect(403);

    // E não pode alcançá-la pelo papel, que é a mesma concessão em atacado.
    const promovida = await com(maria.token)(
      http().put(`/v1/admin/team/${maria.id}/role`).send({ role: 'manager' }),
    );
    expect(
      promovida.status,
      `a recepcionista virou gerente com ${promovida.status}`,
    ).toBe(403);

    const papel = await admin.$queryRawUnsafe<{ role: string }[]>(
      `SELECT role FROM staff_users WHERE id = '${maria.id}'`,
    );
    expect(papel[0]!.role).toBe('receptionist');
  });

  it('uma barbearia não sequestra o número de WhatsApp da outra', async () => {
    /**
     * `whatsapp_numbers` é a tabela de roteamento do webhook da Meta e não tem
     * RLS — o webhook chega antes de existir tenant no contexto, e isso está
     * certo. O que faltou foi a **outra metade** do precedente de
     * `tenant_slugs`: leitura pública, escrita restrita. O `ON CONFLICT DO
     * UPDATE` é incondicional, então a segunda barbearia a reivindicar o número
     * leva o roteamento — e com ele as mensagens dos clientes da primeira.
     */
    const casa = await abrirBarbearia(CASA);
    const vizinha = await abrirBarbearia(VIZINHA);

    const numero = '15550001111';
    await com(casa)(
      http().put('/v1/admin/whatsapp/cadastro').send({ phoneNumberId: numero, wabaId: '999888777' }),
    ).expect(200);

    const daCasa = (
      await admin.$queryRawUnsafe<{ tenant_id: string }[]>(
        `SELECT tenant_id FROM whatsapp_numbers WHERE phone_number_id = '${numero}'`,
      )
    )[0]!.tenant_id;

    // A vizinha reivindica o mesmo número.
    const roubo = await com(vizinha)(
      http().put('/v1/admin/whatsapp/cadastro').send({ phoneNumberId: numero, wabaId: '111222333' }),
    );

    const depois = (
      await admin.$queryRawUnsafe<{ tenant_id: string }[]>(
        `SELECT tenant_id FROM whatsapp_numbers WHERE phone_number_id = '${numero}'`,
      )
    )[0]!.tenant_id;

    expect(
      depois,
      `o roteamento mudou de dono (resposta ${roubo.status}) — as mensagens dos clientes da casa passam a cair na vizinha`,
    ).toBe(daCasa);
  });

  it('o nome da barbearia chega na mensagem do código', async () => {
    /**
     * Não é ataque, é o mesmo defeito por outro caminho: `nameOf` consulta
     * `tenants` **fora** de `withTenant`, e `tenants` tem `FORCE ROW LEVEL
     * SECURITY` sem política de leitura pública. Sem tenant no contexto a
     * consulta devolve zero linhas **em silêncio**, e todo OTP sai como "Seu
     * código para Barbearia".
     *
     * O silêncio é o ponto: nada falha, nada loga, e o defeito só aparece no
     * celular de quem está tentando entrar.
     */
    await abrirBarbearia(CASA);

    const pedido = await http()
      .post('/v1/b/domari-barber-club/auth/otp')
      .send({ phone: '(71) 98888-1111' });
    expect(pedido.status).toBeLessThan(400);

    const nome = await tenants.nameOf(
      (
        await admin.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM tenants WHERE name = 'Domari Barber Club'`,
        )
      )[0]!.id,
    );
    expect(nome, 'a mensagem do código sai sem o nome da casa').toBe('Domari Barber Club');
  });

  it('a recepcionista não reprecifica o item para contornar o teto de desconto', async () => {
    /**
     * `finance.discount` diz **quem** pode descontar; `tenants.max_discount_bps`
     * diz **quanto**. A recepcionista não tem a primeira e a casa configurou a
     * segunda — e as duas são contornáveis pela porta ao lado: remover o item
     * que veio do agendamento e acrescentar o mesmo serviço com o preço que se
     * quiser. As duas rotas são `cashier.open`, que ela tem.
     *
     * Aritmeticamente é o mesmo desconto. A diferença é que nenhum
     * `discount_cents` é escrito, então o teto nunca é conferido e a trilha
     * registra `order.closed` de uma comanda de R$ 1,00 — indistinguível de uma
     * venda legítima de R$ 1,00.
     *
     * É o defeito que o bloco 30 fechou (inflar, descontar o teto, apagar a
     * linha) reaparecendo por um caminho que não passa por `discount_cents`.
     * `packageId` e `productId` já leem o preço do catálogo dentro da transação
     * exatamente por isso; `service` é o único tipo que não lê.
     */
    const dono = await abrirBarbearia(CASA);
    const maria = await recepcionista(dono);

    const tenantId = (
      await admin.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM tenants WHERE name = 'Domari Barber Club'`,
      )
    )[0]!.id;
    // Teto de 20%: a casa decidiu que ninguém tira mais que isso.
    await admin.$executeRawUnsafe(
      `UPDATE tenants SET max_discount_bps = 2000 WHERE id = '${tenantId}'`,
    );

    const servico: string = (
      await com(dono)(http().get('/v1/admin/catalog/services')).expect(200)
    ).body.services[0].id;

    await com(maria.token)(http().post('/v1/admin/cash/open').send({ openingCents: 10000 })).expect(
      201,
    );
    const abertura = await com(maria.token)(http().post('/v1/admin/orders').send({})).expect(201);
    const comandaId: string = abertura.body.id ?? abertura.body.order?.id;

    // O item legítimo, pelo preço do catálogo.
    await com(maria.token)(
      http().post(`/v1/admin/orders/${comandaId}/items`).send({
        tipo: 'service',
        serviceId: servico,
        descricao: 'Corte de cabelo',
        quantidade: 1,
        precoUnitarioCents: 4900,
      }),
    ).expect(201);

    // O desconto pela porta da frente é recusado: ela não tem `finance.discount`.
    const pelaFrente = await com(maria.token)(
      http()
        .patch(`/v1/admin/orders/${comandaId}`)
        .send({ desconto: { tipo: 'valor', valorCents: 4800, motivo: 'cortesia da casa' } }),
    );
    expect([403, 404]).toContain(pelaFrente.status);

    // A porta lateral: o mesmo serviço, por R$ 1,00.
    const reprecificado = await com(maria.token)(
      http().post(`/v1/admin/orders/${comandaId}/items`).send({
        tipo: 'service',
        serviceId: servico,
        descricao: 'Corte de cabelo',
        quantidade: 1,
        precoUnitarioCents: 100,
      }),
    );

    if (reprecificado.status >= 400) return; // recusado na borda: é o que se quer

    const total = (
      await admin.$queryRawUnsafe<{ subtotal_cents: number; discount_cents: number }[]>(
        `SELECT subtotal_cents, discount_cents FROM orders WHERE id = '${comandaId}'`,
      )
    )[0]!;

    /**
     * O preço do item de serviço tem que sair do catálogo, como o de pacote e o
     * de produto — e qualquer diferença é desconto, sujeita ao teto, à permissão
     * e à trilha.
     */
    expect(
      Number(total.subtotal_cents),
      `o item entrou por ${total.subtotal_cents} — o catálogo diz 4900, e nenhum desconto foi registrado (${total.discount_cents})`,
    ).toBe(4900 + 4900);
  });
});
