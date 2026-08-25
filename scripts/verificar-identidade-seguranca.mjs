#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (p) => readFileSync(resolve(raiz, p), 'utf8');

export function falhasDaIdentidade(fontes = {}) {
  const otp = fontes.otp ?? ler('packages/identity/src/otp.ts');
  const staff = fontes.staff ?? ler('packages/identity/src/staff.ts');
  const mfa = fontes.mfa ?? ler('packages/identity/src/mfa-staff.ts');
  const controller = fontes.controller ?? ler('apps/api/src/admin/admin.controller.ts');
  const env = fontes.env ?? ler('.env.example');
  const compose = fontes.compose ?? ler('deploy/compose.yml');
  const segredos = fontes.segredos ?? ler('deploy/segredos.sh');
  const preflight = fontes.preflight ?? ler('scripts/verificar-configuracao-producao.mjs');
  const adminControllers = fontes.adminControllers ?? Object.fromEntries(
    readdirSync(resolve(raiz, 'apps/api/src/admin'))
      .filter((nome) => nome.endsWith('controller.ts'))
      .map((nome) => [nome, ler(`apps/api/src/admin/${nome}`)]),
  );

  const falhas = [];

  if (!otp.includes("createHmac('sha256', otpPepper())")) {
    falhas.push('OTP de 6 dígitos não usa HMAC-SHA256 com pepper fora do banco');
  }
  if (!otp.includes("process.env['OTP_PEPPER']") || !otp.includes('valor.length < 32')) {
    falhas.push('OTP_PEPPER não é obrigatório com mínimo de 32 caracteres');
  }
  if (/code_hash[^\n]*sha256\(/.test(otp) || /sha256\(generated\)/.test(otp)) {
    falhas.push('OTP voltou a usar SHA-256 puro para código de baixa entropia');
  }

  if (!controller.includes('issueSession: false')) {
    falhas.push('cadastro público voltou a emitir sessão cujo token não é entregue');
  }
  if (!controller.includes('await revokeStaffSessionByToken(sessao.token)')) {
    falhas.push('login bloqueado volta a deixar sessão descartada viva');
  }

  if (!staff.includes('signup-email:') || !staff.includes('pg_advisory_xact_lock')) {
    falhas.push('cadastro não serializa concorrência pelo e-mail');
  }
  if (!staff.includes('signup-slug:')) {
    falhas.push('cadastro não serializa concorrência pela raiz do slug');
  }
  if (!staff.includes('AND s.staff_user_id = ${request.staffUserId}::uuid')) {
    falhas.push('troca de unidade da sessão não amarra explicitamente a sessão ao próprio usuário');
  }
  if (!mfa.includes('AND staff_user_id = ${params.staffUserId}::uuid')) {
    falhas.push('prova MFA não amarra explicitamente a sessão ao próprio usuário');
  }

  for (const [nome, fonte] of [['.env.example', env], ['deploy/compose.yml', compose], ['deploy/segredos.sh', segredos]]) {
    if (!fonte.includes('OTP_PEPPER')) falhas.push(`${nome} não provisiona OTP_PEPPER`);
  }
  if (!preflight.includes("['STAFF_EMAIL_PEPPER', 'OTP_PEPPER', 'API_KEY_PEPPER']")) {
    falhas.push('preflight de produção não exige peppers fortes de identidade');
  }

  // Toda porta administrativa, exceto signup/login, precisa passar por sessão
  // e permissão. Removemos comentários antes de contar para a documentação não
  // conseguir satisfazer a guarda por acidente.
  for (const [nome, bruto] of Object.entries(adminControllers)) {
    const codigo = bruto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const rotas = (codigo.match(/@(Get|Post|Put|Patch|Delete)\s*\(/g) ?? []).length;
    const exige = (codigo.match(/@Exige\s*\(/g) ?? []).length;

    if (nome === 'admin.controller.ts') {
      if (rotas - exige !== 2 || !codigo.includes("@Post('signup')") || !codigo.includes("@Post('login')")) {
        falhas.push('admin.controller.ts deve ter somente signup/login como rotas públicas');
      }
      if (!codigo.includes('@UseGuards(StaffGuard, PermissaoGuard)')) {
        falhas.push('onboarding administrativo perdeu StaffGuard/PermissaoGuard');
      }
      continue;
    }

    if (rotas > 0 && !codigo.includes('@UseGuards(StaffGuard, PermissaoGuard)')) {
      falhas.push(`${nome} perdeu StaffGuard/PermissaoGuard`);
    }
    if (rotas !== exige) {
      falhas.push(`${nome} tem rota administrativa sem @Exige`);
    }
  }

  return falhas;
}

const direto = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direto) {
  const falhas = falhasDaIdentidade();
  if (falhas.length) {
    console.error(falhas.map((f) => `FAIL: ${f}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('identidade/tenant: guardas de segurança OK');
  }
}
