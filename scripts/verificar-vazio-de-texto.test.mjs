import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { falhasDoVazioDeTexto } from './verificar-vazio-de-texto.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

const FICHA = 'apps/web/src/app/admin/cliente/[id]/componentes.tsx';
const CAMPANHAS = 'apps/web/src/app/admin/campanhas/page.tsx';
const AUTOMACOES = 'apps/web/src/app/admin/automacoes/page.tsx';

test('o produto de hoje passa', () => assert.deepEqual(falhasDoVazioDeTexto(), []));

/** Raiz de mentira com as três telas que a guarda encontra hoje. */
function copia() {
  const base = mkdtempSync(resolve(tmpdir(), 'vazio-'));
  for (const p of [FICHA, CAMPANHAS, AUTOMACOES]) {
    const destino = join(base, p);
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, readFileSync(join(RAIZ, p), 'utf8'));
  }
  return base;
}

const quebras = [
  ['a ficha do cliente deixa de perguntar qual dos dois zeros é o dela', FICHA],
  ['Campanhas deixa de perguntar', CAMPANHAS],
  ['Automações deixa de perguntar', AUTOMACOES],
];

for (const [nome, arquivo] of quebras) {
  test(nome, () => {
    const base = copia();
    try {
      const caminho = join(base, arquivo);
      const antes = readFileSync(caminho, 'utf8');
      const depois = antes.replace(/faltaDeTexto\(/g, 'naoChamada(');
      assert.notEqual(depois, antes, 'a quebra não casou — o teste provaria nada');
      writeFileSync(caminho, depois);
      const problemas = falhasDoVazioDeTexto(base);
      assert.ok(
        problemas.some((p) => p.includes(arquivo)),
        `a guarda não viu ${arquivo}: ${JSON.stringify(problemas)}`,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

test('a tela nova que recorta por tipo e não pergunta é reprovada', () => {
  const base = copia();
  try {
    const caminho = join(base, 'apps/web/src/app/admin/inventada/page.tsx');
    mkdirSync(dirname(caminho), { recursive: true });
    writeFileSync(
      caminho,
      `import { TIPOS_DE_CAMPANHA } from '@barbearia/core';\n` +
        `export default function Tela({ t }) {\n` +
        `  const uteis = t.filter((x) => TIPOS_DE_CAMPANHA.includes(x.tipo));\n` +
        `  return uteis.length === 0 ? <p>Nada por aqui.</p> : null;\n` +
        `}\n`,
    );
    const problemas = falhasDoVazioDeTexto(base);
    assert.ok(
      problemas.some((p) => p.includes('inventada')),
      `a guarda não cobrou a tela nova: ${JSON.stringify(problemas)}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a frase antiga solta é reprovada mesmo com a pergunta feita em outro lugar', () => {
  const base = copia();
  try {
    const caminho = join(base, 'apps/web/src/app/admin/outra/page.tsx');
    mkdirSync(dirname(caminho), { recursive: true });
    writeFileSync(
      caminho,
      `export default function Tela({ textos }) {\n` +
        `  return textos.length === 0 ? <p>Nenhum texto aprovado — nada vai sair.</p> : null;\n` +
        `}\n`,
    );
    const problemas = falhasDoVazioDeTexto(base);
    assert.ok(
      problemas.some((p) => p.includes('outra')),
      `a frase antiga passou solta: ${JSON.stringify(problemas)}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('comentário que cita a frase antiga não reprova', () => {
  const base = copia();
  try {
    const caminho = join(base, 'apps/web/src/app/admin/comentada/page.tsx');
    mkdirSync(dirname(caminho), { recursive: true });
    writeFileSync(
      caminho,
      `/* Antes esta tela dizia "Nenhum texto aprovado" para os dois casos. */\n` +
        `export default function Tela() {\n  return null;\n}\n`,
    );
    assert.deepEqual(
      falhasDoVazioDeTexto(base).filter((p) => p.includes('comentada')),
      [],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
