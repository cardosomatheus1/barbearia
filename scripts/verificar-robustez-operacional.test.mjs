#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { avaliarRobustez } from './verificar-robustez-operacional.mjs';

const ler = (p) => readFileSync(p, 'utf8');
const base = {
  botao: ler('apps/web/src/app/admin/botao-de-envio.tsx'),
  fluxos: {
    caixa: ler('apps/web/src/app/admin/caixa/page.tsx'),
    comanda: ler('apps/web/src/app/admin/comanda/[id]/page.tsx'),
  },
  comandaPagina: ler('apps/web/src/app/admin/comanda/[id]/page.tsx'),
  acaoComanda: ler('apps/web/src/app/admin/acoes/agenda-financeiro.ts'),
  clienteAdmin: ler('apps/web/src/lib/admin-api/core.ts') + '\n' + ler('apps/web/src/lib/admin-api/financeiro-operacional.ts'),
  controller: ler('apps/api/src/admin/caixa.controller.ts'),
  comandaDominio: ler('packages/finance/src/comanda.ts'),
  migracao: ler('packages/db/migrations/0109_item_da_comanda_idempotente.sql'),
  adminApi: ler('apps/web/src/lib/admin-api/core.ts'),
  publicApi: ler('apps/web/src/lib/api.ts'),
  media: ler('apps/web/src/app/media/[tenantId]/[arquivo]/route.ts'),
  erroAdmin: ler('apps/web/src/app/admin/error.tsx'),
};
assert.deepEqual(avaliarRobustez(base), []);

const mutar = (campo, de, para = '') => ({ ...base, [campo]: base[campo].replace(de, para) });
const casos = [
  ['pending', { ...base, botao: base.botao.replaceAll('useFormStatus', 'useFormStateInexistente') }],
  ['idempotência da tela', { ...base, comandaPagina: base.comandaPagina.replace(/(<form action=\{acaoAdicionarItem\}[\s\S]{0,300})name="idempotencyKey"/, '$1name="semChave"') }],
  ['lock do domínio', { ...base, comandaDominio: base.comandaDominio.replaceAll('pg_advisory_xact_lock', 'sem_lock') }],
  ['fingerprint', { ...base, migracao: base.migracao.replaceAll('idempotency_fingerprint', 'fingerprint_removido') }],
  ['transporte admin', { ...base, adminApi: base.adminApi.replace("code: 'api_indisponivel'", "code: 'request_failed'") }],
  ['transporte público', { ...base, publicApi: base.publicApi.replace('async function fetchPublicoSeguro', 'async function fetchPublicoSemGuarda') }],
  ['proxy de mídia', { ...base, media: base.media.replace('status: 503', 'status: 500') }],
  ['recuperação ambígua', { ...base, erroAdmin: base.erroAdmin.replace('confira o resultado antes de', 'repita imediatamente') }],
];

for (const [nome, fontes] of casos) {
  assert.ok(avaliarRobustez(fontes).length > 0, `deveria detectar ${nome}`);
}
console.log(`${casos.length}/${casos.length} mutações negativas de robustez detectadas`);
