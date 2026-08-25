import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const raiz = process.cwd();
const arquivos = [
  'packages/crm/src/disparo-promocional.ts',
  'packages/crm/src/mensagem-avulsa.ts',
  'packages/crm/src/campanha.ts',
  'packages/crm/src/automacao.ts',
  'packages/crm/src/whatsapp-mensagens.ts',
  'packages/crm/src/whatsapp-templates.ts',
  'packages/crm/src/whatsapp-meta.ts',
  'packages/crm/src/whatsapp-cadastro.ts',
  'packages/crm/src/whatsapp-roteamento.ts',
  'packages/crm/src/whatsapp-lifecycle.ts',
  'packages/crm/src/whatsapp-template-submissao.ts',
  'apps/api/src/plataforma/whatsapp-webhook.controller.ts',
  'apps/worker/src/main.ts',
  'packages/db/migrations/0113_crm_whatsapp_concorrencia.sql',
  'packages/db/test/0113_crm_whatsapp_concorrencia.test.sql',
  'scripts/verificar-auditoria-crm-whatsapp.mjs',
];

function mutacao(rel, de, para) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barberdock-crm-whatsapp-'));
  for (const arq of arquivos) {
    const dst = path.join(tmp, arq);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(raiz, arq), dst);
  }
  const alvo = path.join(tmp, rel);
  const antes = fs.readFileSync(alvo, 'utf8');
  assert.ok(antes.includes(de), `fixture não contém mutação: ${de.slice(0, 90)}`);
  fs.writeFileSync(alvo, antes.replaceAll(de, para));
  const r = spawnSync(process.execPath, ['scripts/verificar-auditoria-crm-whatsapp.mjs'], {
    cwd: tmp, encoding: 'utf8',
  });
  assert.notEqual(r.status, 0, `guarda aceitou regressão em ${rel}`);
}

test('detecta remoção do advisory lock da cota promocional', () =>
  mutacao('packages/crm/src/disparo-promocional.ts', 'pg_advisory_xact_lock', 'lock_removido'));
test('detecta remoção do ledger de intenção promocional', () =>
  mutacao('packages/crm/src/disparo-promocional.ts', 'notification_send_intents', 'ledger_removido'));
test('detecta retorno a conflito não qualificado por tenant', () =>
  mutacao('packages/crm/src/disparo-promocional.ts',
    'ON CONFLICT (tenant_id, intent_key) DO NOTHING', 'ON CONFLICT DO NOTHING'));
test('detecta leitura da intenção sem tenant explícito', () =>
  mutacao('packages/crm/src/disparo-promocional.ts',
    'WHERE tenant_id = ${params.tenantId}::uuid', 'WHERE 1 = 1'));
test('detecta regressão do dia local para UTC no avulso', () =>
  mutacao('packages/crm/src/mensagem-avulsa.ts', 'AT TIME ZONE ${params.timeZone}', "AT TIME ZONE 'UTC'"));
test('detecta avulso que aceita sucesso sem wamid', () =>
  mutacao('packages/crm/src/mensagem-avulsa.ts', 'if (!wamid)', 'if (false && !wamid)'));
test('detecta campanha que perde a reserva compartilhada', () =>
  mutacao('packages/crm/src/campanha.ts', 'reservarDisparoPromocional(tx, {', 'RESERVA_REMOVIDA(tx, {'));
test('detecta worker que envia automação sem reserva', () =>
  mutacao('apps/worker/src/main.ts', 'reservarDisparoDaAutomacao({', 'RESERVA_AUTOMACAO_REMOVIDA({'));
test('detecta perda do desfecho ambíguo após sucesso Meta', () =>
  mutacao('packages/crm/src/whatsapp-mensagens.ts', "throw new WhatsAppDeliveryUnknownError(\n      'a Meta confirmou", "throw new Error(\n      'a Meta confirmou"));
test('detecta conciliação de templates sem locationId', () =>
  mutacao('packages/crm/src/whatsapp-meta.ts', 'templatesEmCurso(tenantId, locationId)', 'templatesEmCurso(tenantId)'));
test('detecta remoção do FOR UPDATE do claim de template', () =>
  mutacao('packages/crm/src/whatsapp-template-submissao.ts', '       FOR UPDATE', '       /* sem lock */'));
test('detecta remoção do estado incerto de template', () =>
  mutacao('packages/crm/src/whatsapp-templates.ts', "erro.name === 'WhatsAppMetaTransportError'", "erro.name === 'NuncaIncerto'"));
test('detecta lifecycle que volta a usar phone_number como id opaco', () =>
  mutacao('apps/api/src/plataforma/whatsapp-webhook.controller.ts',
    'const numero = mudanca.value.metadata?.phone_number_id;',
    'const numero = mudanca.value.metadata?.phone_number_id ?? mudanca.value.phone_number;'));
test('detecta remoção do roteamento por entry.id/WABA', () =>
  mutacao('apps/api/src/plataforma/whatsapp-webhook.controller.ts', 'tenantsDaWaba(entrada.id)', 'tenantsDaWabaRemovido(entrada.id)'));
test('detecta remoção de PARTNER_REMOVED', () =>
  mutacao('apps/api/src/plataforma/whatsapp-webhook.controller.ts', "mudanca.value.event === 'PARTNER_REMOVED'", "mudanca.value.event === 'PARTNER_REMOVIDO'"));
test('detecta suspensão sem caminho de reativação', () =>
  mutacao('packages/crm/src/whatsapp-cadastro.ts', "status IN ('aguardando_verificacao', 'suspenso')", "status = 'aguardando_verificacao'"));
test('detecta WABA sem owner único', () =>
  mutacao('packages/db/migrations/0113_crm_whatsapp_concorrencia.sql', 'waba_id    text PRIMARY KEY', 'waba_id    text NOT NULL'));
test('detecta cadastro que não reivindica owner da WABA', () =>
  mutacao('packages/crm/src/whatsapp-cadastro.ts', 'INSERT INTO whatsapp_waba_owners', 'INSERT INTO owner_removido'));
test('detecta telefone visível introduzido no roteamento público', () =>
  mutacao('packages/db/migrations/0113_crm_whatsapp_concorrencia.sql',
    'location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,',
    'location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,\n  display_phone text,'));
test('detecta remoção do índice diário promocional', () =>
  mutacao('packages/db/migrations/0113_crm_whatsapp_concorrencia.sql', 'notification_send_intents_uma_promocao_dia', 'indice_diario_removido'));
test('detecta remoção do claim persistente na migração', () =>
  mutacao('packages/db/migrations/0113_crm_whatsapp_concorrencia.sql', 'submission_state text NOT NULL DEFAULT', 'submission_state_removido text NOT NULL DEFAULT'));
