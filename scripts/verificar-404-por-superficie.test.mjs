import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { falhasDo404PorSuperficie } from './verificar-404-por-superficie.mjs';

test('o produto de hoje tem 404 em toda superfície com casco', () =>
  assert.deepEqual(falhasDo404PorSuperficie(), []));

/** Monta uma árvore de `app/` de mentira: a guarda lê o disco, então o negativo também. */
function arvore(superficies) {
  const base = mkdtempSync(resolve(tmpdir(), 'app404-'));
  for (const [nome, arquivos] of Object.entries(superficies)) {
    mkdirSync(resolve(base, nome), { recursive: true });
    for (const [arquivo, corpo] of Object.entries(arquivos)) {
      writeFileSync(resolve(base, nome, arquivo), corpo);
    }
  }
  return base;
}

const casos = [
  ['casco sem 404 próprio', { admin: { 'layout.tsx': 'export default function L(){}' } }, 1],
  [
    'casco com o 404 do público copiado',
    {
      admin: {
        'layout.tsx': 'export default function L(){}',
        'not-found.tsx': 'export default function N(){return <p>Confira o endereço na bio da barbearia.</p>}',
      },
    },
    1,
  ],
  [
    'superfície nova cobrada sem ninguém lembrar dela',
    {
      admin: { 'layout.tsx': 'x', 'not-found.tsx': 'proprio' },
      franqueadora: { 'layout.tsx': 'export default function L(){}' },
    },
    1,
  ],
];

for (const [nome, superficies, esperado] of casos) {
  test(`detecta regressão: ${nome}`, () => {
    const base = arvore(superficies);
    try {
      assert.equal(falhasDo404PorSuperficie(base).length, esperado);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

test('não cobra de quem não tem casco próprio, nem de [slug]', () => {
  const base = arvore({
    '[slug]': { 'layout.tsx': 'export default function L(){}' },
    privacidade: { 'page.tsx': 'export default function P(){}' },
  });
  try {
    assert.deepEqual(falhasDo404PorSuperficie(base), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('o comentário que cita a frase da raiz não reprova', () => {
  const base = arvore({
    admin: {
      'layout.tsx': 'x',
      'not-found.tsx': '/* a raiz manda conferir a bio da barbearia, e por isso este existe */\nexport default function N(){return <p>Esta tela não existe</p>}',
    },
  });
  try {
    assert.deepEqual(falhasDo404PorSuperficie(base), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
