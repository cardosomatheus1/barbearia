import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raiz = join(import.meta.dirname, '..');
const ler = (p) => readFileSync(join(raiz, p), 'utf8');
const exigir = (condicao, mensagem) => { if (!condicao) throw new Error(mensagem); };

const estorno = ler('packages/finance/src/estorno.ts');
const cobrancaOnline = ler('packages/finance/src/cobranca-online.ts');
exigir(estorno.includes('estornarVendaComAdquirente'), 'estorno administrativo voltou a ignorar o adquirente');
exigir(estorno.includes('psp_refund_id'), 'estorno externo perdeu o ponto de recuperação persistido');
exigir(estorno.indexOf('params.provider.estornar') < estorno.indexOf('return estornarVenda(params)'), 'a venda local está sendo estornada antes do adquirente');

const stripe = ler('packages/platform/src/stripe-pagamento.ts');
exigir(stripe.includes("pagamentoId.startsWith('cs_')"), 'refund Stripe deixou de resolver Checkout Session');
exigir(stripe.includes('sessao.payment_intent'), 'refund de link não extrai PaymentIntent');

const controller = ler('apps/api/src/admin/dre.controller.ts');
exigir(controller.includes('estornarVendaComAdquirente'), 'rota de estorno não usa a orquestração externa');
exigir(controller.includes('adquirenteDaComanda()'), 'rota de estorno não recebe o adquirente configurado');

const migration = ler('packages/db/migrations/0099_estorno_online.sql');
for (const campo of ['refunded_at', 'psp_refund_id', 'refunded_cents']) {
  exigir(migration.includes(campo), `migration de estorno não persiste ${campo}`);
}

const slug = ler('packages/core/src/slug.ts');
exigir(slug.includes("'media'"), 'media voltou a poder ser usado como slug');
const media = ler('apps/api/src/media/media.controller.ts');
exigir(media.includes("@Param('tenantId', new ZodValidationPipe"), 'tenantId da mídia voltou a entrar sem validação');
exigir(media.includes("@Param('arquivo', new ZodValidationPipe"), 'arquivo da mídia voltou a entrar sem validação');

const plataforma = ler('apps/api/src/plataforma/plataforma.controller.ts');
exigir(plataforma.includes('ultimoDiaApurado(new Date())'), 'métricas da plataforma voltaram a usar ontem UTC sem respeitar 09:00');
const apuracao = ler('packages/core/src/apuracao.ts');
exigir(apuracao.includes('getUTCHours() >= HORA_DA_APURACAO_UTC ? 1 : 2'), 'corte da apuração diária foi alterado');


exigir(
  cobrancaOnline.includes("status IN ('aguardando', 'pago')") &&
    cobrancaOnline.includes("ON CONFLICT (order_id) WHERE status IN ('aguardando', 'pago') AND refunded_at IS NULL DO NOTHING"),
  'cobrança paga sem caixa precisa bloquear nova emissão no domínio e no conflito do banco',
);
exigir(
  cobrancaOnline.includes('WHERE location_id = ${params.locationId}::uuid\n         AND idempotency_key = ${params.idempotencyKey}'),
  'reuso de Idempotency-Key da cobrança precisa respeitar a unidade ativa',
);
const comanda = ler('packages/finance/src/comanda.ts');
exigir(
  comanda.includes('WHERE location_id = ${params.locationId}::uuid\n           AND close_idempotency_key = ${params.idempotencyKey}'),
  'idempotência do fechamento precisa respeitar a unidade ativa',
);

exigir(
  cobrancaOnline.includes('reembolsoAutomatico') &&
    cobrancaOnline.includes('params.provider.estornar(reembolsoPendente.pagamentoId, reembolsoPendente.valorCents)') &&
    cobrancaOnline.includes("e.outcome IN ('pago_orfao', 'pago_com_divergencia')") &&
    cobrancaOnline.includes('c.psp_refund_id IS NULL'),
  'pagamento órfão precisa de refund automático e recuperável em reentrega',
);
const stripeWebhook = ler('apps/api/src/plataforma/stripe-webhook.controller.ts');
exigir(
  stripeWebhook.includes('provider: adquirenteDaComanda()'),
  'webhook da Stripe precisa entregar o provider ao fluxo que reembolsa órfãos',
);


exigir(
  cobrancaOnline.includes("e.outcome IN ('pago_orfao', 'pago_com_divergencia')") &&
    cobrancaOnline.includes("desfecho: 'pago_com_divergencia' as const") &&
    cobrancaOnline.includes('reembolsoAutomatico'),
  'pagamento divergente precisa ser devolvido automaticamente e recuperável',
);
exigir(
  cobrancaOnline.indexOf('await params.provider.cancelar(alvo.psp_payment_id)') <
    cobrancaOnline.indexOf("SET status = 'expirado', refused_reason = 'cancelada no balcão'"),
  'cancelamento do balcão voltou a matar localmente antes de confirmar o adquirente',
);
exigir(
  !cobrancaOnline.includes('params.provider.cancelar(viva.psp_payment_id).catch(() => undefined)'),
  'expiração automática voltou a esconder falha de cancelamento externo',
);
exigir(
  cobrancaOnline.includes("AND status IN ('aguardando', 'pago')\n         AND refunded_at IS NULL") &&
    cobrancaOnline.includes("ON CONFLICT (order_id) WHERE status IN ('aguardando', 'pago') AND refunded_at IS NULL DO NOTHING"),
  'refund persistido precisa liberar nova cobrança sem abrir janela antes da devolução',
);
const migracaoRefundLibera = ler('packages/db/migrations/0101_refund_libera_nova_cobranca.sql');
exigir(
  migracaoRefundLibera.includes("WHERE status IN ('aguardando', 'pago') AND refunded_at IS NULL"),
  'índice de cobrança viva não foi alinhado ao refund automático',
);

const migracaoCobrancaUnica = ler('packages/db/migrations/0100_cobranca_paga_trava_reemissao.sql');
exigir(
  migracaoCobrancaUnica.includes("WHERE status IN ('aguardando', 'pago')"),
  'índice único deve cobrir cobrança aguardando e paga',
);


const metricasPlataforma = ler('packages/platform/src/metricas.ts');
const controllerPlataforma = ler('apps/api/src/plataforma/plataforma.controller.ts');
exigir(
  metricasPlataforma.includes('export async function ultimoDiaComMetricas') &&
    metricasPlataforma.includes('SELECT max(business_day) AS ultimo_dia'),
  'plataforma deve usar o último dia realmente consolidado no agregado diário',
);
exigir(
  controllerPlataforma.includes('await ultimoDiaComMetricas(ultimoDiaApurado(new Date()))'),
  'painel/saúde da plataforma não podem apontar só para o dia esperado pelo relógio',
);
exigir(
  cobrancaOnline.includes("if (!linha.psp_payment_id)") &&
    cobrancaOnline.includes("'cobranca_em_curso'") &&
    cobrancaOnline.includes('A cobrança ainda está sendo emitida'),
  'cancelamento não pode enterrar cobrança enquanto o adquirente ainda está emitindo',
);


const fiscal = ler('packages/finance/src/fiscal-emissao.ts');
const fiscalCore = ler('packages/core/src/fiscal.ts');
exigir(
  fiscal.includes('status::text = ANY(${[...ESTADOS_NAO_TERMINAIS]}::text[])') &&
    fiscal.includes("nota.status === 'processando' && nota.provider_invoice_id") &&
    fiscal.includes("if (nota.status === 'pendente')"),
  'nota processando sem id externo deve ser reenviável; com id deve ser consultada',
);
exigir(
  fiscalCore.includes('Obrigatoriamente idempotente por `chaveDaNota(pedido)`'),
  'contrato fiscal deve exigir idempotência para recuperar resposta externa perdida',
);
exigir(
  fiscal.includes('**Não** voltamos para `autorizada` aqui') &&
    !fiscal.includes("UPDATE fiscal_invoices SET status = 'autorizada'"),
  'erro ambíguo no cancelamento fiscal não pode reabrir a nota antes da conciliação',
);


const conciliacaoPlataforma = ler('packages/platform/src/conciliacao.ts');
const migracaoEstornoPlataforma = ler('packages/db/migrations/0102_estorno_plataforma_recuperavel.sql');
const workerMain = ler('apps/worker/src/main.ts');
exigir(
  conciliacaoPlataforma.includes('psp_charge_id, idempotency_key') &&
    conciliacaoPlataforma.includes('export async function conciliarEstornosPendentes') &&
    conciliacaoPlataforma.includes('estornoId: lancamento.id'),
  'estorno de crédito pendente deve guardar a cobrança de origem e ser retomável pela mesma chave',
);
exigir(
  migracaoEstornoPlataforma.includes('ALTER TABLE refunds ADD COLUMN psp_charge_id text') &&
    migracaoEstornoPlataforma.includes("WHERE status = 'pending' AND psp_charge_id IS NOT NULL"),
  'banco deve persistir a origem dos estornos pendentes recuperáveis',
);
exigir(
  workerMain.includes('conciliarEstornosPendentes({ provider: psp })'),
  'worker deve retomar estornos de crédito pendentes antes da régua',
);


const pspPlataforma = ler('packages/platform/src/psp.ts');
const stripePagamento = ler('packages/platform/src/stripe-pagamento.ts');
exigir(
  pspPlataforma.includes('readonly tentativa: number') &&
    pspPlataforma.includes('tentativa: pedido.tentativa'),
  'tentativa da régua deve atravessar até o adquirente da plataforma',
);
exigir(
  stripePagamento.includes('fatura:${pedido.faturaId}:tentativa:${pedido.tentativa}'),
  'Stripe deve usar idempotência por fatura + tentativa, não por fatura inteira',
);


const cobrancaPlataforma = ler('packages/platform/src/cobranca.ts');
exigir(
  cobrancaPlataforma.includes('AND attempts = ${fatura.tentativas}') &&
    cobrancaPlataforma.includes('if (avancou) contagem.cobradas += 1'),
  'duas execuções da mesma tentativa não podem consumir dois degraus da régua',
);
exigir(
  cobrancaPlataforma.includes("erro.code !== 'not_payable'"),
  'resposta paga idempotente de worker concorrente não deve derrubar a régua',
);


const comandaFinance = ler('packages/finance/src/comanda.ts');
exigir(
  comandaFinance.includes("AND refunded_at IS NULL") &&
    cobrancaOnline.includes("AND c.refunded_at IS NULL"),
  'cobrança paga já reembolsada não pode congelar nem fechar novamente a comanda',
);
exigir(
  cobrancaOnline.includes('O caminho tardio precisa produzir os mesmos fatos do webhook') &&
    cobrancaOnline.includes('await derivarSplitDaVenda(tx, {'),
  'pagamento confirmado sem caixa deve derivar split quando o fechamento tardio acontecer',
);


const migracaoIdempotenciaEstorno = ler('packages/db/migrations/0103_estorno_plataforma_idempotente.sql');
exigir(
  conciliacaoPlataforma.includes('readonly idempotencyKey: string') &&
    conciliacaoPlataforma.includes('AND idempotency_key = ${entrada.idempotencyKey}') &&
    conciliacaoPlataforma.includes('psp_charge_id, idempotency_key'),
  'estorno administrativo deve reencontrar a mesma requisição antes de debitar crédito de novo',
);
exigir(
  migracaoIdempotenciaEstorno.includes('ON refunds (tenant_id, idempotency_key)'),
  'banco deve impor idempotência do estorno administrativo por tenant',
);
exigir(
  controllerPlataforma.includes("@Headers('idempotency-key')") &&
    controllerPlataforma.includes('idempotencyKey: `${admin.id}:${idempotencyKey}`'),
  'borda da plataforma deve exigir e escopar Idempotency-Key do estorno',
);


// Criação de cobrança: resposta perdida é ambígua. A linha precisa permanecer
// viva, repetir a mesma criação pela chargeId e manter uma conciliação contínua.
exigir(
  cobrancaOnline.includes("refused_reason = 'emissão sem resposta'") &&
    cobrancaOnline.includes('idempotencyKey: preparo.chargeId') &&
    !cobrancaOnline.includes("refused_reason = 'falha ao emitir'"),
  'falha ambígua ao emitir cobrança não pode expirar a linha nem abrir segunda cobrança',
);
exigir(
  cobrancaOnline.includes('if (!viva.psp_payment_id)') &&
    cobrancaOnline.includes('idempotencyKey: viva.id') &&
    cobrancaOnline.includes('const recuperada = await params.provider.criarCobranca'),
  'conciliação precisa recuperar cobrança sem id externo pela mesma intenção idempotente',
);
exigir(
  cobrancaOnline.includes('contagem.pendentes > 0 || contagem.comFalha > 0') &&
    cobrancaOnline.includes('cobranca-recon:${params.tenantId}:${janela}') &&
    cobrancaOnline.includes('rodarApos: proxima'),
  'conciliação precisa se reagendar enquanto houver cobrança viva ou falha transitória',
);


// WhatsApp manual: a idempotência precisa existir antes da rede e sobreviver a
// timeout/2xx sem wamid. `wamid` sozinho só deduplica depois da resposta.
const mensagemAvulsa = ler('packages/crm/src/mensagem-avulsa.ts');
const whatsappMeta = ler('packages/crm/src/whatsapp-meta.ts');
const whatsappController = ler('apps/api/src/admin/whatsapp.controller.ts');
const whatsappCore = ler('packages/core/src/whatsapp.ts');
const whatsappMensagens = ler('packages/crm/src/whatsapp-mensagens.ts');
const migracaoWhatsAppManual = ler('packages/db/migrations/0104_whatsapp_avulso_idempotente.sql');
const whatsappWebApi = ler('apps/web/src/lib/admin-api/crescimento.ts');
const whatsappWebAcao = ler('apps/web/src/app/admin/acoes/crescimento-plataforma.ts');
const clienteComponentes = ler('apps/web/src/app/admin/cliente/[id]/componentes.tsx');
exigir(
  whatsappController.includes("@Headers('idempotency-key')") &&
    whatsappController.includes('idempotency_key_obrigatoria'),
  'mensagem avulsa precisa exigir Idempotency-Key na borda',
);
exigir(
  mensagemAvulsa.includes('whatsapp_manual_send_intents') &&
    mensagemAvulsa.includes("status = 'incerto'") &&
    mensagemAvulsa.includes('intent_fingerprint'),
  'mensagem avulsa precisa persistir a intenção antes da rede e bloquear desfecho ambíguo',
);
exigir(
  whatsappCore.includes('class WhatsAppDeliveryUnknownError') &&
    whatsappMeta.includes('AbortSignal.timeout(15_000)') &&
    whatsappMeta.includes('WhatsAppDeliveryUnknownError'),
  'Meta WhatsApp precisa ter timeout e distinguir falha ambígua de recusa explícita',
);
exigir(
  whatsappMensagens.includes("${params.estado} = 'falhou' AND status = 'enviada'") &&
    whatsappMensagens.includes("${params.estado} <> 'falhou' AND status <> 'falhou'"),
  'status failed atrasado não pode sobrescrever prova de entrega/leitura do WhatsApp',
);
exigir(
  migracaoWhatsAppManual.includes('whatsapp_manual_send_intents_um_em_voo') &&
    migracaoWhatsAppManual.includes("WHERE status IN ('enviando', 'incerto')"),
  'banco precisa bloquear nova chave enquanto a mesma mensagem está em voo/incerta',
);
exigir(
  whatsappWebApi.includes('idempotencyKey: string') &&
    whatsappWebAcao.includes("texto(form, 'idempotencyKey')") &&
    clienteComponentes.includes('name="idempotencyKey"'),
  'UI da ficha precisa manter a mesma chave em duplo clique/reenvio da mensagem',
);


// Avisos automáticos: uma resposta ambígua da Meta não pode virar retry e
// segunda mensagem. A intenção nasce antes da rede e `sending/uncertain`
// bloqueiam nova tentativa automática.
const notificacoesJobs = ler('packages/jobs/src/notificacoes.ts');
const migracaoNotificacaoAutomatica = ler('packages/db/migrations/0106_notificacao_automatica_idempotente.sql');
exigir(
  notificacoesJobs.includes('notification_send_intents') &&
    notificacoesJobs.includes('WhatsAppDeliveryUnknownError') &&
    notificacoesJobs.includes("finalizarIntencaoDeEnvio(tx, intentKey, 'uncertain')") &&
    notificacoesJobs.includes("motivo: 'entrega_incerta'"),
  'lembrete/fila precisam persistir intenção e não repetir envio ambíguo da Meta',
);
exigir(
  migracaoNotificacaoAutomatica.includes('UNIQUE (tenant_id, intent_key)') &&
    migracaoNotificacaoAutomatica.includes("CHECK (status IN ('sending', 'uncertain', 'sent'))"),
  'banco precisa serializar a intenção de aviso automático antes da rede',
);
exigir(
  notificacoesJobs.includes('const intentKey = `retorno:${linha.customer_id}:${episodio}`') &&
    notificacoesJobs.includes("'retorno', ${linha.customer_id}::uuid, 'failed', 'entrega_incerta'") &&
    notificacoesJobs.includes("(n.status = 'sent' OR n.reason = 'entrega_incerta')"),
  'convite de retorno também precisa tratar entrega ambígua como at-most-once',
);

const pspWebhook = ler('packages/platform/src/psp.ts');
exigir(
  pspWebhook.includes("partes.filter(([k]) => k === 'v1')") &&
    pspWebhook.includes('assinaturas.some((assinatura) =>'),
  'assinatura de webhook precisa aceitar qualquer v1 válida durante rotação de segredo',
);

// Split/KYC: antes de existir provider real o contrato já precisa obrigar a
// idempotência da criação do recebedor. Resposta perdida não pode abrir dois KYCs.
const splitCore = ler('packages/core/src/pagamento.ts');
const splitFinance = ler('packages/finance/src/split.ts');
const splitController = ler('apps/api/src/admin/split.controller.ts');
const splitWebApi = ler('apps/web/src/lib/admin-api/produto.ts');
const splitWebAcao = ler('apps/web/src/app/admin/acoes/produto.ts');
const comissaoWeb = ler('apps/web/src/app/admin/comissao/page.tsx');
exigir(
  /export interface PedidoDeRecebedor \{[\s\S]*?readonly idempotencyKey: string/.test(splitCore),
  'contrato do recebedor/KYC precisa obrigar chave de idempotência',
);
const chamadaKycNaBorda = /cadastrarRecebedor\(\{[\s\S]*?tenantId:\s*staff\.tenantId,[\s\S]*?locationId:\s*local\.id,[\s\S]*?professionalId:\s*id,[\s\S]*?idempotencyKey:\s*`\$\{staff\.staffUserId\}:\$\{idempotencyKey\}`[\s\S]*?provider:\s*adquirenteDoSplit\(\)/.test(splitController);
exigir(
  splitFinance.includes('psp_kyc_request_key') &&
    splitFinance.includes('idempotencyKey: profissional.psp_kyc_request_key ?? entrada.idempotencyKey') &&
    splitController.includes("@Headers('idempotency-key')") &&
    splitController.includes('idempotency_key_obrigatoria') &&
    chamadaKycNaBorda,
  'KYC precisa transportar locationId + Idempotency-Key da API até o domínio e a mesma intenção até o provider',
);
exigir(
  ler('packages/db/migrations/0105_kyc_recebedor_recuperavel.sql').includes('psp_kyc_request_key') &&
    splitFinance.includes('psp_kyc_request_key = NULL'),
  'KYC precisa persistir a intenção antes da rede e limpá-la só após desfecho salvo',
);
exigir(
  splitWebApi.includes('idempotencyKey: string') &&
    splitWebAcao.includes("texto(form, 'idempotencyKey')") &&
    comissaoWeb.includes('name="idempotencyKey"'),
  'formulário de KYC precisa preservar a chave em duplo clique/reenvio',
);


// Split em voo: a requisição externa precisa ser congelada e a dívida
// conservadora precisa ser compensada se o adquirente provar que nada saiu.
const splitMigracaoRecuperavel = ler('packages/db/migrations/0107_split_em_voo_recuperavel.sql');
exigir(
  splitFinance.includes('transfer_recipient_id') &&
    splitFinance.includes('transfer_payment_id') &&
    splitFinance.includes('recuperarEstornosEmVoo') &&
    splitFinance.includes('compensarClawbackProvisorio'),
  'repasse em voo deve reapresentar os mesmos parâmetros e resolver clawback provisório',
);
exigir(
  splitFinance.includes('resultado.definitiva') &&
    splitCore.includes('readonly definitiva: boolean') &&
    splitCore.includes('repassesPorChave'),
  'provider de split precisa distinguir falha definitiva de ambígua e o fake deve exercer idempotência',
);
exigir(
  splitMigracaoRecuperavel.includes('recovery_pending') &&
    splitMigracaoRecuperavel.includes('clawback_reversal_entry_id') &&
    splitMigracaoRecuperavel.includes('transfer_recipient_id'),
  'banco precisa persistir recuperação e compensação do split em voo',
);


// Continuação profunda (0108): RLS separa tenants; a unidade precisa viajar
// pela borda e permanecer no WHERE do domínio. Também guardamos as classes de
// corrida que só aparecem com duas réplicas.
const migracaoProfunda = ler('packages/db/migrations/0108_auditoria_profunda.sql');
const recadoDominio = ler('packages/crm/src/recado.ts');
const recadoBorda = ler('apps/api/src/admin/recado.controller.ts');
const sinalDominio = ler('packages/finance/src/sinal.ts');
const sinalBorda = ler('apps/api/src/admin/sinal.controller.ts');
const avaliacaoDominio = ler('packages/crm/src/avaliacao.ts');
const avaliacaoBorda = ler('apps/api/src/admin/avaliacao.controller.ts');
const filaDominio = ler('packages/scheduling/src/fila.ts');
const esperaDominio = ler('packages/scheduling/src/espera.ts');
const jobsFila = ler('packages/jobs/src/fila.ts');
const webhookOutbound = ler('packages/identity/src/webhook.ts');

exigir(
  recadoBorda.includes('unidadeDoBalcao(staff)') &&
    recadoBorda.includes('locationId: local.id') &&
    recadoDominio.includes('AND location_id = ${entrada.locationId}::uuid'),
  'recados voltaram a autorizar só por tenant/UUID, sem a unidade ativa',
);
exigir(
  sinalBorda.includes('unidadeDoBalcao(staff)') &&
    sinalBorda.includes('locationId: local.id') &&
    sinalDominio.includes('AND a.location_id = ${locationId}::uuid'),
  'sinal voltou a aceitar agendamento de outra unidade do mesmo tenant',
);
exigir(
  avaliacaoBorda.includes('unidadeDoBalcao(staff)') &&
    avaliacaoBorda.includes('locationId: local.id') &&
    avaliacaoDominio.includes('a.location_id = ${entrada.locationId}::uuid'),
  'avaliações voltaram a permitir mutação cross-unit',
);
exigir(
  splitController.includes('unidadeDoBalcao(staff)') &&
    splitController.includes('locationId: local.id') &&
    splitFinance.includes('AND location_id = ${entrada.locationId}::uuid'),
  'Split/KYC voltou a operar profissional fora da unidade ativa',
);

exigir(
  filaDominio.includes('request_fingerprint') &&
    filaDominio.includes('WHERE location_id = ${params.locationId}::uuid') &&
    filaDominio.includes('pg_advisory_xact_lock'),
  'fila perdeu escopo de unidade/fingerprint/serialização da idempotência',
);
exigir(
  esperaDominio.includes('request_fingerprint') &&
    esperaDominio.includes('WHERE location_id = ${pedido.locationId}::uuid') &&
    esperaDominio.includes('pg_advisory_xact_lock'),
  'lista de espera perdeu escopo de unidade/fingerprint/serialização da idempotência',
);
exigir(
  migracaoProfunda.includes('queue_entries_idempotency_idx') &&
    migracaoProfunda.includes('waitlist_sem_repetido_idx') &&
    migracaoProfunda.includes('request_fingerprint'),
  'migration profunda não sustenta as novas identidades de fila/lista de espera',
);

exigir(
  migracaoProfunda.includes('ADD COLUMN IF NOT EXISTS claim_token uuid') &&
    jobsFila.includes('claim_token = gen_random_uuid()') &&
    jobsFila.includes('AND claim_token = ${tarefa.claimToken}::uuid'),
  'jobs perderam fencing: worker antigo pode concluir/falhar claim nova',
);
exigir(
  migracaoProfunda.includes('claim_expires_at timestamptz') &&
    webhookOutbound.includes('claim_token = gen_random_uuid()') &&
    webhookOutbound.includes('AND claim_token = ${claimToken}::uuid'),
  'webhook outbound perdeu lease/fencing e voltou a permitir dupla réplica',
);

exigir(
  splitFinance.includes('psp_kyc_request_fingerprint') &&
    splitFinance.includes("process.env['KYC_INTENT_HMAC_SECRET']") &&
    ler('docker-compose.yml').includes('KYC_INTENT_HMAC_SECRET: ${KYC_INTENT_HMAC_SECRET:?falta no .env}') &&
    ler('deploy/compose.yml').includes('KYC_INTENT_HMAC_SECRET: ${KYC_INTENT_HMAC_SECRET:?falta no .env}') &&
    ler('deploy/segredos.sh').includes('manter KYC_INTENT_HMAC_SECRET'),
  'fingerprint do KYC não está persistido ou o segredo não chega ao runtime de produção',
);

const assinaturaSelfService = ler('packages/platform/src/assinatura.ts');
exigir(
  migracaoProfunda.includes('CREATE TABLE IF NOT EXISTS subscription_change_intents') &&
    migracaoProfunda.includes('REVOKE UPDATE, DELETE ON subscription_change_intents') &&
    assinaturaSelfService.includes('subscription_change_intents') &&
    assinaturaSelfService.includes('request_fingerprint'),
  'troca self-service de plano perdeu a intenção idempotente append-only',
);

console.log('auditoria ofensiva: invariantes críticos preservados');
