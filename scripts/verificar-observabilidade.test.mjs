#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { avaliarObservabilidade } from './verificar-observabilidade.mjs';

const ler = (p) => readFileSync(p, 'utf8');
const base = {
  logApi: ler('apps/api/src/common/log.ts'),
  interceptorApi: ler('apps/api/src/common/log.interceptor.ts'),
  health: ler('apps/api/src/common/health.controller.ts'),
  logWorker: ler('apps/worker/src/log.ts'),
  mainWorker: ler('apps/worker/src/main.ts'),
  jobsWorker: ler('packages/jobs/src/worker.ts'),
  jobsObs: ler('packages/jobs/src/observabilidade.ts'),
  meta: {
    provider: ler('packages/crm/src/whatsapp-meta.ts'),
    signup: ler('packages/crm/src/whatsapp-signup.ts'),
  },
  cobranca: ler('packages/finance/src/cobranca-online.ts'),
};

const mutacoes = [
  ['request id de resposta', { ...base, interceptorApi: base.interceptorApi.replace("resposta.setHeader('x-request-id', requisicaoId);", '') }],
  ['console solto no worker', { ...base, mainWorker: `${base.mainWorker}\nconsole.log('x');` }],
  ['tarefa sem id', { ...base, mainWorker: base.mainWorker.replace('tarefaId: evento.tarefaId,', '') }],
  ['jobs sem retry/falha', { ...base, jobsObs: base.jobsObs.replace("readonly fase: 'reagendada' | 'falhou';", "readonly fase: 'falhou';") }],
  ['fila com mensagem crua', { ...base, jobsWorker: base.jobsWorker.replace('resumoPersistivelDoErro(erro)', "erro instanceof Error ? erro.message : String(erro)") }],
  ['mensagem Meta no log', { ...base, meta: { ...base.meta, provider: base.meta.provider.replace('fbtrace: erro?.fbtrace_id ?? null,', "fbtrace: erro?.fbtrace_id ?? null,\n        mensagem: erro?.message ?? null,") } }],
  ['erro financeiro cru', { ...base, cobranca: base.cobranca.replace('{ chargeId: viva.id, ...erroSeguroParaLog(erro) }', '{ chargeId: viva.id, erro }') }],
];

let pegas = 0;
for (const [nome, fontes] of mutacoes) {
  const falhas = avaliarObservabilidade(fontes);
  if (falhas.length === 0) {
    console.error(`Mutação não detectada: ${nome}`);
    process.exitCode = 1;
  } else {
    pegas += 1;
  }
}
if (!process.exitCode) console.log(`Observabilidade — negativos: ${pegas}/${mutacoes.length} mutações detectadas`);
