import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const raiz = process.cwd();
const arquivos = [
  'apps/api/src/tenant/tenant.service.ts',
  'packages/identity/src/messaging.ts',
  'packages/identity/src/otp.ts',
  'apps/api/src/app.module.ts',
  'scripts/verificar-configuracao-producao.mjs',
  'packages/db/migrations/0116_recheck_final_hardening.sql',
  ...fs.readdirSync(path.join(raiz, 'packages/db/migrations'))
    .filter((nome) => /^\d{4}_.+\.sql$/.test(nome))
    .map((nome) => `packages/db/migrations/${nome}`),
  'scripts/verify.sh',
  'scripts/verificar-recheck-final.mjs',
];

function preparar() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barberdock-recheck-final-'));
  for (const arq of new Set(arquivos)) {
    const dst = path.join(tmp, arq);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(raiz, arq), dst);
  }
  return tmp;
}

function mutacao(rel, de, para) {
  const tmp = preparar();
  const alvo = path.join(tmp, rel);
  const antes = fs.readFileSync(alvo, 'utf8');
  assert.ok(antes.includes(de), `fixture não contém mutação: ${de.slice(0, 100)}`);
  fs.writeFileSync(alvo, antes.replace(de, para));
  const r = spawnSync(process.execPath, ['scripts/verificar-recheck-final.mjs'], { cwd: tmp, encoding: 'utf8' });
  assert.notEqual(r.status, 0, `guarda aceitou regressão em ${rel}`);
}

test('detecta remoção do teto duro do cache', () => mutacao(
  'apps/api/src/tenant/tenant.service.ts',
  'while (cache.size > this.maxCacheEntries)',
  'while (false && cache.size > this.maxCacheEntries)',
));
test('detecta slug cache sem limitador', () => mutacao(
  'apps/api/src/tenant/tenant.service.ts',
  "this.limitarCache(this.cache, 'slugs')",
  'this.logger.debug(\'sem limite\')',
));
test('detecta ConsoleMessagingProvider direto no AppModule', () => mutacao(
  'apps/api/src/app.module.ts',
  '{ provide: MESSAGING_PROVIDER, useFactory: () => identityMessagingProviderFromEnv() }',
  '{ provide: MESSAGING_PROVIDER, useClass: ConsoleMessagingProvider }',
));
test('detecta console liberado em produção', () => mutacao(
  'packages/identity/src/messaging.ts',
  "if (process.env['NODE_ENV'] === 'production')",
  "if (process.env['NODE_ENV'] === 'never')",
));
test('detecta remoção do provider Meta de identidade', () => mutacao(
  'packages/identity/src/messaging.ts',
  'export class MetaIdentityMessagingProvider implements MessagingProvider',
  'class MetaIdentityMessagingProviderRemovido implements MessagingProvider',
));
test('detecta template OTP ausente', () => mutacao(
  'packages/identity/src/messaging.ts',
  "const otpTemplate = (env['IDENTITY_WHATSAPP_OTP_TEMPLATE'] ?? '').trim();",
  "const otpTemplate = (env['OTP_TEMPLATE_REMOVIDO'] ?? '').trim();",
));
test('detecta OTP revertendo entrega incerta', () => mutacao(
  'packages/identity/src/otp.ts',
  'erro instanceof MessagingDeliveryUnknownError',
  'false && erro instanceof MessagingDeliveryUnknownError',
));
test('detecta preflight permitindo console', () => mutacao(
  'scripts/verificar-configuracao-producao.mjs',
  "erros.push('IDENTITY_MESSAGING_MODO=console é proibido em produção');",
  "void identityMessaging;",
));
test('detecta plan_id fora do gatilho comercial', () => mutacao(
  'packages/db/migrations/0116_recheck_final_hardening.sql',
  'NEW.plan_id IS DISTINCT FROM OLD.plan_id',
  'FALSE /* plan_id removido */',
));
test('detecta blocked_reason fora do gatilho comercial', () => mutacao(
  'packages/db/migrations/0116_recheck_final_hardening.sql',
  'NEW.blocked_reason IS DISTINCT FROM OLD.blocked_reason',
  'FALSE /* motivo removido */',
));
test('detecta recheck removido do verify', () => mutacao(
  'scripts/verify.sh',
  'lancar "auditoria Recheck Final" node scripts/verificar-recheck-final.mjs',
  'echo "recheck removido"',
));
