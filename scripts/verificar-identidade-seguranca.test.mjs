import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { falhasDaIdentidade } from './verificar-identidade-seguranca.mjs';

const fontes = {
  otp: readFileSync('packages/identity/src/otp.ts', 'utf8'),
  staff: readFileSync('packages/identity/src/staff.ts', 'utf8'),
  mfa: readFileSync('packages/identity/src/mfa-staff.ts', 'utf8'),
  controller: readFileSync('apps/api/src/admin/admin.controller.ts', 'utf8'),
  env: readFileSync('.env.example', 'utf8'),
  compose: readFileSync('deploy/compose.yml', 'utf8'),
  segredos: readFileSync('deploy/segredos.sh', 'utf8'),
  preflight: readFileSync('scripts/verificar-configuracao-producao.mjs', 'utf8'),
  adminControllers: Object.fromEntries(
    readdirSync('apps/api/src/admin')
      .filter((nome) => nome.endsWith('controller.ts'))
      .map((nome) => [nome, readFileSync(`apps/api/src/admin/${nome}`, 'utf8')]),
  ),
};

test('identidade atual cumpre guardas novas', () => {
  assert.deepEqual(falhasDaIdentidade(fontes), []);
});

const mutacoes = [
  ['OTP sem HMAC', { otp: fontes.otp.replace("createHmac('sha256', otpPepper())", "createHash('sha256')") }],
  ['cadastro com sessão fantasma', { controller: fontes.controller.replace('issueSession: false', 'issueSession: true') }],
  ['login bloqueado sem revogação', { controller: fontes.controller.replace('await revokeStaffSessionByToken(sessao.token);', '/* sem limpeza */') }],
  ['sem lock de e-mail', { staff: fontes.staff.replace('signup-email:', 'signup-email-removido:') }],
  ['sem lock de slug', { staff: fontes.staff.replace('signup-slug:', 'signup-slug-removido:') }],
  ['sessão/unidade sem dono', { staff: fontes.staff.replace('AND s.staff_user_id = ${request.staffUserId}::uuid', 'AND true') }],
  ['MFA sem dono da sessão', { mfa: fontes.mfa.replace('AND staff_user_id = ${params.staffUserId}::uuid', 'AND true') }],
  ['OTP pepper fora do compose', { compose: fontes.compose.replace(/\n\s*OTP_PEPPER:[^\n]*/m, '') }],
  ['rota admin sem permissão', {
    adminControllers: {
      ...fontes.adminControllers,
      'clientes.controller.ts': fontes.adminControllers['clientes.controller.ts'].replace(/@Exige\([^\n]*\)\s*/, ''),
    },
  }],
];

for (const [nome, alteracao] of mutacoes) {
  test(`detecta regressão: ${nome}`, () => {
    assert.ok(falhasDaIdentidade({ ...fontes, ...alteracao }).length > 0);
  });
}
