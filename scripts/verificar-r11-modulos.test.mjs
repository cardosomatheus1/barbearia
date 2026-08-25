import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RAIZ = process.cwd();
/**
 * O que **não** se copia: artefato de build e dependência.
 *
 * Sem o filtro, cada um dos quatro casos arrastava `.next` e `node_modules`
 * junto — a guarda levava 9,3s e estourava o gancho padrão de 5s do vitest,
 * ficando vermelha sem ter nada a dizer sobre a partição que ela existe para
 * conferir. Guarda que reprova por lentidão é guarda que alguém desliga.
 */
const COPIAVEL = (origem) =>
  !/[\\/](node_modules|\.next|dist|coverage|\.turbo)([\\/]|$)/.test(origem);

const roda = (mutacao) => {
  const dir = mkdtempSync(join(tmpdir(), 'barber-r11-'));
  cpSync(join(RAIZ, 'apps'), join(dir, 'apps'), { recursive: true, filter: COPIAVEL });
  cpSync(join(RAIZ, 'scripts'), join(dir, 'scripts'), { recursive: true, filter: COPIAVEL });
  mutacao?.(dir);
  try {
    execFileSync('node', ['scripts/verificar-r11-modulos.mjs'], { cwd: dir, stdio: 'pipe' });
    return true;
  } catch { return false; } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe('R11 — módulos por domínio', () => {
  it('aceita a partição atual', () => expect(roda()).toBe(true));
  it('reprova lógica voltando à fachada', () => expect(roda((d) => {
    const p=join(d,'apps/web/src/lib/admin-api.ts');
    writeFileSync(p, readFileSync(p,'utf8') + '\nconst BASE = "x";\n');
  })).toBe(false));
  it('reprova ação que deixa de ser reexportada', () => expect(roda((d) => {
    const p=join(d,'apps/web/src/app/admin/acoes.ts');
    writeFileSync(p, readFileSync(p,'utf8').replace('  acaoCriarConta,\n',''));
  })).toBe(false));
  it('reprova UI importando módulo interno', () => expect(roda((d) => {
    const p=join(d,'apps/web/src/app/admin/page.tsx');
    writeFileSync(p, readFileSync(p,'utf8') + "\nimport '@/lib/admin-api/clientes';\n");
  })).toBe(false));
});
