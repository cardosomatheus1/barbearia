#!/usr/bin/env node
import { readFileSync } from 'node:fs';

export function avaliarObservabilidade(fontes) {
  const falhas = [];
  const exigir = (ok, msg) => { if (!ok) falhas.push(msg); };

  exigir(fontes.logApi.includes("requisicaoId"), 'API precisa registrar request id');
  exigir(fontes.interceptorApi.includes("setHeader('x-request-id'"), 'API precisa devolver x-request-id ao chamador');
  exigir(fontes.health.includes("@Get('pronto')"), 'API precisa expor readiness separado de liveness');
  exigir(fontes.health.includes('rolbypassrls'), 'readiness precisa conferir bypass de RLS');

  exigir(fontes.logWorker.includes("processo: 'worker'"), 'worker precisa usar log JSON estruturado');
  exigir(fontes.logWorker.includes('erroSeguro'), 'worker precisa sanitizar erro antes de logar');
  exigir(!fontes.mainWorker.includes('console.'), 'main do worker não deve emitir console solto');
  exigir(fontes.mainWorker.includes("logWorker(`tarefa.${evento.fase}`"), 'worker precisa registrar ciclo de cada tarefa');
  exigir(fontes.mainWorker.includes('tarefaId: evento.tarefaId'), 'log da tarefa precisa carregar tarefaId');
  exigir(fontes.mainWorker.includes('tenantId: evento.tenantId'), 'log da tarefa precisa carregar tenantId');
  exigir(fontes.mainWorker.includes('duracaoMs: evento.duracaoMs'), 'log da tarefa precisa carregar duração');

  exigir(fontes.jobsObs.includes("readonly fase: 'inicio'"), 'jobs precisa emitir evento de início');
  exigir(fontes.jobsObs.includes("readonly fase: 'reagendada' | 'falhou'"), 'jobs precisa distinguir retry de falha terminal');
  exigir(fontes.jobsObs.includes('identificarErroDaTarefa'), 'jobs precisa reduzir erro a tipo/código seguro');
  exigir(fontes.jobsObs.includes('resumoPersistivelDoErro'), 'jobs precisa sanitizar também o erro persistido na fila');
  exigir(fontes.jobsWorker.includes('resumoPersistivelDoErro(erro)'), 'worker não pode persistir erro.message bruto em jobs.last_error');
  exigir(!fontes.jobsWorker.includes('console.'), 'pacote jobs não deve escolher formato/destino do log');

  for (const [nome, fonte] of Object.entries(fontes.meta)) {
    const trecho = fonte.slice(Math.max(0, fonte.indexOf("console.error('[whatsapp] a Meta recusou'") - 100), fonte.indexOf("console.error('[whatsapp] a Meta recusou'") + 700);
    exigir(!/mensagem\s*:/.test(trecho), `${nome}: log de recusa Meta não pode persistir mensagem do provedor`);
    exigir(/fbtrace/.test(trecho), `${nome}: log Meta precisa preservar fbtrace para suporte`);
  }

  exigir(fontes.cobranca.includes('erroSeguroParaLog'), 'cobrança precisa sanitizar exceção de provedor');
  exigir(!/conciliação falhou'[^\n]*\{[^\n]*\berro\s*\}/.test(fontes.cobranca), 'cobrança não pode logar objeto de erro cru');
  exigir(!/conclusão falhou'[^\n]*\{[^\n]*\berro\s*\}/.test(fontes.cobranca), 'conclusão não pode logar objeto de erro cru');

  return falhas;
}

function ler(p) { return readFileSync(p, 'utf8'); }

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const fontes = {
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
  const falhas = avaliarObservabilidade(fontes);
  if (falhas.length) {
    console.error(`Observabilidade reprovada (${falhas.length})`);
    falhas.forEach((f) => console.error(`- ${f}`));
    process.exit(1);
  }
  console.log('Observabilidade: request id, readiness, tarefas e logs sensíveis cobertos');
}
