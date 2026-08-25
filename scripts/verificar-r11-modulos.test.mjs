import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RAIZ = process.cwd();
const roda = (mutacao) => {
  const dir = mkdtempSync(join(tmpdir(), 'barber-r11-'));
  cpSync(join(RAIZ, 'apps'), join(dir, 'apps'), { recursive: true });
  cpSync(join(RAIZ, 'scripts'), join(dir, 'scripts'), { recursive: true });
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
