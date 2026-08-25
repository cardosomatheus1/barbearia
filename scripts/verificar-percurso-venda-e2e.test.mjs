#!/usr/bin/env node
/** Testes negativos autônomos da guarda do percurso financeiro. Sem Vitest. */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const guard = join(raiz, 'scripts/verificar-percurso-venda-e2e.mjs');
let ok = 0;

function base() {
  const t = mkdtempSync(join(tmpdir(), 'barber-e2e-venda-'));
  mkdirSync(join(t, 'scripts'), { recursive: true });
  cpSync(join(raiz, 'scripts/percorrer.mjs'), join(t, 'scripts/percorrer.mjs'));
  return t;
}

function caso(nome, mutar) {
  const t = base();
  try {
    const p = join(t, 'scripts/percorrer.mjs');
    const antes = readFileSync(p, 'utf8');
    const depois = mutar(antes);
    if (depois === antes) throw new Error(`${nome}: fixture não mudou; teste ficou desatualizado`);
    writeFileSync(p, depois);
    const r = spawnSync(process.execPath, [guard], {
      env: { ...process.env, PERCURSO_RAIZ: t },
      encoding: 'utf8',
    });
    if (r.status === 0) throw new Error(`${nome}: regressão aceita pela guarda`);
    ok += 1;
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
}

caso('remove estado total/troco/sessão', (s) => s.replace('paid:3790:1210:1', 'paid:3790'));
caso('remove conferência de movimento de caixa', (s) => s.replace('cash_movements WHERE order_id', 'movimentos_falsos WHERE order_id'));
caso('remove fechamento de caixa', (s) => s.replace("botao(page, 'Fechar caixa')", "botao(page, 'Voltar')"));
caso('reintroduz comparação fraca', (s) => s.replace(
  "const mensagem = await page.locator('[role=\"status\"]').first().innerText().catch(() => '');",
  "const depois = 1; const antes = 1; if (depois < antes) throw new Error('sumiu');\n  const mensagem = await page.locator('[role=\"status\"]').first().innerText().catch(() => '');",
));

console.log(`Percurso financeiro E2E — testes negativos: ${ok}/4`);
