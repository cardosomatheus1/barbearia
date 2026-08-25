import fs from 'node:fs';

const ler = (p) => fs.readFileSync(p, 'utf8');
const falhas = [];
const exigir = (ok, mensagem) => { if (!ok) falhas.push(mensagem); };

const tenant = ler('apps/api/src/tenant/tenant.service.ts');
const messaging = ler('packages/identity/src/messaging.ts');
const otp = ler('packages/identity/src/otp.ts');
const app = ler('apps/api/src/app.module.ts');
const config = ler('scripts/verificar-configuracao-producao.mjs');
const mig = ler('packages/db/migrations/0116_recheck_final_hardening.sql');
const verify = ler('scripts/verify.sh');

// Cache público: TTL não é limite de memória. Tem que existir teto duro pós-expiração.
exigir(
  tenant.includes('private readonly maxCacheEntries = 10_000;')
    && tenant.includes('while (cache.size > this.maxCacheEntries)')
    && tenant.includes("this.limitarCache(this.cache, 'slugs')")
    && tenant.includes("this.limitarCache(this.bloqueios, 'bloqueios')"),
  'cache público voltou a crescer sem teto duro',
);

// Identidade: produção não pode cair no console e precisa de envio Meta real.
exigir(
  app.includes('{ provide: MESSAGING_PROVIDER, useFactory: () => identityMessagingProviderFromEnv() }')
    && !app.includes('useClass: ConsoleMessagingProvider'),
  'AppModule voltou a injetar ConsoleMessagingProvider diretamente',
);
exigir(
  messaging.includes("if (process.env['NODE_ENV'] === 'production')")
    && messaging.includes('ConsoleMessagingProvider é proibido em produção')
    && messaging.includes('export class MetaIdentityMessagingProvider implements MessagingProvider')
    && messaging.includes('https://graph.facebook.com/v21.0/${this.config.phoneNumberId}/messages')
    && messaging.includes("sub_type: 'url'")
    && messaging.includes("const otpTemplate = (env['IDENTITY_WHATSAPP_OTP_TEMPLATE'] ?? '').trim();")
    && messaging.includes("['IDENTITY_WHATSAPP_OTP_TEMPLATE', otpTemplate]")
    && messaging.includes("['IDENTITY_WHATSAPP_STAFF_TEMPLATE', staffTemplate]"),
  'mensageria de identidade perdeu fail-closed ou provider Meta real',
);
exigir(
  messaging.includes('throw new MessagingDeliveryUnknownError(')
    && otp.includes('if (erro instanceof MessagingDeliveryUnknownError) {')
    && otp.includes('resendAfterSeconds: cooldownFor(code.sendCount)'),
  'OTP voltou a invalidar código quando o desfecho externo é incerto',
);
exigir(
  config.includes("IDENTITY_MESSAGING_MODO=console é proibido em produção")
    && config.includes("'IDENTITY_WHATSAPP_PHONE_NUMBER_ID'")
    && config.includes("'IDENTITY_WHATSAPP_ACCESS_TOKEN'")
    && config.includes("'IDENTITY_WHATSAPP_OTP_TEMPLATE'")
    && config.includes("'IDENTITY_WHATSAPP_STAFF_TEMPLATE'"),
  'preflight de produção deixou de exigir mensageria real de identidade',
);

// Plataforma: plano e motivo de bloqueio são termos da plataforma, mesmo sob RLS permissiva da tabela.
exigir(
  mig.includes('NEW.plan_id IS DISTINCT FROM OLD.plan_id')
    && mig.includes('NEW.blocked_reason IS DISTINCT FROM OLD.blocked_reason')
    && mig.includes("ERRCODE = 'insufficient_privilege'"),
  'tenant_platform voltou a permitir alteração tenant-side de plano/motivo',
);

const migracoes = fs.readdirSync('packages/db/migrations')
  .filter((nome) => /^\d{4}_.+\.sql$/.test(nome))
  .sort();
const versoes = migracoes.map((nome) => nome.slice(0, 4));
exigir(new Set(versoes).size === versoes.length, 'existem versões duplicadas de migração');
exigir(versoes.at(-1) === '0117', 'head de migração do recheck não é 0117');

exigir(
  verify.includes('auditoria Recheck Final')
    && verify.includes('node scripts/verificar-recheck-final.mjs')
    && verify.includes('node --test scripts/verificar-recheck-final.test.mjs'),
  'verify.sh não executa o recheck final e sua prova negativa',
);

if (falhas.length) {
  console.error(`Recheck Final: ${falhas.length} falha(s)`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}
console.log('Recheck Final: cache público, identidade Meta e termos comerciais preservados');
