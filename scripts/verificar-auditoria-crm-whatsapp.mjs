import fs from 'node:fs';

const ler = (p) => fs.readFileSync(p, 'utf8');
const falhas = [];
const exigir = (ok, mensagem) => { if (!ok) falhas.push(mensagem); };

const promo = ler('packages/crm/src/disparo-promocional.ts');
const avulsa = ler('packages/crm/src/mensagem-avulsa.ts');
const campanha = ler('packages/crm/src/campanha.ts');
const automacao = ler('packages/crm/src/automacao.ts');
const mensagens = ler('packages/crm/src/whatsapp-mensagens.ts');
const templates = ler('packages/crm/src/whatsapp-templates.ts');
const meta = ler('packages/crm/src/whatsapp-meta.ts');
const cadastro = ler('packages/crm/src/whatsapp-cadastro.ts');
// A reivindicacao da WABA saiu para modulo proprio quando o cadastro bateu no
// teto de linhas. A guarda segue o fato, nao o arquivo em que ele morava.
const waba = ler('packages/crm/src/whatsapp-waba.ts');
const roteamento = ler('packages/crm/src/whatsapp-roteamento.ts');
const lifecycle = ler('packages/crm/src/whatsapp-lifecycle.ts');
const submissao = ler('packages/crm/src/whatsapp-template-submissao.ts');
const webhook = ler('apps/api/src/plataforma/whatsapp-webhook.controller.ts');
const worker = ler('apps/worker/src/main.ts');
const migracao = ler('packages/db/migrations/0113_crm_whatsapp_concorrencia.sql');
const testeSql = ler('packages/db/test/0113_crm_whatsapp_concorrencia.test.sql');

// Cota promocional: uma decisão única entre campanha, automação e balcão.
exigir(promo.includes('pg_advisory_xact_lock') && promo.includes('barberdock:promo:'),
  'cota promocional perdeu serialização por tenant+cliente');
exigir(promo.includes('notification_send_intents') && promo.includes('quota_date')
  && promo.includes("status IN ('sending', 'uncertain', 'sent')"),
  'cota promocional não usa ledger persistente em voo/incerto/enviado');
exigir(promo.includes('WHERE tenant_id = ${params.tenantId}::uuid')
  && promo.includes('ON CONFLICT (tenant_id, intent_key) DO NOTHING')
  && promo.includes("tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid"),
  'ledger promocional perdeu cardinalidade explícita tenant_id + intent_key');
exigir(promo.includes('instantToLocal(params.timeZone, params.agora).date')
  && promo.includes('TETO_PROMOCIONAL_MES'),
  'cota promocional perdeu dia local ou teto de 30 dias');
exigir(migracao.includes('notification_send_intents_uma_promocao_dia')
  && migracao.includes('(tenant_id, customer_id, quota_date)'),
  'migração 0113 não fecha segunda reserva promocional do mesmo dia');

// Três origens precisam reservar antes da rede e confirmar só depois.
for (const [nome, fonte] of [['campanha', campanha], ['automação', automacao], ['avulsa', avulsa]]) {
  exigir(fonte.includes('reservarDisparoPromocional') && fonte.includes('confirmarDisparoPromocional'),
    `${nome} não participa da reserva promocional compartilhada`);
}
exigir(campanha.includes('reservarDisparoPromocional(tx, {')
  && campanha.indexOf('reservarDisparoPromocional(tx, {') < campanha.indexOf('wamid = await params.enviar(alvo)'),
  'campanha voltou a chamar provedor antes de reservar cota');
exigir(worker.includes('const nossa = await reservarDisparoDaAutomacao({')
  && worker.indexOf('const nossa = await reservarDisparoDaAutomacao({') < worker.indexOf('await provider.enviarDeAutomacao'),
  'worker voltou a chamar automação antes de reservar');
exigir(automacao.includes('UPDATE automation_sends SET sent_at = ${params.agora}')
  && automacao.includes('confirmarDisparoDaAutomacao'),
  'automação perdeu confirmação pós-provider');
exigir(avulsa.includes('ON CONFLICT DO NOTHING\n      RETURNING id')
  && avulsa.includes('nossa: true') && avulsa.includes("status === 'enviado'"),
  'envio avulso perdeu posse concorrente/idempotência da intenção');
exigir(avulsa.includes("throw new EnvioAvulsoError(\n        'sem_canal'")
  && avulsa.includes('if (!wamid)'),
  'envio avulso pode voltar a carimbar sucesso sem wamid/canal');
exigir(avulsa.includes('TIPOS_PROMOCIONAIS') && avulsa.includes('AT TIME ZONE ${params.timeZone}'),
  'pré-filtro do envio avulso voltou a contar transacionais ou dia UTC');

// Depois da Meta aceitar, falha local é ambígua e não uma recusa segura.
exigir(mensagens.indexOf('const enviada = await pedido.provider.enviar') < mensagens.indexOf('INSERT INTO whatsapp_messages')
  && mensagens.indexOf('INSERT INTO whatsapp_messages') < mensagens.lastIndexOf('WhatsAppDeliveryUnknownError'),
  'persistência do wamid após sucesso Meta não vira desfecho ambíguo');
exigir(avulsa.includes('marcarDisparoPromocionalIncerto')
  && campanha.includes('marcarDisparoPromocionalIncerto')
  && worker.includes('marcarDisparoDaAutomacaoIncerto'),
  'algum caminho promocional perdeu tratamento de entrega incerta');

// Template: escopo de unidade e claim antes da Meta.
exigir(meta.includes('templatesEmCurso(tenantId, locationId)'),
  'conciliação de templates voltou a atravessar unidades do mesmo tenant');
exigir(submissao.includes('SELECT id, meta_id, submission_state')
  && submissao.includes('AND language = ${params.idioma}\n       FOR UPDATE')
  && submissao.includes("submission_state = 'sending'")
  && submissao.includes('submission_claim = ${claim}::uuid'),
  'submissão de template perdeu claim persistente/lock');
exigir(templates.includes("erro.name === 'WhatsAppMetaTransportError'")
  && submissao.includes("submission_state = ${params.incerta ? 'uncertain' : 'idle'}"),
  'template não distingue transporte ambíguo de recusa explícita');
exigir(templates.includes("submission_state <> 'sending'")
  && templates.includes("interval '2 minutes'"),
  'conciliação pode competir com submissão de template ainda em voo');
exigir(migracao.includes('whatsapp_templates_submission_claim_coerente')
  && migracao.includes('submission_state text NOT NULL DEFAULT'),
  'migração 0113 não persiste o claim de template');

// Webhook: lifecycle por WABA opaca; telefone visível só depois da RLS.
exigir(webhook.includes('id: z.string().optional()') && webhook.includes('tenantsDaWaba(entrada.id)'),
  'lifecycle do webhook não é roteado por entry.id/WABA');
exigir(webhook.includes("const numero = mudanca.value.metadata?.phone_number_id;")
  && !webhook.includes('metadata?.phone_number_id ?? mudanca.value.phone_number'),
  'phone_number visível voltou a ser tratado como phone_number_id');
exigir(webhook.includes("ACCOUNT_OFFBOARDED") && webhook.includes("PARTNER_REMOVED")
  && webhook.includes("ACCOUNT_RECONNECTED"),
  'webhook não cobre offboarding, remoção de parceiro e reconexão');
exigir(webhook.includes('numeroVisivelDaUnidadeConfere')
  && lifecycle.includes('SELECT display_phone FROM whatsapp_settings'),
  'desambiguação por número visível não ocorre depois da RLS');
exigir(cadastro.includes("status IN ('aguardando_verificacao', 'suspenso')")
  && lifecycle.includes("SET status = 'aguardando_verificacao'"),
  'número suspenso não tem caminho seguro de reconciliação/reativação');

// Roteamento público guarda só ids opacos e uma WABA não cruza tenants.
exigir(roteamento.includes('FROM whatsapp_wabas') && roteamento.includes('waba_id = ${wabaId}'),
  'roteamento WABA não existe na fachada pública');
exigir(migracao.includes('CREATE TABLE IF NOT EXISTS whatsapp_waba_owners')
  && migracao.includes('waba_id    text PRIMARY KEY')
  && migracao.includes('FOREIGN KEY (waba_id, tenant_id)'),
  'WABA não tem ownership único por tenant no banco');
exigir(waba.includes('INSERT INTO whatsapp_waba_owners')
  && /return\s+criada === 0 \? 'de_outra'/.test(waba)
  && cadastro.includes("reivindicarWaba(tx, params.wabaId)) === 'de_outra'"),
  'cadastro não recusa WABA já pertencente a outro tenant');
const blocoRoteamento = migracao.slice(migracao.indexOf('CREATE TABLE IF NOT EXISTS whatsapp_waba_owners'), migracao.indexOf('-- A antiga unicidade da automação'));
exigir(!/display_phone|access_token|phone_e164|from_phone|body/i.test(blocoRoteamento),
  'tabela pública de roteamento WABA passou a carregar telefone/token/conversa');
exigir(migracao.includes('FORCE ROW LEVEL SECURITY')
  && testeSql.includes('mesma WABA aceitou dois tenants')
  && testeSql.includes('segunda reserva promocional do dia foi aceita'),
  'migração 0113 perdeu RLS forçada ou prova SQL estrutural');

if (falhas.length) {
  console.error(`Auditoria CRM/WhatsApp: ${falhas.length} falha(s)`);
  for (const f of falhas) console.error(`- ${f}`);
  process.exit(1);
}
console.log('Auditoria CRM/WhatsApp: cota, idempotência, templates, WABA e lifecycle preservados');
