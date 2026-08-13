import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConsoleMessagingProvider } from '@barbearia/identity';
import { MetricaController } from '../src/admin/metrica.controller.js';
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
 * O schema semântico pela HTTP (bloco 63, SPEC §4.15).
 *
 * O que só se prova aqui, com a pilha de pé: que **a permissão viaja com a
 * métrica**. Uma rota só responde dezenas de perguntas, então o `@Exige` dela não
 * pode descrever o que ela devolve — e um teste de unidade sobre `validarPergunta`
 * não prova que a rota chama a validação com as permissões certas.
 *
 * É a diferença entre ler o código e executar o ataque: a recepcionista existe
 * aqui, faz login de verdade, e pergunta o faturamento.
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

describeIfDb('o schema semântico pela HTTP', () => {
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
        MetricaController,
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
    tenants.forget('domari-barber-club');
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
    return token;
  }

  /** Uma recepcionista de verdade, com o papel de verdade e senha trocada. */
  async function recepcao(tokenDono: string): Promise<string> {
    const email = 'recepcao@domari.com.br';
    const convite = await com(tokenDono)(
      http().post('/v1/admin/team').send({ name: 'Maria Recepção', email, role: 'receptionist' }),
    ).expect(201);
    const senhaInicial: string = convite.body.senhaInicial;

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

  const perguntar = (token: string, corpo: Record<string, unknown>) =>
    com(token)(http().post('/v1/admin/metricas/perguntar').send(corpo));

  const JANELA = { de: '2026-03-01', ate: '2026-03-31' };

  it('a recepção não recebe o faturamento, mesmo perguntando direito', async () => {
    /**
     * O ataque, executado. A rota está declarada com `appointments.view`, que a
     * recepção tem — ela **passa** pela guarda. O que a barra é a permissão da
     * **métrica**, conferida contra o que ela tem no banco.
     *
     * O piso é o mais baixo que existe de propósito: com `reports.operational` a
     * rota barraria por conta própria, a recepção nunca chegaria ao catálogo, e
     * ninguém notaria se a permissão da métrica parasse de ser conferida — o
     * teste passaria pelo motivo errado.
     *
     * Sem isso o assistente seria o caminho mais curto para tudo que o painel
     * guarda, e nenhuma revisão de código pegaria — a rota estaria corretamente
     * declarada com a permissão de conversar.
     */
    const dono = await abrirBarbearia();
    const maria = await recepcao(dono);

    const recusa = await perguntar(maria, {
      metrica: 'faturamento',
      dimensao: 'nenhuma',
      ...JANELA,
    }).expect(403);
    expect(recusa.body.error.code).toBe('sem_permissao');
  });

  it('o dono recebe o mesmo número, pela mesma rota', async () => {
    // A prova de que a recusa acima é da permissão, e não da rota estar quebrada.
    const dono = await abrirBarbearia();
    const r = await perguntar(dono, {
      metrica: 'faturamento',
      dimensao: 'nenhuma',
      ...JANELA,
    }).expect(201);
    expect(r.body.total).toBe(0);
    expect(r.body.totalFormatado).toContain('R$');
  });

  it('toda resposta diz o período, a fonte e onde conferir', async () => {
    /**
     * *"Toda resposta traz o número, o período, a fonte e um link para a tela
     * onde ele pode ser conferido."* Um número sem onde conferir é um número que
     * o dono não usa para decidir — e na primeira vez que ele discordar da tela,
     * o assistente inteiro perde o crédito.
     */
    const dono = await abrirBarbearia();
    const r = await perguntar(dono, {
      metrica: 'atendimentos',
      dimensao: 'nenhuma',
      ...JANELA,
    }).expect(201);

    expect(r.body.de).toBe(JANELA.de);
    expect(r.body.ate).toBe(JANELA.ate);
    expect(r.body.significado.length).toBeGreaterThan(20);
    expect(r.body.tela).toMatch(/^\/admin\//);
  });

  it('métrica inventada é recusada com 400, e não com erro de banco', async () => {
    // O conjunto é fechado: o que não está no catálogo não existe, e a recusa
    // acontece antes de qualquer ida ao banco.
    const dono = await abrirBarbearia();
    const r = await perguntar(dono, {
      metrica: "faturamento'; DROP TABLE orders; --",
      dimensao: 'nenhuma',
      ...JANELA,
    }).expect(400);
    expect(r.body.error.code).toBe('metrica_desconhecida');
  });

  it('data que não existe responde 400 com motivo, nunca 500', async () => {
    // Entrada malformada que devolve 500 é defeito de borda, sempre.
    const dono = await abrirBarbearia();
    const r = await perguntar(dono, {
      metrica: 'faturamento',
      dimensao: 'nenhuma',
      de: '2026-02-31',
      ate: '2026-03-31',
    }).expect(400);
    expect(r.body.error.code).toBe('periodo_invalido');
  });

  it('o catálogo é recortado pelo que a pessoa pode perguntar', async () => {
    /**
     * Devolver a lista inteira e deixar a tela esconder seria a permissão
     * recalculada na view — e diria à recepção que existe um número de
     * faturamento que ela não pode ver, o que é informação por si.
     */
    const dono = await abrirBarbearia();
    const maria = await recepcao(dono);

    const dela = await com(maria)(http().get('/v1/admin/metricas')).expect(200);
    const chaves = dela.body.metricas.map((m: { chave: string }) => m.chave);
    expect(chaves).not.toContain('faturamento');
    expect(chaves).not.toContain('margem_por_servico');

    const dele = await com(dono)(http().get('/v1/admin/metricas')).expect(200);
    const doDono = dele.body.metricas.map((m: { chave: string }) => m.chave);
    expect(doDono).toContain('faturamento');
    expect(doDono).toContain('margem_por_servico');
  });

  it('a sugestão que a tela oferece nunca é uma pergunta que seria recusada', async () => {
    // Botão que só dá erro é pior que botão ausente — e aqui ele ensinaria a
    // recepção a achar que o produto está quebrado.
    const dono = await abrirBarbearia();
    const maria = await recepcao(dono);
    const dela = await com(maria)(http().get('/v1/admin/metricas')).expect(200);

    for (const s of dela.body.sugestoes) {
      await perguntar(maria, { metrica: s.metrica, dimensao: s.dimensao, ...JANELA }).expect(201);
    }
  });
});
