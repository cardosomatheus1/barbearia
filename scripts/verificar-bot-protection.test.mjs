import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { falhasDaProtecaoAntiBot } from './verificar-bot-protection.mjs';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fontes = Object.fromEntries(Object.entries({
  turnstile: 'apps/api/src/common/turnstile.ts',
  controller: 'apps/api/src/admin/admin.controller.ts',
  schema: 'apps/api/src/admin/admin.schemas.ts',
  page: 'apps/web/src/app/admin/criar-conta/page.tsx',
  action: 'apps/web/src/app/admin/acoes/onboarding.ts',
  middleware: 'apps/web/src/middleware.ts',
  preflight: 'scripts/verificar-configuracao-producao.mjs',
  compose: 'deploy/compose.yml',
  appModule: 'apps/api/src/app.module.ts',
  throttler: 'apps/api/src/common/throttler.config.ts',
}).map(([k,p]) => [k, readFileSync(resolve(raiz,p),'utf8')]));
fontes.skipThrottleSeguro = true;

test('estado atual tem proteção anti-bot completa', () => assert.deepEqual(falhasDaProtecaoAntiBot(fontes), []));
const mutacoes = [
  ['server-side', { controller: fontes.controller.replace('await verificarTurnstile({', 'await Promise.resolve({') }],
  ['action', { turnstile: fontes.turnstile.replace('dados.action !== params.action', 'false') }],
  ['hostname', { turnstile: fontes.turnstile.replace('hostnames.has(dados.hostname.toLowerCase())', 'true') }],
  ['widget', { page: fontes.page.replace('className="cf-turnstile"', 'className="sem-protecao"') }],
  ['CSP estreita', { middleware: fontes.middleware.replace("pathname === '/admin/criar-conta'", 'true') }],
  ['preflight', { preflight: fontes.preflight.replace("'TURNSTILE_SECRET_KEY'", "'TURNSTILE_REMOVIDO'") }],
  ['rate limit global', { appModule: fontes.appModule.replace('{ provide: APP_GUARD, useClass: ThrottlerGuard }', '{ provide: APP_GUARD, useClass: OutroGuard }') }],
  ['duas janelas', { throttler: fontes.throttler.replace('name: NOMES_DOS_LIMITES[1]', 'name: NOMES_DOS_LIMITES[0]') }],
];
for (const [nome, alteracao] of mutacoes) {
  test(`detecta regressão: ${nome}`, () => assert.ok(falhasDaProtecaoAntiBot({ ...fontes, ...alteracao }).length > 0));
}
