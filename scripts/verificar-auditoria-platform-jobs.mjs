import fs from 'node:fs';

const ler = (p) => fs.readFileSync(p, 'utf8');
const falhas = [];
const exigir = (ok, mensagem) => { if (!ok) falhas.push(mensagem); };

const fila = ler('packages/jobs/src/fila.ts');
const worker = ler('packages/jobs/src/worker.ts');
const notificacoes = ler('packages/jobs/src/notificacoes.ts');
const webhook = ler('packages/jobs/src/webhook.ts');
const conciliacao = ler('packages/platform/src/conciliacao.ts');
const cobranca = ler('packages/platform/src/cobranca.ts');
const gestor = ler('packages/platform/src/gestor.ts');
const operacao = ler('packages/platform/src/aviso-operacional.ts');
const fiscal = ler('packages/finance/src/fiscal-emissao.ts');
const main = ler('apps/worker/src/main.ts');
const booking = ler('packages/scheduling/src/booking.ts');
const dayboard = ler('packages/scheduling/src/dayboard.ts');
const comanda = ler('packages/finance/src/comanda.ts');
const migracao = ler('packages/db/migrations/0115_platform_jobs_integracoes.sql');
const testeSql = ler('packages/db/test/0115_platform_jobs_integracoes.test.sql');

// Fila: teto de tentativa é teto mesmo quando o processo morre.
exigir(fila.includes("AND attempts < max_attempts")
  && fila.includes("status = 'failed', last_error = 'worker_orphaned'")
  && fila.includes("WHERE status = 'pending' AND attempts >= max_attempts"),
  'fila voltou a reclamar job acima do teto ou a reabrir órfã esgotada');
exigir(fila.includes('export async function renovarTarefa')
  && fila.includes('AND claim_token = ${tarefa.claimToken}::uuid')
  && worker.includes('renovarTarefa(tarefa, contexto.relogio.agora())')
  && worker.includes('5 * 60_000'),
  'handler longo perdeu heartbeat/fencing da claim');
exigir(fila.includes("tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid")
  && fila.indexOf("tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid") < fila.indexOf("idempotency_key = ANY"),
  'cancelamento de jobs voltou a depender só de idempotency_key global');

// Falha global não mata o processo e marcador só avança após sucesso.
exigir(worker.includes('const executarGlobal = async')
  && worker.includes("tentarDepoisDe.set(operacao, agora + Math.max(intervalo, 60_000))")
  && worker.includes("executarGlobal('cobranca.regua'")
  && worker.includes('if (ok) ultimaRegua = hoje')
  && worker.includes("executarGlobal('integracoes.varredura_global'")
  && worker.includes("executarGlobal('fila.rodada'"),
  'worker voltou a morrer por falha de manutenção global ou a suprimir retry após falha');
exigir(main.includes("logWorker('worker.global_falhou'") && main.includes('aoErroGlobal:'),
  'falha global do worker deixou de ter observabilidade sanitizada');

// Console é desenvolvimento, não recibo de entrega.
exigir(notificacoes.includes("notification_console_forbidden_in_production")
  && notificacoes.includes("process.env['NODE_ENV'] === 'production'")
  && gestor.includes('console_delivery_forbidden_in_production')
  && operacao.includes('console_delivery_forbidden_in_production'),
  'provedor de console voltou a poder confirmar entrega em produção');

// PSP: evento e dinheiro no mesmo commit, com fencing da cobrança correta.
exigir(conciliacao.includes('return semTenant(async (tx) => {')
  && conciliacao.includes('INSERT INTO psp_events')
  && conciliacao.includes('FOR UPDATE')
  && conciliacao.includes('pagarFaturaNaTransacao(tx')
  && conciliacao.includes('encerrarEventoNaTransacao(tx')
  && !conciliacao.includes('const novo = await semTenant(async (tx) => registrarEvento'),
  'PSP voltou a registrar evento e aplicar dinheiro em commits separados');
exigir(cobranca.includes('export async function pagarFaturaNaTransacao')
  && cobranca.includes('chargeIdEsperado')
  && cobranca.includes('OR psp_charge_id = ${entrada.chargeIdEsperado ?? null}')
  && conciliacao.includes('chargeIdEsperado: evento.chargeId')
  && conciliacao.includes('AND psp_charge_id = ${evento.chargeId}'),
  'evento velho do PSP voltou a poder atingir cobrança nova');
exigir(conciliacao.includes('if (existentes[0]?.processed_at) return \'ignored\';'),
  'evento PSP legado pendente deixou de ser retomável');
exigir(conciliacao.includes("const falhadas = await tx.$executeRaw`\n          UPDATE refunds SET status = 'failed'\n           WHERE id = ${lancamento.id}::uuid AND status = 'pending'")
  && conciliacao.includes('if (falhadas > 0) {'),
  'recusa concorrente de estorno voltou a poder devolver o crédito duas vezes');

// Fiscal: resposta externa precisa ser fenced pelo estado observado.
exigir(fiscal.includes("readonly estadoEsperado: 'processando' | 'cancelando'")
  && fiscal.includes('AND status = ${params.estadoEsperado}::fiscal_invoice_status')
  && fiscal.includes("params.estadoEsperado === 'cancelando' && params.resposta.estado === 'cancelada'")
  && fiscal.includes("WHEN ${params.estadoEsperado} = 'cancelando' AND NOT ${cancelamentoConcluido}"),
  'fiscal voltou a aceitar resposta atrasada sobre estado diferente');
exigir(fiscal.includes("estadoEsperado: 'processando'") && fiscal.includes('estadoEsperado: nota.status'),
  'emissão/conciliação fiscal deixou de transportar o fencing de estado');

// Webhook de saída herda tenant da própria transação; não aceita dono paralelo.
exigir(!webhook.includes('readonly tenantId: string;')
  && webhook.includes("import { enfileirar } from './fila.js';")
  && webhook.includes('await enfileirar(tx, {')
  && !webhook.includes('enfileirarPara(tx, entrada.tenantId'),
  'webhook de saída voltou a aceitar tenant redundante divergente');
for (const [nome, fonte] of [['booking', booking], ['dayboard', dayboard], ['comanda', comanda]]) {
  exigir(!/registrarEventoDeWebhook\(tx, \{\s*tenantId:/m.test(fonte), `${nome} voltou a passar tenant redundante ao webhook`);
}

// Banco fecha invariantes que RLS/código sozinhos não devem carregar.
exigir(migracao.includes('webhook_endpoints_tenant_id_id_key UNIQUE (tenant_id, id)')
  && migracao.includes('webhook_deliveries_endpoint_do_tenant_fk')
  && migracao.includes('FOREIGN KEY (tenant_id, endpoint_id)')
  && migracao.includes("outcome IN ('paid', 'failed', 'ignored')")
  && migracao.includes("status IN ('pending', 'running')") && migracao.includes('attempts >= max_attempts'),
  'migração 0115 perdeu FK cross-tenant, saneamento da fila ou outcome do PSP');
exigir(testeSql.includes('entrega cross-tenant foi aceita')
  && testeSql.includes('PSP aceitou outcome fora da máquina de estados'),
  'prova SQL 0115 não cobre isolamento de webhook e outcome do PSP');

if (falhas.length) {
  console.error(`Auditoria Platform/Jobs: ${falhas.length} falha(s)`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}
console.log('Auditoria Platform/Jobs: leases, PSP, fiscal, webhooks e falhas globais preservados');
