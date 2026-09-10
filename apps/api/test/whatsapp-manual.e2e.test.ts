import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signUpOwner } from '@barbearia/identity';
import { WhatsAppManualController } from '../src/admin/whatsapp-manual.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { limparBanco } from './limpar.js';
const run = process.env['SEED_DATABASE_URL'] && process.env['APP_DATABASE_URL'] ? describe : describe.skip;
let app: INestApplication, admin: PrismaClient;
run('WhatsApp manual pela API autenticada', () => {
  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: process.env['SEED_DATABASE_URL']! } } });
    const moduleRef = await Test.createTestingModule({ controllers: [WhatsAppManualController], providers: [TenantService, StaffGuard, PermissaoGuard,
      { provide: APP_FILTER, useClass: HttpExceptionFilter }] }).compile();
    app = moduleRef.createNestApplication(); await app.init();
  });
  afterAll(async () => { await app?.close(); await admin?.$disconnect(); });
  beforeEach(async () => { await limparBanco(admin, ['tenants','staff_directory']); });
  const http = () => request(app.getHttpServer());
  const base = '/v1/admin/whatsapp/manual';
  async function conta(email: string) {
    const r = await signUpOwner({ name: 'Operadora', email, password: 'senha-bem-comprida', phone: '+5571988887777', businessName: email.split('@')[0]! });
    if (!r.created) throw new Error('conta não criada');
    const offset = 12 - new Date().getUTCHours(); const timezone = `Etc/GMT${offset >= 0 ? '-' : '+'}${Math.abs(offset)}`;
    await admin.$executeRaw`UPDATE locations SET timezone = ${timezone} WHERE tenant_id = ${r.session.tenantId}::uuid`;
    return r.session;
  }
  it('autenticação, borda, duas contas, criação idempotente e confirmação factual', async () => {
    const a = await conta('manual1@example.invalid'), b = await conta('manual2@example.invalid');
    const auth = (t: request.Test) => t.set('Authorization', `Bearer ${a.token}`);
    await http().get(base).expect(401);
    await auth(http().get(base + '?antes=invalido')).expect(400);
    await auth(http().post(base + '/invalido/abrir').send({})).expect(400);
    await auth(http().post(base + '/textos').send({ titulo: 'Falha', corpo: 'Olá {{99}}', habilitado: true })).expect(400);
    const texto = await auth(http().post(base + '/textos').send({ titulo: 'Convite', corpo: 'Olá {{1}}, venha na {{2}}!', habilitado: true })).expect(201);
    await admin.$executeRaw`INSERT INTO customers (tenant_id, name, phone_e164, accepts_marketing)
      VALUES (${a.tenantId}::uuid, 'Cliente', '+5571977776666', true)`;
    const corpo = { requestId: randomUUID(), nome: 'Campanha manual', templateId: texto.body.id, filtro: 'todos', valorDoFiltro: null, diaDaSemana: null, janelaDias: 7 };
    const [c1,c2] = await Promise.all([1,2].map(() => auth(http().post(base + '/campanhas').send(corpo)).expect(201)));
    if (!c1 || !c2) throw new Error('respostas concorrentes ausentes');
    expect(c1.body.id).toBe(c2.body.id);
    await auth(http().post(base + '/campanhas').send({ ...corpo, nome: 'Outro conteúdo' })).expect(409);
    const lista = await auth(http().get(base)).expect(200); expect(lista.body.itens).toHaveLength(1);
    const id = lista.body.itens[0].id as string;
    await http().post(base + '/' + id + '/abrir').set('Authorization', `Bearer ${b.token}`).send({}).expect(404);
    await http().post(base + '/textos').set('Authorization', `Bearer ${b.token}`).send({ id: texto.body.id, titulo: 'Ataque', corpo: 'Texto alterado', habilitado: true }).expect(404);
    await auth(http().post(base + '/' + id + '/concluir').send({ acao: 'enviado' })).expect(409);
    const abrir = await auth(http().post(base + '/' + id + '/abrir').send({})).expect(201);
    expect(abrir.body.url).toMatch(/^https:\/\/wa.me\//);
    const durante = await auth(http().get(base)).expect(200); expect(durante.body.itens[0].enviadoEm).toBeNull();
    await auth(http().post(base + '/' + id + '/concluir').send({ acao: 'enviado', enviadoPor: 'falsificado' })).expect(400);
    await auth(http().post(base + '/' + id + '/concluir').send({ acao: 'enviado' })).expect(201);
    await auth(http().post(base + '/' + id + '/concluir').send({ acao: 'enviado' })).expect(201);
    const depois = await auth(http().get(base)).expect(200); expect(depois.body.itens[0]).toMatchObject({ estado: 'enviado', enviadoPor: 'Operadora' });
    expect(await admin.$queryRaw`SELECT id FROM notifications`).toHaveLength(1);
  });
  it('automação duplicada mantém uma regra e recusa texto de outra conta ou do canal automático', async () => {
    const a = await conta('manual3@example.invalid'), b = await conta('manual4@example.invalid');
    const auth = (t: request.Test) => t.set('Authorization', `Bearer ${a.token}`);
    const texto = await auth(http().post(base + '/textos').send({ titulo: 'Convite', corpo: 'Olá {{1}}, venha na {{2}}!', habilitado: true })).expect(201);
    const corpo = { requestId: randomUUID(), nome: 'Aniversário', templateId: texto.body.id, gatilho: 'aniversario', limiar: 0,
      atrasoMinutos: 0, tipo: 'retorno', publico: null, objetivo: 'agendamento', janelaDias: 7, ativa: true };
    const c1 = await auth(http().post(base + '/automacoes').send(corpo)).expect(201);
    const c2 = await auth(http().post(base + '/automacoes').send(corpo)).expect(201);
    expect(c1.body.id).toBe(c2.body.id);
    await http().post(base + '/automacoes').set('Authorization', `Bearer ${b.token}`).send(corpo).expect(400);
    await http().post(base + '/automacoes/' + c1.body.id + '/estado').set('Authorization', `Bearer ${b.token}`).send({ ativa: false }).expect(404);
    await auth(http().post(base + '/automacoes/' + c1.body.id + '/estado').send({ ativa: false })).expect(201);
    expect((await auth(http().get(base + '/configuracoes')).expect(200)).body.automacoes[0].ativa).toBe(false);
    await admin.$executeRaw`UPDATE staff_users SET role = 'professional' WHERE tenant_id = ${a.tenantId}::uuid`;
    await auth(http().get(base)).expect(403);
  });
});
