import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const raiz = process.cwd();
const arquivos = [
  'packages/finance/src/comanda.ts',
  'packages/finance/src/comanda-tipos.ts',
  'packages/finance/src/comanda-fechamento.ts',
  'packages/finance/src/caixa.ts',
  'packages/finance/src/estorno.ts',
  'packages/finance/src/pacote.ts',
  'packages/core/src/pagamento.ts',
  'packages/core/src/vale.ts',
  'packages/db/migrations/0111_finance_estorno_concorrencia.sql',
  'packages/db/migrations/0112_pacote_congelado_na_comanda.sql',
  'apps/api/src/admin/caixa.schemas.ts',
  'apps/api/src/admin/caixa.controller.ts',
  'apps/web/src/lib/admin-api/financeiro-operacional.ts',
  'apps/web/src/app/admin/acoes/agenda-financeiro.ts',
  'apps/web/src/app/admin/comanda/[id]/page.tsx',
  'scripts/verificar-auditoria-financeiro.mjs',
];

function mutacao(rel, de, para) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barberdock-finance-'));
  for (const arq of arquivos) {
    const dst = path.join(tmp, arq);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(raiz, arq), dst);
  }
  const alvo = path.join(tmp, rel);
  const antes = fs.readFileSync(alvo, 'utf8');
  assert.ok(antes.includes(de), `fixture não contém mutação: ${de.slice(0, 70)}`);
  fs.writeFileSync(alvo, antes.replaceAll(de, para));
  const r = spawnSync(process.execPath, ['scripts/verificar-auditoria-financeiro.mjs'], {
    cwd: tmp, encoding: 'utf8',
  });
  assert.notEqual(r.status, 0, `guarda aceitou regressão em ${rel}`);
}

test('detecta mutação de comanda sem lock', () =>
  mutacao('packages/finance/src/comanda.ts', 'exigirAberta(tx, params.orderId, params.locationId, true)', 'exigirAberta(tx, params.orderId, params.locationId)'));
test('detecta remoção do fingerprint de fechamento', () =>
  mutacao('packages/db/migrations/0111_finance_estorno_concorrencia.sql', 'close_idempotency_fingerprint text', 'fingerprint_removido text'));
test('detecta abertura de caixa sem serialização', () =>
  mutacao('packages/finance/src/caixa.ts', ':cash-open', ':sem-lock-de-abertura'));
test('detecta remoção do lease de estorno', () =>
  mutacao('packages/finance/src/estorno.ts', "refund_pending_at < now() - interval '15 minutes'", 'true'));
test('detecta reintrodução de limpeza do lease em falha ambígua', () =>
  mutacao('packages/finance/src/estorno.ts', "recusar('estorno_externo_falhou');", "await limparEstornoPendente(params.tenantId, cobranca.chargeId);\n      recusar('estorno_externo_falhou');"));
test('detecta pacote vendido não invalidado no estorno', () =>
  mutacao('packages/finance/src/estorno.ts', 'invalidarPacotesVendidos', 'ignorarPacotesVendidos'));
test('detecta estorno integral reabilitado depois de transferência do pacote', () =>
  mutacao('packages/finance/src/estorno.ts', "recusar('pacote_vendido_ja_transferido')", "recusar('pacote_vendido_ja_usado')"));
test('detecta consumo de pacote sem filtro de refund pendente', () =>
  mutacao('packages/finance/src/pacote.ts', 'oc.refund_pending_at IS NOT NULL', 'false'));
test('detecta consumo de pacote sem trava antes do snapshot novo', () =>
  mutacao('packages/finance/src/pacote.ts', 'ORDER BY purchased_at\n       FOR UPDATE', 'ORDER BY purchased_at'));
test('detecta transferência sem confirmar a trava do pacote', () =>
  mutacao('packages/finance/src/estorno.ts', "if (!travado[0]) falharNaTransferencia('pacote_nao_encontrado');", "if (!travado[0]) return { unidadesMovidas: 0 };"));
test('detecta remoção do bloqueio de fiado parcialmente recebido', () =>
  mutacao('packages/finance/src/estorno.ts', "recusar('fiado_ja_recebido')", "recusar('venda_nao_paga')"));
test('detecta remoção da proteção de gaveta', () =>
  mutacao('packages/finance/src/estorno.ts', "recusar('caixa_sem_saldo_para_estorno')", "recusar('venda_nao_paga')"));
test('detecta regressão da assinatura na borda', () =>
  mutacao('apps/api/src/admin/caixa.schemas.ts', 'servicoDaAssinatura: uuidSchema.optional()', 'servicoDaAssinaturaRemovido: uuidSchema.optional()'));
test('detecta pacote quantity>1 entregue só uma vez', () =>
  mutacao('packages/finance/src/comanda.ts', 'for (let unidade = 0; unidade < item.quantity; unidade += 1)', 'for (let unidade = 0; unidade < 1; unidade += 1)'));
test('detecta fechamento que volta a reler termos do catálogo de pacote', () =>
  mutacao('packages/finance/src/pacote.ts', 'Os termos não são relidos do catálogo aqui', 'Os termos podem ser relidos do catálogo aqui'));
test('detecta remoção do snapshot de pacote da migração', () =>
  mutacao('packages/db/migrations/0112_pacote_congelado_na_comanda.sql', 'package_snapshot_service_id', 'package_snapshot_service_removido'));
test('detecta desconto geral reabilitado em pacote', () =>
  mutacao('packages/finance/src/comanda-fechamento.ts', "'pacote_com_desconto',", "'desconto_removido',"));
