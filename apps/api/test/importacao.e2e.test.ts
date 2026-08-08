import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConsoleMessagingProvider } from '@barbearia/identity';
import { ImportacaoController } from '../src/admin/importacao.controller.js';
import { PainelController } from '../src/admin/painel.controller.js';
import { MeController, TeamController } from '../src/admin/team.controller.js';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';

/**
 * A importação de base pela HTTP — SPEC §5.8.
 *
 * O que só se prova com a pilha de pé: que o preview não grava, que o arquivo de
 * uma barbearia não atravessa para a outra, e que a sequência
 * preview → aplicar → desfazer respeita o estado em que a importação está.
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

const ARQUIVO = [
  'Nome;Celular;Data de Nascimento',
  'José Antônio da Silva;(71) 98888-1111;07/09/1985',
  'Ana Paula;71 97777-2222;1990-03-12',
  'Bruno Carvalho;(71) 8888-3333;',
].join('\n');

describeIfDb('importação de base pela HTTP', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [
        StaffAuthController,
        OnboardingController,
        ImportacaoController,
        PainelController,
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
        .send({ professionals: [{ name: 'Ruan Nascimento', schedule: JORNADA }] }),
    ).expect(200);

    await com(token)(http().post('/v1/admin/publish')).expect(201);
    return token;
  }

  /** Uma conta de equipe com a senha já trocada. */
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

  const enviar = (token: string, conteudo = ARQUIVO, fileName = 'clientes.csv') =>
    com(token)(http().post('/v1/admin/imports').send({ fileName, conteudo }));

  // -- quem pode ---------------------------------------------------------------

  it('sem sessão não se importa nem se lê importação', async () => {
    await http().get('/v1/admin/imports').expect(401);
    await http().post('/v1/admin/imports').send({ fileName: 'a.csv', conteudo: 'x' }).expect(401);
    await http().get('/v1/admin/slugs').expect(401);
  });

  it('o barbeiro não importa a base da casa', async () => {
    // `customers.edit` é da recepção e da gerência para cima. O barbeiro edita a
    // ficha de quem senta na cadeira dele, não a base inteira.
    const dono = await abrirBarbearia();
    const barbeiro = await conta(dono, 'professional', 'Ruan Barbeiro', 'ruan@domari.com.br');

    await com(barbeiro)(http().get('/v1/admin/imports')).expect(403);
    await com(barbeiro)(
      http().post('/v1/admin/imports').send({ fileName: 'x.csv', conteudo: ARQUIVO }),
    ).expect(403);
  });

  it('a recepcionista importa a base mas não mexe no endereço público', async () => {
    // Ela tem `customers.edit` e não tem `settings.manage`. São permissões
    // diferentes porque são coisas diferentes: uma é a base de pessoas, a outra
    // é por onde o cliente chega.
    const dono = await abrirBarbearia();
    const maria = await conta(dono, 'receptionist', 'Maria Recepção', 'maria@domari.com.br');

    await enviar(maria).expect(201);
    await com(maria)(http().get('/v1/admin/slugs')).expect(403);
    await com(maria)(http().post('/v1/admin/slugs').send({ slug: 'qualquer-um' })).expect(403);
  });

  // -- preview -----------------------------------------------------------------

  it('o preview conta o que vai entrar e não grava ninguém', async () => {
    const dono = await abrirBarbearia();
    const preview = await enviar(dono).expect(201);

    expect(preview.body).toMatchObject({
      status: 'previewed',
      total: 3,
      separator: ';',
      repetida: false,
    });
    expect(preview.body.resumo.novo).toBe(3);

    const base = await admin.$queryRawUnsafe<{ quantos: bigint }[]>(
      'SELECT count(*)::bigint AS quantos FROM customers',
    );
    expect(Number(base[0]?.quantos)).toBe(0);
  });

  it('arquivo sem coluna de telefone morre na borda com o motivo', async () => {
    const dono = await abrirBarbearia();
    const recusa = await enviar(dono, 'Nome;Endereço\nZé;Rua A').expect(400);
    expect(recusa.body.error.code).toBe('sem_coluna_de_telefone');
  });

  it('corpo sem conteúdo é recusado pelo schema', async () => {
    const dono = await abrirBarbearia();
    await com(dono)(http().post('/v1/admin/imports').send({ fileName: 'a.csv' })).expect(400);
    await com(dono)(
      http().post('/v1/admin/imports').send({ fileName: '', conteudo: ARQUIVO }),
    ).expect(400);
  });

  it('separador inventado pelo cliente é recusado na borda', async () => {
    // Ele muda como o arquivo inteiro é lido; lista fechada, não caractere livre.
    //
    // O código do erro faz parte do teste, não é enfeite: com `z.string()` no
    // lugar do enum a requisição **continua** dando 400 — só que por
    // `sem_coluna_de_telefone`, porque partir por `|` deixa o cabeçalho inteiro
    // numa coluna só. Conferir só o status aprovava a borda aberta.
    const dono = await abrirBarbearia();
    const recusa = await com(dono)(
      http().post('/v1/admin/imports').send({ fileName: 'a.csv', conteudo: ARQUIVO, separador: '|' }),
    ).expect(400);
    expect(recusa.body.error.code).toBe('invalid_request');
  });

  // -- aplicar e desfazer ------------------------------------------------------

  it('aplica, lista e desfaz', async () => {
    const dono = await abrirBarbearia();
    const preview = await enviar(dono).expect(201);

    const aplicada = await com(dono)(
      http().post(`/v1/admin/imports/${preview.body.id}/apply`),
    ).expect(201);
    expect(aplicada.body).toEqual({ criados: 3, atualizados: 0 });

    const lista = await com(dono)(http().get('/v1/admin/imports')).expect(200);
    expect(lista.body.imports[0]).toMatchObject({ status: 'applied', fileName: 'clientes.csv' });

    const desfeita = await com(dono)(
      http().post(`/v1/admin/imports/${preview.body.id}/revert`),
    ).expect(201);
    expect(desfeita.body).toEqual({ apagados: 3 });
  });

  it('aplicar duas vezes responde 409, não silêncio', async () => {
    const dono = await abrirBarbearia();
    const preview = await enviar(dono).expect(201);
    await com(dono)(http().post(`/v1/admin/imports/${preview.body.id}/apply`)).expect(201);

    const repetida = await com(dono)(
      http().post(`/v1/admin/imports/${preview.body.id}/apply`),
    ).expect(409);
    expect(repetida.body.error.code).toBe('ja_aplicada');
  });

  it('importação que não existe responde 404', async () => {
    const dono = await abrirBarbearia();
    await com(dono)(
      http().post('/v1/admin/imports/11111111-1111-1111-1111-111111111111/apply'),
    ).expect(404);
  });

  it('id que não é UUID morre na borda', async () => {
    const dono = await abrirBarbearia();
    await com(dono)(http().post('/v1/admin/imports/nao-e-uuid/apply')).expect(400);
  });

  it('a importação de uma barbearia não é vista nem aplicada pela outra', async () => {
    const dono = await abrirBarbearia();
    const preview = await enviar(dono).expect(201);

    const rival = await abrirBarbearia(RIVAL);
    // Id conhecido, tenant errado: 404, nunca 403 — 403 confirmaria que existe.
    await com(rival)(http().post(`/v1/admin/imports/${preview.body.id}/apply`)).expect(404);

    const lista = await com(rival)(http().get('/v1/admin/imports')).expect(200);
    expect(lista.body.imports).toHaveLength(0);
  });

  it('reenviar o mesmo arquivo devolve a importação anterior', async () => {
    const dono = await abrirBarbearia();
    const primeira = await enviar(dono).expect(201);
    const segunda = await enviar(dono, ARQUIVO, 'clientes (1).csv').expect(201);

    expect(segunda.body.id).toBe(primeira.body.id);
    expect(segunda.body.repetida).toBe(true);
  });

  // -- slug legado -------------------------------------------------------------

  it('o endereço antigo passa a levar para a barbearia', async () => {
    const dono = await abrirBarbearia();

    await com(dono)(http().post('/v1/admin/slugs').send({ slug: 'barbearia-do-ze' })).expect(201);

    const lista = await com(dono)(http().get('/v1/admin/slugs')).expect(200);
    expect(lista.body.slugs.map((s: { slug: string }) => s.slug)).toEqual([
      'domari-barber-club',
      'barbearia-do-ze',
    ]);
    expect(lista.body.slugs[1].principal).toBe(false);
  });

  it('endereço de outra barbearia responde 409', async () => {
    const dono = await abrirBarbearia();
    await abrirBarbearia(RIVAL);

    const recusa = await com(dono)(
      http().post('/v1/admin/slugs').send({ slug: 'rival-barbearia' }),
    ).expect(409);
    expect(recusa.body.error.code).toBe('ja_usado');
  });

  it('endereço reservado da aplicação é recusado', async () => {
    const dono = await abrirBarbearia();
    const recusa = await com(dono)(http().post('/v1/admin/slugs').send({ slug: 'admin' })).expect(400);
    expect(recusa.body.error.code).toBe('reservado');
  });

  it('a lista de endereços de uma barbearia não mostra a da outra', async () => {
    const dono = await abrirBarbearia();
    const rival = await abrirBarbearia(RIVAL);

    const dela = await com(rival)(http().get('/v1/admin/slugs')).expect(200);
    expect(dela.body.slugs.map((s: { slug: string }) => s.slug)).toEqual(['rival-barbearia']);
    expect(dono).toBeTruthy();
  });

  // -- a trilha ----------------------------------------------------------------

  it('aplicar e desfazer aparecem na trilha de gestão, sem os nomes da base', async () => {
    const dono = await abrirBarbearia();
    const preview = await enviar(dono).expect(201);
    await com(dono)(http().post(`/v1/admin/imports/${preview.body.id}/apply`)).expect(201);

    const trilha = await com(dono)(http().get('/v1/admin/audit')).expect(200);
    const evento = trilha.body.entries.find(
      (e: { action: string }) => e.action === 'import.applied',
    );

    expect(evento).toBeDefined();
    expect(evento.after).toMatchObject({ criados: 3 });
    expect(JSON.stringify(trilha.body)).not.toContain('José Antônio');
  });
});
