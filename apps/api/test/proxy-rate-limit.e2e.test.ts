import 'reflect-metadata';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { proxyConfiavel } from '../src/common/proxy-confiavel.js';
@Controller('origem')
class ProbeController { @Get() get() { return { ok: true }; } }
let app: INestApplication;
const secret = 'chave-interna-de-teste-0123456789abcdef';
beforeAll(async () => {
  vi.stubEnv('INTERNAL_PROXY_SECRET', secret);
  const module = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ name: 'short', ttl: 60000, limit: 2 }])],
    controllers: [ProbeController], providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  }).compile();
  app = module.createNestApplication();
  app.use(proxyConfiavel);
  await app.init();
});
afterAll(async () => { await app.close(); vi.unstubAllEnvs(); });
it('cotas independentes por visitante autenticado pelo proxy', async () => {
  for (const ip of ['192.0.2.10', '192.0.2.11']) {
    const call = () => request(app.getHttpServer()).get('/origem')
      .set('x-barberdock-proxy-key', secret).set('x-barberdock-client-ip', ip);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  }
});
it('trocar XFF ou chave forjada diretamente na API não renova a cota', async () => {
  const statuses = [];
  for (const ip of ['192.0.2.30', '192.0.2.31', '192.0.2.32']) {
    statuses.push((await request(app.getHttpServer()).get('/origem').set('x-forwarded-for', ip)
      .set('x-barberdock-proxy-key', 'forjada').set('x-barberdock-client-ip', ip)).status);
  }
  expect(statuses).toEqual([200, 200, 429]);
});
