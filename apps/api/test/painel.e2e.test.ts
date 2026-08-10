import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConsoleMessagingProvider, codigoDoPasso, passoAgora } from '@barbearia/identity';
import { PainelController } from '../src/admin/painel.controller.js';
import { MfaController } from '../src/admin/mfa.controller.js';
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
 * O painel, o validador de catálogo e a trilha pela HTTP.
 *
 * A pergunta que só se responde aqui é a **separação**: o número operacional e
 * o número de dinheiro saem em rotas diferentes porque as permissões são
 * diferentes, e a exigência de segundo fator é derivada do `@Exige`. Se alguém
 * um dia juntar as duas numa rota só "para economizar uma chamada", a recepção
 * passa a ver o faturamento sem MFA e nada mais nesta suíte reclamaria — menos
 * o teste que confere que `/dashboard` responde e `/dashboard/revenue` não.
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
  startMinute: 540,
  endMinute: 1140,
}));

describeIfDb('painel, diagnóstico e trilha pela HTTP', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    process.env['MFA_SECRET_KEY'] = Buffer.alloc(32, 7).toString('base64');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [
        StaffAuthController,
        OnboardingController,
        PainelController,
        MfaController,
        TeamController,
        MeController,
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

    /**
     * A barbearia nasce **sem** exigir o segundo fator desde a migração 0039.
     * Esta suíte descreve uma que exige — então ela liga a política, que é o
     * que o dono faria em `/admin/seguranca`. Ligar não pede código: com a
     * política desligada a guarda não cobra nada, inclusive esta rota.
     */
    await com(token)(
      http().put('/v1/admin/mfa/policy').send({ obrigatorio: true }),
    ).expect(200);

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

  /** Liga o segundo fator e o prova para esta sessão. */
  async function comSegundoFator(token: string): Promise<void> {
    const inicio = await com(token)(http().post('/v1/admin/mfa/setup')).expect(201);
    const segredo: string = inicio.body.segredoBase32;
    const passo = passoAgora(new Date());

    await com(token)(
      http().post('/v1/admin/mfa/confirm').send({ codigo: codigoDoPasso(segredo, passo) }),
    ).expect(201);
    await com(token)(
      http().post('/v1/admin/mfa/verify').send({ codigo: codigoDoPasso(segredo, passo + 1) }),
    ).expect(201);
  }

  /** Cria uma conta de equipe, troca a senha de primeiro acesso e devolve a sessão. */
  async function conta(dono: string, papel: string, nome: string, email: string): Promise<string> {
    const criada = await com(dono)(
      http().post('/v1/admin/team').send({ name: nome, email, role: papel }),
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

  // -- quem pode ler ----------------------------------------------------------

  it('sem sessão não se lê painel, diagnóstico nem trilha', async () => {
    await http().get('/v1/admin/dashboard').expect(401);
    await http().get('/v1/admin/dashboard/revenue').expect(401);
    await http().get('/v1/admin/catalog/diagnosis').expect(401);
    await http().get('/v1/admin/audit').expect(401);
    await http().get('/v1/admin/audit/finance').expect(401);
  });

  it('a recepcionista não lê nenhuma das cinco', async () => {
    const dono = await abrirBarbearia();
    const maria = await conta(dono, 'receptionist', 'Maria Recepção', 'maria@domari.com.br');

    await com(maria)(http().get('/v1/admin/dashboard')).expect(403);
    await com(maria)(http().get('/v1/admin/dashboard/revenue')).expect(403);
    await com(maria)(http().get('/v1/admin/catalog/diagnosis')).expect(403);
    await com(maria)(http().get('/v1/admin/audit')).expect(403);
    await com(maria)(http().get('/v1/admin/audit/finance')).expect(403);
  });

  it('a gerente lê a operação, o cadastro e a trilha de gestão', async () => {
    const dono = await abrirBarbearia();
    const gerente = await conta(dono, 'manager', 'Aline Gerente', 'aline@domari.com.br');

    await com(gerente)(http().get('/v1/admin/dashboard')).expect(200);
    await com(gerente)(http().get('/v1/admin/catalog/diagnosis')).expect(200);
    await com(gerente)(http().get('/v1/admin/audit')).expect(200);
  });

  // -- a separação entre operação e dinheiro ----------------------------------

  it('o dono vê a operação sem segundo fator e o dinheiro só com ele', async () => {
    const dono = await abrirBarbearia();

    // Ter todas as permissões não basta: `finance.view` está no grupo do
    // dinheiro, e a exigência sai da permissão declarada na rota.
    await com(dono)(http().get('/v1/admin/dashboard')).expect(200);

    const recusa = await com(dono)(http().get('/v1/admin/dashboard/revenue')).expect(403);
    expect(recusa.body.error.code).toBe('mfa_setup_required');

    await comSegundoFator(dono);
    const dinheiro = await com(dono)(http().get('/v1/admin/dashboard/revenue')).expect(200);
    expect(dinheiro.body).toMatchObject({
      faturamentoCents: { valor: 0, anterior: 0, variacao: null },
      ticketMedioCents: { valor: 0 },
    });
  });

  it('a gerente tem finance.view e mesmo assim precisa do segundo fator', async () => {
    const dono = await abrirBarbearia();
    const gerente = await conta(dono, 'manager', 'Aline Gerente', 'aline@domari.com.br');

    const recusa = await com(gerente)(http().get('/v1/admin/dashboard/revenue')).expect(403);
    expect(recusa.body.error.code).toBe('mfa_setup_required');
  });

  /**
   * O defeito que a `/security-review` encontrou neste bloco, virado teste.
   *
   * A trilha inteira sob `settings.manage` entregava o fechamento do caixa, o
   * desconto e o total da folha **sem segundo fator** — para a mesma conta
   * barrada em `/dashboard/revenue` na linha de cima. A justificativa escrita na
   * época ("a trilha guarda quem fez o quê, nunca a senha de ninguém") conferia
   * a categoria errada: a trilha guarda *quanto*.
   */
  it('a trilha de gestão não entrega dinheiro, e a de dinheiro exige o segundo fator', async () => {
    const dono = await abrirBarbearia();
    const gerente = await conta(dono, 'manager', 'Aline Gerente', 'aline@domari.com.br');

    const recusa = await com(gerente)(http().get('/v1/admin/audit/finance')).expect(403);
    expect(recusa.body.error.code).toBe('mfa_setup_required');

    const gestao = await com(gerente)(http().get('/v1/admin/audit')).expect(200);
    for (const evento of gestao.body.entries) {
      expect(evento.action).not.toMatch(/^(cash|order|debt|commission)\./);
      // A prova sem depender da lista: nenhum valor em centavos atravessa.
      expect(JSON.stringify([evento.before, evento.after])).not.toMatch(/Cents/);
    }
  });

  it('com o segundo fator provado, o dono lê a trilha do dinheiro', async () => {
    const dono = await abrirBarbearia();
    await comSegundoFator(dono);

    const dinheiro = await com(dono)(http().get('/v1/admin/audit/finance')).expect(200);
    for (const evento of dinheiro.body.entries) {
      expect(evento.action).toMatch(/^(cash|order|debt|commission)\./);
    }

    // E a de gestão continua sendo a outra metade: `mfa.enabled` acabou de ser
    // gravada e só pode aparecer lá.
    const gestao = await com(dono)(http().get('/v1/admin/audit')).expect(200);
    const acoes = gestao.body.entries.map((evento: { action: string }) => evento.action);
    expect(acoes).toContain('mfa.enabled');
  });

  // -- o dia é da unidade, e é conferido --------------------------------------

  it('compara com o mesmo dia da semana anterior', async () => {
    const dono = await abrirBarbearia();

    const painel = await com(dono)(http().get('/v1/admin/dashboard?dia=2026-03-14')).expect(200);
    expect(painel.body.dia).toBe('2026-03-14');
    expect(painel.body.comparadoCom).toBe('2026-03-07');
  });

  it('sem dia pedido, responde o dia da unidade', async () => {
    const dono = await abrirBarbearia();

    const painel = await com(dono)(http().get('/v1/admin/dashboard')).expect(200);
    expect(painel.body.dia).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A comparação é sempre sete dias atrás, o que também prova que o dia veio
    // resolvido e não ficou nulo.
    const distancia =
      (Date.parse(`${painel.body.dia}T00:00:00Z`) -
        Date.parse(`${painel.body.comparadoCom}T00:00:00Z`)) /
      86_400_000;
    expect(distancia).toBe(7);
  });

  it('data que não existe no calendário morre na borda, não no banco', async () => {
    const dono = await abrirBarbearia();

    await com(dono)(http().get('/v1/admin/dashboard?dia=2026-99-01')).expect(400);
    await com(dono)(http().get('/v1/admin/dashboard?dia=2026-02-30')).expect(400);
    await com(dono)(http().get('/v1/admin/dashboard?dia=ontem')).expect(400);
  });

  it('a ocupação de um dia sem jornada é zero, não erro de divisão', async () => {
    const dono = await abrirBarbearia();
    const painel = await com(dono)(http().get('/v1/admin/dashboard?dia=2026-03-14')).expect(200);

    expect(painel.body.ocupacao.valor).toBe(0);
    expect(painel.body.noShow.valor).toBe(0);
  });

  // -- o validador de catálogo ------------------------------------------------

  it('acha o que o onboarding deixou incompleto e diz o conserto', async () => {
    const dono = await abrirBarbearia();

    const resposta = await com(dono)(http().get('/v1/admin/catalog/diagnosis')).expect(200);
    expect(resposta.body.examinados).toBe(1);

    // O serviço do onboarding entra sem descrição nem foto: é exatamente o D5
    // ("página sem informação") e o validador tem que enxergá-lo.
    const regras = resposta.body.achados.map((achado: { regra: string }) => achado.regra);
    expect(regras).toContain('V6');
    for (const achado of resposta.body.achados) {
      expect(achado.conserto.length).toBeGreaterThan(0);
      expect(['bloqueia', 'publicacao', 'aviso']).toContain(achado.severidade);
    }

    const soma = resposta.body.resumo.bloqueia + resposta.body.resumo.publicacao + resposta.body.resumo.aviso;
    expect(soma).toBe(resposta.body.achados.length);
  });

  // -- a trilha ---------------------------------------------------------------

  it('a trilha mostra quem criou a conta, com o antes e o depois do papel', async () => {
    const dono = await abrirBarbearia();
    await conta(dono, 'receptionist', 'Maria Recepção', 'maria@domari.com.br');

    const trilha = await com(dono)(http().get('/v1/admin/audit')).expect(200);
    const criacao = trilha.body.entries.find(
      (evento: { action: string }) => evento.action === 'staff.created',
    );

    expect(criacao).toBeDefined();
    expect(criacao.actorName).toBe(DONO.name);
    expect(criacao.after).toMatchObject({ role: 'receptionist' });
  });

  it('página curta não oferece página seguinte', async () => {
    const dono = await abrirBarbearia();
    await conta(dono, 'receptionist', 'Maria Recepção', 'maria@domari.com.br');

    const trilha = await com(dono)(http().get('/v1/admin/audit')).expect(200);
    expect(trilha.body.entries.length).toBeLessThan(50);
    expect(trilha.body.proximoCursor).toBeNull();
  });

  it('o cursor anda para trás e não repete o que já foi lido', async () => {
    const dono = await abrirBarbearia();
    await conta(dono, 'receptionist', 'Maria Recepção', 'maria@domari.com.br');
    await conta(dono, 'manager', 'Aline Gerente', 'aline@domari.com.br');

    const primeira = await com(dono)(http().get('/v1/admin/audit')).expect(200);
    const maisNovo: string = primeira.body.entries[0].id;

    const segunda = await com(dono)(http().get(`/v1/admin/audit?antesDe=${maisNovo}`)).expect(200);
    const ids = segunda.body.entries.map((evento: { id: string }) => evento.id);
    expect(ids).not.toContain(maisNovo);
    expect(BigInt(ids[0])).toBeLessThan(BigInt(maisNovo));
  });

  it('cursor que não é número é recusado na borda', async () => {
    const dono = await abrirBarbearia();
    await com(dono)(http().get('/v1/admin/audit?antesDe=1;DROP')).expect(400);
    await com(dono)(http().get('/v1/admin/audit?antesDe=-1')).expect(400);
  });

  it('a trilha de uma barbearia não aparece na da outra', async () => {
    const dono = await abrirBarbearia();
    await conta(dono, 'receptionist', 'Maria Recepção', 'maria@domari.com.br');

    const rival = await abrirBarbearia(RIVAL);
    const dela = await com(rival)(http().get('/v1/admin/audit')).expect(200);

    const nomes = dela.body.entries.map((evento: { actorName: string }) => evento.actorName);
    expect(nomes).not.toContain(DONO.name);
    expect(
      dela.body.entries.some((evento: { after: unknown }) =>
        JSON.stringify(evento.after ?? {}).includes('maria@domari.com.br'),
      ),
    ).toBe(false);
  });

  it('o painel de uma barbearia não conta o movimento da outra', async () => {
    const dono = await abrirBarbearia();
    const rival = await abrirBarbearia(RIVAL);

    const dela = await com(rival)(http().get('/v1/admin/catalog/diagnosis')).expect(200);
    // Cada uma tem exatamente o serviço do próprio onboarding.
    expect(dela.body.examinados).toBe(1);

    const dele = await com(dono)(http().get('/v1/admin/catalog/diagnosis')).expect(200);
    expect(dele.body.examinados).toBe(1);
  });
});
