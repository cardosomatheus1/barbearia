import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { falhasDoHardening } from './verificar-hardening-integracoes.mjs';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fontes = {
  stripe: readFileSync(resolve(raiz, 'packages/platform/src/stripe.ts'), 'utf8'),
  adquirente: readFileSync(resolve(raiz, 'packages/platform/src/adquirente.ts'), 'utf8'),
  s3: readFileSync(resolve(raiz, 'apps/api/src/media/storage.ts'), 'utf8'),
  compose: readFileSync(resolve(raiz, 'deploy/compose.yml'), 'utf8'),
  preflight: readFileSync(resolve(raiz, 'scripts/verificar-configuracao-producao.mjs'), 'utf8'),
};

test('estado atual está protegido', () => assert.deepEqual(falhasDoHardening(fontes), []));
const mutacoes = [
  ['timeout Stripe', { stripe: fontes.stripe.replace('AbortSignal.timeout(15_000)', 'undefined') }],
  ['redirect Stripe', { stripe: fontes.stripe.replace("redirect: 'manual'", "redirect: 'follow'") }],
  ['PSP fake', { adquirente: fontes.adquirente.replace("modo === 'fake' && process.env['NODE_ENV'] === 'production'", "modo === 'nunca'") }],
  ['S3 HTTP', { s3: fontes.s3.replace('media_s3_http_proibido_em_producao', 'apagado') }],
  ['preflight no deploy', { compose: fontes.compose.replace('node scripts/verificar-configuracao-producao.mjs', ': # removido') }],
];
for (const [nome, alteracao] of mutacoes) {
  test(`detecta regressão: ${nome}`, () => assert.ok(falhasDoHardening({ ...fontes, ...alteracao }).length > 0));
}
