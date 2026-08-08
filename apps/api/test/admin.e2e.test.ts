import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { BookingController } from '../src/booking/booking.controller.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';

/**
 * Painel do gestor pela HTTP.
 *
 * A pergunta central: um gestor consegue tocar na barbearia do vizinho? Todas
 * as rotas tiram o tenant do token, nunca da URL ou do corpo — e é isso que os
 * testes de cruzamento aqui verificam.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

let app: INestApplication;
let admin: PrismaClient;
let tenants: TenantService;

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const CONTA = {
  name: 'Matheus Cardoso',
  email: 'matheus@domari.com.br',
  password: 'senha-bem-comprida',
  phone: '(71) 98888-7777',
  businessName: 'Domari Barber Club',
};

const JORNADA = [2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 540,
  endMinute: 1080,
}));

describeIfDb('painel do gestor', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [StaffAuthController, OnboardingController, BookingController],
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
    // O cache de slugs sobrevive ao TRUNCATE: sem limpar, o teste seguinte
    // recria o mesmo slug e resolve para um tenant que já não existe.
    for (const slug of ['domari-barber-club', 'domari-barber-club-2', 'rival', 'outra']) {
      tenants.forget(slug);
    }
  });

  const http = () => request(app.getHttpServer());

  /**
   * Cria a conta e entra.
   *
   * O cadastro não devolve sessão de propósito: ele responde igual para e-mail
   * livre e já cadastrado, e entregar sessão só num dos casos desfaria isso.
   */
  async function criarConta(conta = CONTA): Promise<{ token: string; slug: string }> {
    await http().post('/v1/admin/signup').send(conta).expect(202);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email: conta.email, password: conta.password })
      .expect(201);
    return { token: entrou.body.token, slug: entrou.body.slug };
  }

  /** Percorre as seis etapas e devolve o slug publicado. */
  async function percorrer(token: string): Promise<string> {
    await http()
      .put('/v1/admin/business')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Domari Barber Club', city: 'Salvador', timezone: 'America/Bahia' })
      .expect(200);

    const templates = await http()
      .get('/v1/admin/templates')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await http()
      .put('/v1/admin/services')
      .set('Authorization', `Bearer ${token}`)
      .send({ services: templates.body.templates })
      .expect(200);

    await http()
      .put('/v1/admin/professionals')
      .set('Authorization', `Bearer ${token}`)
      .send({ professionals: [{ name: 'Ruan', schedule: JORNADA }] })
      .expect(200);

    await http()
      .put('/v1/admin/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ methods: ['pix', 'cash'] })
      .expect(200);

    const publicado = await http()
      .post('/v1/admin/publish')
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    return publicado.body.slug;
  }

  // -- conta -----------------------------------------------------------------

  it('cria a conta sem devolver sessão nem dado da barbearia', async () => {
    const resposta = await http().post('/v1/admin/signup').send(CONTA).expect(202);

    // Nem token, nem slug, nem id: o corpo precisa ser o mesmo para e-mail
    // livre e para e-mail já cadastrado.
    expect(resposta.body).toEqual({ next: 'login' });
    expect(JSON.stringify(resposta.body)).not.toContain(CONTA.password);

    // A conta existe e o login funciona.
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email: CONTA.email, password: CONTA.password })
      .expect(201);
    expect(entrou.body.slug).toBe('domari-barber-club');
    expect(entrou.body.role).toBe('owner');
  });

  it('cadastrar com e-mail já usado responde exatamente igual', async () => {
    // Um 409 contra um 202 seria oráculo de quem é dono de barbearia na
    // plataforma — a lista que o HMAC do índice existe para proteger, entregue
    // por HTTP e sem precisar de dump nenhum.
    const primeiro = await http().post('/v1/admin/signup').send(CONTA).expect(202);
    const segundo = await http()
      .post('/v1/admin/signup')
      .send({ ...CONTA, businessName: 'Outra Barbearia' })
      .expect(202);

    expect(segundo.body).toEqual(primeiro.body);

    // E a segunda tentativa não criou barbearia nenhuma.
    const tenants = await admin.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT count(*) FROM tenants',
    );
    expect(Number(tenants[0]?.count)).toBe(1);
  });

  it('recusa senha curta com mensagem útil', async () => {
    const resposta = await http()
      .post('/v1/admin/signup')
      .send({ ...CONTA, password: 'curta' })
      .expect(400);

    expect(resposta.body.error.code).toBe('invalid_request');
  });

  it('entra e sai', async () => {
    const entrou = { body: { token: (await criarConta()).token } };

    await http()
      .get('/v1/admin/state')
      .set('Authorization', `Bearer ${entrou.body.token}`)
      .expect(200);

    await http()
      .post('/v1/admin/logout')
      .set('Authorization', `Bearer ${entrou.body.token}`)
      .expect(201);

    // Sair encerra de verdade, não só no navegador.
    await http()
      .get('/v1/admin/state')
      .set('Authorization', `Bearer ${entrou.body.token}`)
      .expect(401);
  });

  it('senha errada e conta inexistente respondem igual', async () => {
    await criarConta();

    const errada = await http()
      .post('/v1/admin/login')
      .send({ email: CONTA.email, password: 'outra-senha-comprida' })
      .expect(401);
    const inexistente = await http()
      .post('/v1/admin/login')
      .send({ email: 'ninguem@lugar.com', password: 'outra-senha-comprida' })
      .expect(401);

    expect(errada.body).toEqual(inexistente.body);
  });

  it('toda rota do painel exige sessão', async () => {
    for (const [metodo, rota] of [
      ['get', '/v1/admin/state'],
      ['get', '/v1/admin/templates'],
      ['put', '/v1/admin/business'],
      ['put', '/v1/admin/services'],
      ['put', '/v1/admin/professionals'],
      ['put', '/v1/admin/payments'],
      ['post', '/v1/admin/publish'],
      ['put', '/v1/admin/change-window'],
      ['post', '/v1/admin/logout'],
    ] as const) {
      await http()[metodo](rota).send({}).expect(401);
    }
  });

  // -- onboarding ------------------------------------------------------------

  it('das seis etapas sai um link publicado com horário', async () => {
    const { token } = await criarConta();
    const slug = await percorrer(token);

    // A prova do bloco: a página pública responde com catálogo e equipe.
    const publico = await http().get(`/v1/b/${slug}`).expect(200);
    expect(publico.body.professionals.map((p: { name: string }) => p.name)).toEqual(['Ruan']);
    expect(publico.body.categories.length).toBeGreaterThan(0);
    expect(publico.body.bundles.length).toBeGreaterThan(0);
  });

  it('recusa cardápio incoerente com o detalhe do que corrigir', async () => {
    const { token } = await criarConta();

    const resposta = await http()
      .put('/v1/admin/services')
      .set('Authorization', `Bearer ${token}`)
      .send({
        services: [
          { key: 'corte', name: 'Corte', category: 'Cabelo', durationMinutes: 30, bufferAfterMinutes: 5, priceCents: 4500 },
          { key: 'barba', name: 'Barba', category: 'Barba', durationMinutes: 25, bufferAfterMinutes: 5, priceCents: 3500 },
          { key: 'combo', name: 'Corte + Barba', category: 'Combo', durationMinutes: 40, bufferAfterMinutes: 5, priceCents: 7000, componentKeys: ['corte', 'barba'] },
        ],
      })
      .expect(422);

    expect(resposta.body.error.code).toBe('invalid_catalog');
    // Sem o detalhe a tela só diria "dados inválidos" e o dono não saberia onde.
    expect(resposta.body.error.detail[0]).toMatchObject({
      key: 'combo',
      problem: 'combo_shorter_than_parts',
      declared: 40,
      actual: 55,
    });
  });

  it('não publica pela metade', async () => {
    const { token } = await criarConta();
    const resposta = await http()
      .post('/v1/admin/publish')
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect(resposta.body.error.code).toBe('nothing_to_publish');
  });

  it('a janela de cancelamento muda pela configuração e aparece no público', async () => {
    const { token } = await criarConta();
    const slug = await percorrer(token);

    await http()
      .put('/v1/admin/change-window')
      .set('Authorization', `Bearer ${token}`)
      .send({ cancelMinHours: 6, rescheduleMinHours: 2, maxReschedules: 1 })
      .expect(200);

    const publico = await http().get(`/v1/b/${slug}`).expect(200);
    expect(publico.body.location.cancelMinHours).toBe(6);
  });

  it('recusa janela fora do que o banco aceita, antes de tocar nele', async () => {
    const { token } = await criarConta();
    await http()
      .put('/v1/admin/change-window')
      .set('Authorization', `Bearer ${token}`)
      .send({ cancelMinHours: 99999, rescheduleMinHours: 2, maxReschedules: 1 })
      .expect(400);
  });

  it('recusa jornada invertida', async () => {
    // Início depois do fim passaria pelo banco e produziria dia sem horário
    // nenhum, sem erro visível para o dono.
    const { token } = await criarConta();
    await http()
      .put('/v1/admin/professionals')
      .set('Authorization', `Bearer ${token}`)
      .send({
        professionals: [
          { name: 'Ruan', schedule: [{ weekday: 2, startMinute: 1080, endMinute: 540 }] },
        ],
      })
      .expect(400);
  });

  // -- cruzamento entre barbearias -------------------------------------------

  it('gestor de uma barbearia não altera a outra', async () => {
    const um = await criarConta();
    await percorrer(um.token);

    const dois = await criarConta({ ...CONTA, email: 'rival@rival.com', businessName: 'Rival' });

    // O tenant vem do token: a mesma chamada só alcança a própria barbearia.
    await http()
      .put('/v1/admin/business')
      .set('Authorization', `Bearer ${dois.token}`)
      .send({ name: 'Invadida' })
      .expect(200);

    const publico = await http().get(`/v1/b/${um.slug}`).expect(200);
    expect(publico.body.name).toBe('Domari Barber Club');
  });

  // -- fotos -----------------------------------------------------------------

  it('grava a foto e ela chega na página pública', async () => {
    // As colunas existiam desde o bloco 1 e o perfil já as devolvia; faltava por
    // onde preencher, e a página de barbearia ficava sem uma única imagem.
    const um = await criarConta();
    const slug = await percorrer(um.token);

    const alvos = await http()
      .get('/v1/admin/photos')
      .set('Authorization', `Bearer ${um.token}`)
      .expect(200);
    expect(alvos.body.professionals.length).toBeGreaterThan(0);

    await http()
      .put('/v1/admin/photos')
      .set('Authorization', `Bearer ${um.token}`)
      .send({
        coverUrl: 'https://cdn.exemplo.com/fachada.jpg',
        professionals: [
          { id: alvos.body.professionals[0].id, photoUrl: 'https://cdn.exemplo.com/ruan.jpg' },
        ],
      })
      .expect(200);

    const publico = await http().get(`/v1/b/${slug}`).expect(200);
    expect(publico.body.location.coverUrl).toBe('https://cdn.exemplo.com/fachada.jpg');
    expect(publico.body.professionals[0].photoUrl).toBe('https://cdn.exemplo.com/ruan.jpg');
  });

  it('recusa endereço que não é https, sem derrubar o resto', async () => {
    // A foto é opcional: uma URL ruim num campo não pode impedir de salvar os
    // outros. O que não passa volta em branco, e a tela mostra isso.
    const um = await criarConta();
    await percorrer(um.token);

    const alvos = await http()
      .get('/v1/admin/photos')
      .set('Authorization', `Bearer ${um.token}`)
      .expect(200);

    const salvo = await http()
      .put('/v1/admin/photos')
      .set('Authorization', `Bearer ${um.token}`)
      .send({
        coverUrl: 'javascript:alert(1)',
        professionals: [
          { id: alvos.body.professionals[0].id, photoUrl: 'https://cdn.exemplo.com/ok.jpg' },
        ],
      })
      .expect(200);

    expect(salvo.body.photos.coverUrl).toBeNull();
    expect(salvo.body.photos.professionals[0].photoUrl).toBe('https://cdn.exemplo.com/ok.jpg');
  });

  it('campo ausente não apaga a foto que já estava lá', async () => {
    // Ausente é diferente de vazio: sem essa distinção, salvar a foto de um
    // barbeiro apagaria a dos outros.
    const um = await criarConta();
    await percorrer(um.token);

    await http()
      .put('/v1/admin/photos')
      .set('Authorization', `Bearer ${um.token}`)
      .send({ coverUrl: 'https://cdn.exemplo.com/fachada.jpg' })
      .expect(200);

    const depois = await http()
      .put('/v1/admin/photos')
      .set('Authorization', `Bearer ${um.token}`)
      .send({ logoUrl: 'https://cdn.exemplo.com/logo.png' })
      .expect(200);

    expect(depois.body.photos.coverUrl).toBe('https://cdn.exemplo.com/fachada.jpg');

    // E vazio apaga de propósito: é como a tela diz "tire esta foto".
    const limpo = await http()
      .put('/v1/admin/photos')
      .set('Authorization', `Bearer ${um.token}`)
      .send({ coverUrl: '' })
      .expect(200);
    expect(limpo.body.photos.coverUrl).toBeNull();
  });

  it('não põe foto no profissional de outra barbearia', async () => {
    const um = await criarConta();
    const slug = await percorrer(um.token);
    const alvos = await http()
      .get('/v1/admin/photos')
      .set('Authorization', `Bearer ${um.token}`)
      .expect(200);
    const alheio = alvos.body.professionals[0].id;

    const dois = await criarConta({ ...CONTA, email: 'rival@rival.com', businessName: 'Rival' });

    // O id existe, mas a RLS não enxerga a linha: o UPDATE não encontra nada.
    await http()
      .put('/v1/admin/photos')
      .set('Authorization', `Bearer ${dois.token}`)
      .send({ professionals: [{ id: alheio, photoUrl: 'https://cdn.rival.com/pichacao.jpg' }] })
      .expect(200);

    const publico = await http().get(`/v1/b/${slug}`).expect(200);
    expect(publico.body.professionals[0].photoUrl).toBeNull();
  });

  it('gestor não enxerga o estado da outra barbearia', async () => {
    const um = await criarConta();
    await percorrer(um.token);

    const dois = await criarConta({ ...CONTA, email: 'rival@rival.com', businessName: 'Rival' });
    const estado = await http()
      .get('/v1/admin/state')
      .set('Authorization', `Bearer ${dois.token}`)
      .expect(200);

    expect(estado.body.businessName).toBe('Rival');
    expect(estado.body.counts.services).toBe(0);
  });

  it('token com o tenant trocado não vale', async () => {
    const um = await criarConta();
    const dois = await criarConta({ ...CONTA, email: 'rival@rival.com', businessName: 'Rival' });

    const estadoDois = await http()
      .get('/v1/admin/state')
      .set('Authorization', `Bearer ${dois.token}`)
      .expect(200);

    // Prefixo do vizinho + segredo próprio: a tentativa óbvia contra um token
    // que carrega o tenant em claro.
    const forjado = `${estadoDois.body.tenantId}.${um.token.split('.')[1]}`;
    await http()
      .get('/v1/admin/state')
      .set('Authorization', `Bearer ${forjado}`)
      .expect(401);
  });

  it('nunca vaza detalhe interno em erro do painel', async () => {
    const { token } = await criarConta();
    const resposta = await http()
      .put('/v1/admin/business')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x' })
      .expect(400);

    const corpo = JSON.stringify(resposta.body).toLowerCase();
    for (const vazamento of ['select', 'insert', 'postgres', 'prisma', 'stack', 'tenant_id']) {
      expect(corpo).not.toContain(vazamento);
    }
  });
});
