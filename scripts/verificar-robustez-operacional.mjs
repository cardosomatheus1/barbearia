#!/usr/bin/env node
import { readFileSync } from 'node:fs';

export function avaliarRobustez(fontes) {
  const falhas = [];
  const exigir = (ok, msg) => { if (!ok) falhas.push(msg); };

  const botao = fontes.botao;
  exigir(botao.includes("useFormStatus"), 'BotaoDeEnvio precisa ler pending do formulário');
  exigir(/disabled=\{bloqueado\}/.test(botao), 'BotaoDeEnvio precisa bloquear novo submit durante pending');
  exigir(/aria-busy=\{pending \|\| undefined\}/.test(botao), 'BotaoDeEnvio precisa anunciar estado ocupado');

  for (const [nome, fonte] of Object.entries(fontes.fluxos)) {
    exigir(fonte.includes('BotaoDeEnvio'), `${nome}: fluxo crítico sem feedback/bloqueio de envio`);
  }

  exigir(/<form action=\{acaoAdicionarItem\}[\s\S]{0,300}name=\"idempotencyKey\"/.test(fontes.comandaPagina), 'Comanda: inclusão precisa enviar chave de idempotência');
  exigir(/adicionarNaComanda\(token, id,[\s\S]*texto\(form, 'idempotencyKey'\)\)/.test(fontes.acaoComanda), 'Server Action precisa repassar chave do item');
  exigir(fontes.clienteAdmin.includes("'idempotency-key': idempotencyKey"), 'Cliente admin precisa enviar Idempotency-Key à API');
  exigir(fontes.controller.includes("@Headers('idempotency-key')"), 'Controller do item precisa receber Idempotency-Key');
  exigir(fontes.controller.includes('idempotencyKey.length > 128'), 'Controller precisa limitar a chave externa');
  exigir(fontes.controller.includes('`${staff.staffUserId}:${idempotencyKey}`'), 'Controller precisa escopar a chave por operador');

  exigir(fontes.comandaDominio.includes('pg_advisory_xact_lock'), 'Domínio do item precisa serializar reenvios concorrentes');
  exigir(fontes.comandaDominio.includes('idempotency_fingerprint'), 'Domínio do item precisa comparar fingerprint');
  exigir(fontes.comandaDominio.includes("'idempotencia_conflitante'"), 'Domínio precisa recusar chave reutilizada para outro item');
  exigir(fontes.migracao.includes('order_items_idempotency_idx'), 'Migração precisa criar índice único de idempotência do item');
  exigir(fontes.migracao.includes('idempotency_fingerprint'), 'Migração precisa persistir fingerprint do item');

  exigir(fontes.adminApi.includes("code: 'api_indisponivel'"), 'Cliente admin precisa transformar falha de transporte em estado recuperável');
  exigir(!/catch \(erro\)[\s\S]{0,220}throw erro/.test(fontes.adminApi), 'Cliente admin não deve relançar falha de transporte');
  exigir(fontes.publicApi.includes('async function fetchPublicoSeguro'), 'Cliente público precisa ter borda segura de transporte');
  exigir(fontes.publicApi.includes("timeout ? 'api_timeout' : 'api_indisponivel'"), 'Cliente público precisa distinguir timeout de indisponibilidade');
  exigir(fontes.media.includes('status: 503'), 'Proxy de mídia precisa degradar falha de transporte para 503');

  exigir(fontes.erroAdmin.includes('confira o resultado antes de'), 'Erro do admin precisa orientar contra repetição cega após resposta ambígua');

  return falhas;
}

function ler(caminho) { return readFileSync(caminho, 'utf8'); }

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const fontes = {
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
  const falhas = avaliarRobustez(fontes);
  if (falhas.length) {
    console.error(`Robustez operacional reprovada (${falhas.length})`);
    falhas.forEach((f) => console.error(`- ${f}`));
    process.exit(1);
  }
  console.log('Robustez operacional: envio, idempotência, transporte e recuperação cobertos');
}
