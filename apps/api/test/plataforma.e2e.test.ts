import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emailKey, hashPassword } from '@barbearia/identity';
import { criarAdminDaPlataforma } from '@barbearia/platform';
import { BookingController } from '../src/booking/booking.controller.js';
import { StaffAuthController } from '../src/admin/admin.controller.js';
import { MeController } from '../src/admin/team.controller.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import {
  PlataformaAuthController,
  PlataformaController,
} from '../src/plataforma/plataforma.controller.js';
import { PlataformaGuard } from '../src/plataforma/plataforma.guard.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { limparBanco } from './limpar.js';

/**
 * O bloqueio de conta pelo Super Admin, visto de fora.
 *
 * O teste de integração de `@barbearia/platform` prova que a coluna muda. O que
 * **este** arquivo prova é a outra metade, que é a que interessa: que a coluna
 * é lida. Uma marca de bloqueio que nenhuma porta consulta é exatamente o
 * defeito que a regra "campo que ninguém preenche é mentira" descreve, só que
 * pelo avesso — aqui o campo é preenchido e ninguém o lê.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const DOMARI = '24242424-1111-1111-1111-111111111111';
const VIZINHA = '24242424-2222-2222-2222-222222222222';
const LOCAL = 'a2424242-0000-0000-0000-000000000001';
const LOCAL_VIZINHA = 'a2424242-0000-0000-0000-000000000002';
const DONO = 'b2424242-0000-0000-0000-000000000001';
const EMAIL_DO_DONO = 'dono@domari.test';
const SERVICO = 'e2424242-0000-0000-0000-000000000001';
const SENHA = 'senha-do-dono-24';
const SENHA_DA_PLATAFORMA = 'senha-super-admin-24';

let app: INestApplication;
let admin: PrismaClient;
let tenants: TenantService;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const s of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(s);
  }
}

const http = () => request(app.getHttpServer());

async function tokenDaPlataforma(): Promise<string> {
  const resposta = await http()
    .post('/v1/plataforma/login')
    .send({ email: 'super@plataforma.test', senha: SENHA_DA_PLATAFORMA })
    .expect(201);
  return resposta.body.token as string;
}

async function tokenDoDono(): Promise<string> {
  const resposta = await http()
    .post('/v1/admin/login')
    .send({ email: EMAIL_DO_DONO, password: SENHA })
    .expect(201);
  return resposta.body.token as string;
}

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

describeIfDb('bloqueio de conta pela plataforma', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });

    // `platform_admins` e `platform_audit` não penduram em `tenants`, e é de
    // propósito (a trilha sobrevive à barbearia apagada). O preço é que elas
    // não saem no `TRUNCATE ... CASCADE` e precisam ser nomeadas aqui.
    await limparBanco(admin, ['tenants', 'platform_admins', 'platform_audit']);

    const pepper = process.env['STAFF_EMAIL_PEPPER'];
    if (!pepper) throw new Error('STAFF_EMAIL_PEPPER é obrigatória');
    const hash = await hashPassword(SENHA);

    await exec(admin, `
      INSERT INTO tenants (id, name) VALUES
        ('${DOMARI}', 'Domari Barber Club'),
        ('${VIZINHA}', 'Barbearia Vizinha');

      INSERT INTO tenant_slugs (slug, tenant_id, is_primary) VALUES
        ('domari24', '${DOMARI}', true),
        ('vizinha24', '${VIZINHA}', true);

      INSERT INTO locations (id, tenant_id, name, timezone, city, state) VALUES
        ('${LOCAL}', '${DOMARI}', 'Pituba', 'America/Bahia', 'Salvador', 'BA'),
        ('${LOCAL_VIZINHA}', '${VIZINHA}', 'Rio Vermelho', 'America/Bahia', 'Salvador', 'BA');

      INSERT INTO service_categories (id, tenant_id, name, position)
      VALUES ('d2424242-0000-0000-0000-000000000001', '${DOMARI}', 'Cabelo', 1);

      INSERT INTO services (id, tenant_id, category_id, name, price_cents, duration_minutes)
      VALUES ('${SERVICO}', '${DOMARI}', 'd2424242-0000-0000-0000-000000000001',
              'Corte', 4900, 30);

      INSERT INTO staff_users (id, tenant_id, name, email, phone_e164, password_hash, role)
      VALUES ('${DONO}', '${DOMARI}', 'Matheus', 'dono@domari.test', '+5571988880024',
              '${hash}', 'owner');

      INSERT INTO staff_directory (email_key, tenant_id, staff_user_id)
      VALUES ('${emailKey(EMAIL_DO_DONO, pepper)}', '${DOMARI}', '${DONO}');
    `);

    await criarAdminDaPlataforma({
      nome: 'Super',
      email: 'super@plataforma.test',
      senha: SENHA_DA_PLATAFORMA,
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [
        BookingController,
        StaffAuthController,
        MeController,
        PlataformaAuthController,
        PlataformaController,
      ],
      providers: [
        TenantService,
        StaffGuard,
        PermissaoGuard,
        PlataformaGuard,
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    tenants = app.get(TenantService);
  });

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
  });

  it('a porta da plataforma recusa quem não tem sessão', async () => {
    await http().get('/v1/plataforma/barbearias').expect(401);
    await http()
      .get('/v1/plataforma/barbearias')
      .set('authorization', 'Bearer inventado')
      .expect(401);
  });

  it('o token do gestor não abre o painel da plataforma', async () => {
    // O caminho que transformaria um dono de barbearia em administrador de
    // todas elas. As duas portas resolvem token contra tabelas diferentes e
    // não compartilham código — este teste é o que garante que continuam assim.
    const doDono = await tokenDoDono();
    await http()
      .get('/v1/plataforma/barbearias')
      .set('authorization', `Bearer ${doDono}`)
      .expect(401);
  });

  it('o token da plataforma não abre o painel de nenhuma barbearia', async () => {
    const daPlataforma = await tokenDaPlataforma();
    await http()
      .get('/v1/admin/me')
      .set('authorization', `Bearer ${daPlataforma}`)
      .expect(401);
  });

  it('lista as barbearias com plano e estado', async () => {
    const token = await tokenDaPlataforma();
    const resposta = await http()
      .get('/v1/plataforma/barbearias')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    const nomes = resposta.body.barbearias.map((b: { nome: string }) => b.nome);
    expect(nomes).toContain('Domari Barber Club');
    expect(nomes).toContain('Barbearia Vizinha');

    const domari = resposta.body.barbearias.find(
      (b: { tenantId: string }) => b.tenantId === DOMARI,
    );
    expect(domari.slug).toBe('domari24');
    expect(domari.bloqueada).toBe(false);
  });

  it('bloquear sem motivo é recusado na borda', async () => {
    const token = await tokenDaPlataforma();
    await http()
      .post(`/v1/plataforma/barbearias/${DOMARI}/bloqueio`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: '  ' })
      .expect(400);
  });

  it('tenant que não é uuid não chega ao banco', async () => {
    const token = await tokenDaPlataforma();
    await http()
      .post(`/v1/plataforma/barbearias/nao-e-uuid/bloqueio`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: 'qualquer' })
      .expect(400);
  });

  it('antes do bloqueio: a página pública responde e o dono entra', async () => {
    await http().get('/v1/b/domari24').expect(200);
    // A mesma consulta que o teste do bloqueio faz. Sem esta linha, o 404 de lá
    // poderia vir de qualquer outra coisa e o teste provaria nada.
    await http()
      .get(
        `/v1/b/domari24/availability?locationId=${LOCAL}&serviceIds=${SERVICO}&dateFrom=2030-01-06`,
      )
      .expect(200);
    const token = await tokenDoDono();
    await http().get('/v1/admin/me').set('authorization', `Bearer ${token}`).expect(200);
  });

  it('bloquear derruba a página pública, o login e a sessão já aberta', async () => {
    // A sessão é aberta **antes** do bloqueio de propósito: bloquear conta com
    // gente logada não pode esperar o token vencer, que são horas.
    const jaLogado = await tokenDoDono();
    const daPlataforma = await tokenDaPlataforma();

    await http()
      .post(`/v1/plataforma/barbearias/${DOMARI}/bloqueio`)
      .set('authorization', `Bearer ${daPlataforma}`)
      .send({ motivo: 'inadimplente há 60 dias' })
      .expect(201);

    const publica = await http().get('/v1/b/domari24').expect(404);
    // O visitante não fica sabendo por quê: a inadimplência do estabelecimento
    // não é assunto de quem só queria cortar o cabelo.
    expect(JSON.stringify(publica.body)).not.toContain('inadimplente');

    // A grade fecha junto. A consulta é montada válida de propósito: com
    // parâmetro faltando ela morre no schema com 400 e o teste passaria sem
    // nunca ter chegado à checagem de bloqueio.
    await http()
      .get(
        `/v1/b/domari24/availability?locationId=${LOCAL}&serviceIds=${SERVICO}&dateFrom=2030-01-06`,
      )
      .expect(404);

    const sessaoAntiga = await http()
      .get('/v1/admin/me')
      .set('authorization', `Bearer ${jaLogado}`)
      .expect(403);
    expect(sessaoAntiga.body.error.code).toBe('tenant_blocked');
    // O dono, ao contrário do visitante, precisa do motivo: é o que ele usa
    // para saber a quem ligar.
    expect(sessaoAntiga.body.error.message).toContain('inadimplente');

    const novoLogin = await http()
      .post('/v1/admin/login')
      .send({ email: EMAIL_DO_DONO, password: SENHA })
      .expect(403);
    expect(novoLogin.body.error.code).toBe('tenant_blocked');
  });

  it('e a senha errada continua sendo senha errada, não conta bloqueada', async () => {
    // Se o bloqueio fosse checado antes da senha, esta resposta diria
    // "bloqueada" — e a internet inteira poderia mapear quem está inadimplente
    // na plataforma chutando e-mails.
    const resposta = await http()
      .post('/v1/admin/login')
      .send({ email: EMAIL_DO_DONO, password: 'senha-errada-mesmo' })
      .expect(401);
    expect(resposta.body.error.code).toBe('invalid_credentials');
  });

  it('bloquear uma barbearia não derruba a vizinha', async () => {
    await http().get('/v1/b/vizinha24').expect(200);
  });

  it('bloquear de novo não é aceito — a data do primeiro bloqueio é o prazo', async () => {
    const token = await tokenDaPlataforma();
    const resposta = await http()
      .post(`/v1/plataforma/barbearias/${DOMARI}/bloqueio`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: 'outro motivo' })
      .expect(409);
    expect(resposta.body.error.code).toBe('not_blockable');
  });

  it('desbloquear devolve a página e o painel no mesmo instante', async () => {
    const token = await tokenDaPlataforma();
    await http()
      .delete(`/v1/plataforma/barbearias/${DOMARI}/bloqueio`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    // Sem invalidação de cache, isto só voltaria depois do TTL — e o teste
    // falharia aqui, que é onde ele precisa falhar.
    await http().get('/v1/b/domari24').expect(200);
    const doDono = await tokenDoDono();
    await http().get('/v1/admin/me').set('authorization', `Bearer ${doDono}`).expect(200);
  });

  it('trocar de plano fica na trilha, com quem fez e de onde para onde', async () => {
    const token = await tokenDaPlataforma();
    await http()
      .put(`/v1/plataforma/barbearias/${DOMARI}/plano`)
      .set('authorization', `Bearer ${token}`)
      .send({ planoCode: 'essencial' })
      .expect(200);

    const trilha = await http()
      .get('/v1/plataforma/trilha')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    const troca = trilha.body.eventos.find(
      (e: { acao: string }) => e.acao === 'tenant.plan_changed',
    );
    expect(troca.tenantId).toBe(DOMARI);
    expect(troca.adminNome).toBe('Super');
    expect(troca.detalhe).toEqual({ de: null, para: 'essencial' });

    const acoes = trilha.body.eventos.map((e: { acao: string }) => e.acao);
    expect(acoes).toContain('tenant.blocked');
    expect(acoes).toContain('tenant.unblocked');
  });

  it('plano inexistente é 404 e não muda nada', async () => {
    const token = await tokenDaPlataforma();
    await http()
      .put(`/v1/plataforma/barbearias/${DOMARI}/plano`)
      .set('authorization', `Bearer ${token}`)
      .send({ planoCode: 'ouro' })
      .expect(404);
  });

  // -- métricas (bloco 25) ---------------------------------------------------

  it('as métricas exigem sessão de plataforma como todo o resto', async () => {
    await http().get('/v1/plataforma/metricas').expect(401);
    await http().get('/v1/plataforma/saude').expect(401);
  });

  it('sem nenhum dia apurado, o painel responde zero em vez de quebrar', async () => {
    // É o estado do primeiro dia de operação **e** o do worker parado. A tela
    // tem os dois desenhados, então a API não pode explodir em nenhum.
    const token = await tokenDaPlataforma();
    const resposta = await http()
      .get('/v1/plataforma/metricas')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    expect(resposta.body.resumo.agendamentos).toBe(0);
    expect(resposta.body.resumo.ocupacaoEmPontos).toBe(0);
    expect(resposta.body.ate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('o MRR sai dos planos, e a lista traz uma linha por barbearia', async () => {
    const token = await tokenDaPlataforma();

    await http()
      .put(`/v1/plataforma/barbearias/${VIZINHA}/plano`)
      .set('authorization', `Bearer ${token}`)
      .send({ planoCode: 'completo' })
      .expect(200);

    const metricas = await http()
      .get('/v1/plataforma/metricas')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    // A Domari ficou no 'essencial' (9900) num teste anterior; a vizinha acabou
    // de entrar no 'completo' (19900).
    expect(metricas.body.resumo.mrrCents).toBe(29800);

    const saude = await http()
      .get('/v1/plataforma/saude')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    expect(saude.body.barbearias).toHaveLength(2);
    expect(saude.body.barbearias.every((b: { ultimoDia: null }) => b.ultimoDia === null)).toBe(true);
  });

  it('janela fora do permitido morre na borda, não no banco', async () => {
    const token = await tokenDaPlataforma();
    await http()
      .get('/v1/plataforma/metricas?dias=9999')
      .set('authorization', `Bearer ${token}`)
      .expect(400);
    await http()
      .get('/v1/plataforma/metricas?ate=ontem')
      .set('authorization', `Bearer ${token}`)
      .expect(400);
    // Formato certo e data que não existe. Sem a conferência, esta passa da
    // borda e estoura lá dentro na aritmética de data — 500 sobre entrada do
    // cliente, que é a definição de validação faltando.
    await http()
      .get('/v1/plataforma/metricas?ate=0000-00-00')
      .set('authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('sair invalida o token da plataforma', async () => {
    const token = await tokenDaPlataforma();
    await http().post('/v1/plataforma/logout').set('authorization', `Bearer ${token}`).expect(201);
    await http()
      .get('/v1/plataforma/barbearias')
      .set('authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('o TTL é o teto de quanto tempo um bloqueio demora a valer em outra instância', async () => {
    // A invalidação de cache só alcança o processo que bloqueou. Este teste
    // simula a **outra** instância: cache quente, nenhuma invalidação, e o
    // relógio andando além do TTL. É o comportamento que o comentário em
    // `TenantService` promete, e sem ele a promessa seria só um texto.
    const daPlataforma = await tokenDaPlataforma();
    const base = Date.now();
    tenants.now = () => base;

    await http().get('/v1/b/vizinha24').expect(200);

    await exec(admin, `
      UPDATE tenant_platform SET blocked_at = now(), blocked_reason = 'direto no banco'
       WHERE tenant_id = '${VIZINHA}';
    `);

    // Cache quente: ainda atende, e é essa a janela declarada.
    await http().get('/v1/b/vizinha24').expect(200);

    tenants.now = () => base + 31_000;
    await http().get('/v1/b/vizinha24').expect(404);

    tenants.now = () => Date.now();
    await http()
      .delete(`/v1/plataforma/barbearias/${VIZINHA}/bloqueio`)
      .set('authorization', `Bearer ${daPlataforma}`)
      .expect(200);
  });
});
