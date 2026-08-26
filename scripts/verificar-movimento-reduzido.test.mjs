import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { falhasDoMovimentoReduzido } from './verificar-movimento-reduzido.mjs';

const raiz = resolve(import.meta.dirname, '..');
const fontes = {
  indice: readFileSync(resolve(raiz, 'apps/web/src/app/globals.css'), 'utf8'),
  regra: readFileSync(resolve(raiz, 'apps/web/src/app/styles/140-reduced-motion.css'), 'utf8'),
};

test('o produto de hoje desliga movimento para quem pede', () =>
  assert.deepEqual(falhasDoMovimentoReduzido(fontes), []));

const mutacoes = [
  [
    'a regra deixa de ser a última da cascata',
    { indice: `${fontes.indice}@import './styles/150-nova.css';\n` },
  ],
  [
    'a regra some do índice',
    { indice: fontes.indice.replace("@import './styles/140-reduced-motion.css';\n", '') },
  ],
  [
    'o media query vira outra coisa',
    { regra: fontes.regra.replace('prefers-reduced-motion: reduce', 'prefers-contrast: more') },
  ],
  [
    'a regra passa a alcançar só um seletor',
    { regra: fontes.regra.replace(/\*,\n\s*\*::before,\n\s*\*::after/, '.trilho') },
  ],
  [
    'perde o !important e volta a perder para o que veio antes',
    { regra: fontes.regra.replace(/ !important/g, '') },
  ],
  [
    'usa none e mata o transitionend',
    { regra: fontes.regra.replace(/transition-duration: 0\.01ms/, 'transition-duration: none') },
  ],
];

for (const [nome, mudanca] of mutacoes) {
  test(`detecta regressão: ${nome}`, () =>
    assert.ok(falhasDoMovimentoReduzido({ ...fontes, ...mudanca }).length > 0));
}
