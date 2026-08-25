import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const raiz = process.cwd();
const arquivos = [
  'packages/jobs/src/fila.ts','packages/jobs/src/worker.ts','packages/jobs/src/notificacoes.ts','packages/jobs/src/webhook.ts',
  'packages/platform/src/conciliacao.ts','packages/platform/src/cobranca.ts','packages/platform/src/gestor.ts','packages/platform/src/aviso-operacional.ts',
  'packages/finance/src/fiscal-emissao.ts','apps/worker/src/main.ts','packages/scheduling/src/booking.ts','packages/scheduling/src/dayboard.ts',
  'packages/finance/src/comanda.ts','packages/db/migrations/0115_platform_jobs_integracoes.sql','packages/db/test/0115_platform_jobs_integracoes.test.sql',
  'scripts/verificar-auditoria-platform-jobs.mjs',
];

function mutacao(rel, de, para) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barberdock-platform-jobs-'));
  for (const arq of arquivos) {
    const dst = path.join(tmp, arq); fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(raiz, arq), dst);
  }
  const alvo = path.join(tmp, rel); const antes = fs.readFileSync(alvo, 'utf8');
  assert.ok(antes.includes(de), `fixture não contém mutação: ${de.slice(0, 90)}`);
  fs.writeFileSync(alvo, antes.replaceAll(de, para));
  const r = spawnSync(process.execPath, ['scripts/verificar-auditoria-platform-jobs.mjs'], { cwd: tmp, encoding: 'utf8' });
  assert.notEqual(r.status, 0, `guarda aceitou regressão em ${rel}`);
}

test('detecta órfã esgotada reaberta', () => mutacao('packages/jobs/src/fila.ts', "status = 'failed', last_error = 'worker_orphaned'", "status = 'pending', last_error = 'worker_orphaned'"));
test('detecta claim além do teto', () => mutacao('packages/jobs/src/fila.ts', 'AND attempts < max_attempts', 'AND attempts >= 0'));
test('detecta remoção de heartbeat', () => mutacao('packages/jobs/src/worker.ts', 'renovarTarefa(tarefa, contexto.relogio.agora())', 'Promise.resolve(true)'));
test('detecta cancelamento de job sem tenant', () => mutacao('packages/jobs/src/fila.ts', "tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid", '1 = 1'));
test('detecta régua global fora do isolamento', () => mutacao('packages/jobs/src/worker.ts', "executarGlobal('cobranca.regua'", "executarSemIsolamento('cobranca.regua'"));
test('detecta perda do log de falha global', () => mutacao('apps/worker/src/main.ts', "logWorker('worker.global_falhou'", "logWorker('worker.global_ignorado'"));
test('detecta console de cliente aceito em produção', () => mutacao('packages/jobs/src/notificacoes.ts', 'notification_console_forbidden_in_production', 'notification_console_ok_in_production'));
test('detecta console do gestor aceito em produção', () => mutacao('packages/platform/src/gestor.ts', 'console_delivery_forbidden_in_production', 'console_delivery_ok_in_production'));
test('detecta PSP voltando a baixa fora da transação', () => mutacao('packages/platform/src/conciliacao.ts', 'pagarFaturaNaTransacao(tx', 'pagarFatura('));
test('detecta pagamento PSP sem fencing de charge', () => mutacao('packages/platform/src/conciliacao.ts', 'chargeIdEsperado: evento.chargeId', 'chargeIdEsperado: undefined'));
test('detecta recusa PSP sem fencing de charge', () => mutacao('packages/platform/src/conciliacao.ts', 'AND psp_charge_id = ${evento.chargeId}', 'AND true'));
test('detecta compensação concorrente de estorno sem claim', () => mutacao(
  'packages/platform/src/conciliacao.ts',
  "const falhadas = await tx.$executeRaw`\n          UPDATE refunds SET status = 'failed'\n           WHERE id = ${lancamento.id}::uuid AND status = 'pending'",
  "const falhadas = await tx.$executeRaw`\n          UPDATE refunds SET status = 'failed'\n           WHERE id = ${lancamento.id}::uuid",
));
test('detecta fiscal sem estado esperado', () => mutacao('packages/finance/src/fiscal-emissao.ts', 'AND status = ${params.estadoEsperado}::fiscal_invoice_status', "AND status::text = ANY(${[...ESTADOS_EM_VOO]}::text[])"));
test('detecta cancelamento fiscal reaberto por resposta velha', () => mutacao('packages/finance/src/fiscal-emissao.ts', "WHEN ${params.estadoEsperado} = 'cancelando' AND NOT ${cancelamentoConcluido}", 'WHEN false'));
test('detecta webhook com tenant paralelo', () => mutacao('packages/jobs/src/webhook.ts', 'export interface EventoParaEntregar {', 'export interface EventoParaEntregar {\n  readonly tenantId: string;'));
test('detecta webhook enfileirado por tenant fornecido', () => mutacao('packages/jobs/src/webhook.ts', 'await enfileirar(tx, {', 'await enfileirarPara(tx, entrada.tenantId, {'));
test('detecta remoção da FK composta de webhook', () => mutacao('packages/db/migrations/0115_platform_jobs_integracoes.sql', 'webhook_deliveries_endpoint_do_tenant_fk', 'webhook_deliveries_endpoint_sem_tenant_fk'));
test('detecta remoção do outcome fechado do PSP', () => mutacao('packages/db/migrations/0115_platform_jobs_integracoes.sql', "outcome IN ('paid', 'failed', 'ignored')", 'outcome IS NOT NULL'));
test('detecta prova SQL sem caso cross-tenant', () => mutacao('packages/db/test/0115_platform_jobs_integracoes.test.sql', 'entrega cross-tenant foi aceita', 'teste cross-tenant removido'));
