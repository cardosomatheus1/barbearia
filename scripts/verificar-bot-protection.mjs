#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (p) => readFileSync(resolve(raiz, p), 'utf8');

export function falhasDaProtecaoAntiBot(fontes = {}) {
  const turnstile = fontes.turnstile ?? ler('apps/api/src/common/turnstile.ts');
  const controller = fontes.controller ?? ler('apps/api/src/admin/admin.controller.ts');
  const schema = fontes.schema ?? ler('apps/api/src/admin/admin.schemas.ts');
  const page = fontes.page ?? ler('apps/web/src/app/admin/criar-conta/page.tsx');
  const action = fontes.action ?? ler('apps/web/src/app/admin/acoes/onboarding.ts');
  const middleware = fontes.middleware ?? ler('apps/web/src/middleware.ts');
  const preflight = fontes.preflight ?? ler('scripts/verificar-configuracao-producao.mjs');
  const compose = fontes.compose ?? ler('deploy/compose.yml');
  const appModule = fontes.appModule ?? ler('apps/api/src/app.module.ts');
  const throttler = fontes.throttler ?? ler('apps/api/src/common/throttler.config.ts');
  const falhas = [];

  if (!turnstile.includes('/turnstile/v0/siteverify')) falhas.push('API não valida Turnstile no Siteverify');
  if (!turnstile.includes("redirect: 'error'")) falhas.push('Siteverify pode seguir redirect');
  if (!turnstile.includes('AbortSignal.timeout(')) falhas.push('Siteverify sem timeout');
  if (!turnstile.includes('dados.action !== params.action')) falhas.push('Siteverify não vincula token à action');
  if (!turnstile.includes('hostnames.has(dados.hostname.toLowerCase())')) falhas.push('Siteverify não valida hostname');
  if (!controller.includes('await verificarTurnstile({')) falhas.push('signup não chama validação server-side');
  if (!controller.includes("action: 'signup'")) falhas.push('signup não vincula action do Turnstile');
  if (!controller.includes("'bot_verification_failed'")) falhas.push('falha anti-bot não é recusada');
  if (!schema.includes('turnstileToken:')) falhas.push('schema não limita token do Turnstile');
  if (!page.includes('className="cf-turnstile"')) falhas.push('cadastro não renderiza widget Turnstile');
  if (!page.includes('data-action="signup"')) falhas.push('widget não emite action signup');
  if (!action.includes("'cf-turnstile-response'")) falhas.push('Server Action não encaminha token');
  if (!middleware.includes("pathname === '/admin/criar-conta'")) falhas.push('CSP não limita licença do Turnstile à criação de conta');
  if (!middleware.includes('https://challenges.cloudflare.com')) falhas.push('CSP não permite Turnstile na rota protegida');
  if (!appModule.includes('ThrottlerModule.forRoot(throttlerConfig())') || !appModule.includes('{ provide: APP_GUARD, useClass: ThrottlerGuard }')) {
    falhas.push('rate limit não está aplicado globalmente pela API');
  }
  if (!throttler.includes("name: NOMES_DOS_LIMITES[0]") || !throttler.includes("name: NOMES_DOS_LIMITES[1]")) {
    falhas.push('rate limit não mantém janelas curta e longa');
  }
  if (!fontes.skipThrottleSeguro) {
    const raizApi = resolve(raiz, 'apps/api/src');
    const pilha = [raizApi];
    const indevidos = [];
    while (pilha.length) {
      const dir = pilha.pop();
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const caminho = resolve(dir, item.name);
        if (item.isDirectory()) pilha.push(caminho);
        else if (item.name.endsWith('.ts') && caminho !== resolve(raizApi, 'common/health.controller.ts')) {
          if (/^\s*@SkipThrottle\s*\(/m.test(readFileSync(caminho, 'utf8'))) indevidos.push(caminho);
        }
      }
    }
    if (indevidos.length) falhas.push('há @SkipThrottle fora do health check');
  }
  for (const env of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_HOSTNAMES']) {
    if (!preflight.includes(env)) falhas.push(`preflight não cobra ${env}`);
    if (!compose.includes(`${env}:`)) falhas.push(`compose não entrega ${env}`);
  }
  return falhas;
}

const direto = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direto) {
  const falhas = falhasDaProtecaoAntiBot();
  if (falhas.length) {
    console.error(falhas.map((f) => `FAIL: ${f}`).join('\n'));
    process.exitCode = 1;
  } else console.log('proteção anti-bot: OK');
}
