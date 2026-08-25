#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (caminho) => readFileSync(resolve(raiz, caminho), 'utf8');

export function falhasDoHardening(fontes = {}) {
  const stripe = fontes.stripe ?? ler('packages/platform/src/stripe.ts');
  const adquirente = fontes.adquirente ?? ler('packages/platform/src/adquirente.ts');
  const s3 = fontes.s3 ?? ler('apps/api/src/media/storage.ts');
  const compose = fontes.compose ?? ler('deploy/compose.yml');
  const preflight = fontes.preflight ?? ler('scripts/verificar-configuracao-producao.mjs');
  const falhas = [];

  if (!stripe.includes("redirect: 'manual'")) falhas.push('Stripe pode seguir redirect com Authorization');
  if (!stripe.includes('AbortSignal.timeout(15_000)')) falhas.push('Stripe sem timeout explícito');
  if (!stripe.includes('stripe_invalid_response')) falhas.push('Stripe não tipa resposta inválida');
  if (!stripe.includes('StripeTransportError')) falhas.push('Stripe não separa falha de transporte');
  if (!adquirente.includes("modo === 'fake' && process.env['NODE_ENV'] === 'production'")) falhas.push('PSP fake ainda pode entrar em produção');
  if (!s3.includes('media_s3_http_proibido_em_producao')) falhas.push('S3 HTTP não é bloqueado por padrão em produção');
  if (!s3.includes('endpoint.username || endpoint.password || endpoint.search || endpoint.hash')) falhas.push('endpoint S3 aceita segredo/query na URL');
  if (!s3.includes("error instanceof Error ? error.name : 'unknown'")) falhas.push('S3 propaga detalhe bruto de erro de rede');
  if (!compose.includes('node scripts/verificar-configuracao-producao.mjs')) falhas.push('deploy não executa preflight de produção');
  if (!preflight.includes('STRIPE_SECRET_KEY de teste é proibida em produção')) falhas.push('preflight não bloqueia Stripe test em produção');
  if (!preflight.includes('Embedded Signup parcialmente configurado')) falhas.push('preflight não detecta Meta parcial');
  if (!preflight.includes('WHATSAPP_MODO=meta exige')) falhas.push('preflight não cobra segredos do WhatsApp Meta');
  return falhas;
}

const direto = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direto) {
  const falhas = falhasDoHardening();
  if (falhas.length) {
    console.error(falhas.map((f) => `FAIL: ${f}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('hardening de integrações: OK');
  }
}
