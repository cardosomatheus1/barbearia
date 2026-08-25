import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const GUARDA = new URL('./verificar-r10-css.mjs', import.meta.url).pathname;

function fixture() {
  const raiz = mkdtempSync(join(tmpdir(), 'barberdock-r10-'));
  const app = join(raiz, 'apps/web/src/app');
  const styles = join(app, 'styles');
  mkdirSync(styles, { recursive: true });
  const imports = [];
  for (let i = 0; i < 10; i += 1) {
    const ordem = String(i * 10).padStart(2, '0');
    const nome = `${ordem}-surface-${i}.css`;
    imports.push(`@import './styles/${nome}';`);
    writeFileSync(join(styles, nome), `.r10-${i} { color: rgb(${i}, ${i}, ${i}); }\n`);
  }
  writeFileSync(join(app, 'globals.css'), `${imports.join('\n')}\n`);
  return raiz;
}

function rodar(raiz) {
  return spawnSync(process.execPath, [GUARDA], { cwd: raiz, encoding: 'utf8' });
}

function comFixture(fn) {
  const raiz = fixture();
  try { fn(raiz); } finally { rmSync(raiz, { recursive: true, force: true }); }
}

test('aceita índice puro com superfícies ordenadas', () => comFixture((raiz) => {
  const r = rodar(raiz);
  assert.equal(r.status, 0, r.stderr);
}));

test('reprova regra escrita de volta no globals.css', () => comFixture((raiz) => {
  const p = join(raiz, 'apps/web/src/app/globals.css');
  writeFileSync(p, `${readFileSync(p, 'utf8')}\n.voltou-o-monolito { display: block; }\n`);
  const r = rodar(raiz);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /voltou a conter regras/);
}));

test('reprova fragmento órfão', () => comFixture((raiz) => {
  writeFileSync(join(raiz, 'apps/web/src/app/styles/95-orphan.css'), '.orphan { display: block; }\n');
  const r = rodar(raiz);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /não importado|import inexistente/);
}));

test('reprova regra idêntica copiada em duas superfícies', () => comFixture((raiz) => {
  const a = join(raiz, 'apps/web/src/app/styles/00-surface-0.css');
  const b = join(raiz, 'apps/web/src/app/styles/10-surface-1.css');
  const regra = '.copiada { padding: 1rem; }\n';
  writeFileSync(a, regra);
  writeFileSync(b, regra);
  const r = rodar(raiz);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /idênticas duplicadas/);
}));
