#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { avaliarV8Estatico } from './verificar-v8-estatico-global.mjs';

const css = readFileSync('apps/web/src/app/styles/120-agenda-timeline.css', 'utf8');
const base = {
  'fake.tsx': `
    <main><h1>Teste</h1>
      <img alt="Foto" src="/foto.jpg" />
      <a href="https://example.com" target="_blank" rel="noopener noreferrer">Abrir</a>
      <button className="ui-button ui-button--primary">Salvar</button>
      <details><summary className="dobra__titulo">Mais</summary><p>Texto</p></details>
      <div className="ui-scroll-x"><table><tbody><tr><td>A</td></tr></tbody></table></div>
    </main>
  `,
};
assert.deepEqual(avaliarV8Estatico(base, css), []);

const casos = [
  ['alt', { 'fake.tsx': base['fake.tsx'].replace('alt="Foto" ', '') }, css],
  ['noopener', { 'fake.tsx': base['fake.tsx'].replace(' rel="noopener noreferrer"', '') }, css],
  ['tabindex', { 'fake.tsx': base['fake.tsx'].replace('<main>', '<main tabIndex={2}>') }, css],
  ['div clicável', { 'fake.tsx': base['fake.tsx'].replace('<main>', '<main><div onClick={acao}>x</div>') }, css],
  ['botão fora do DS', { 'fake.tsx': base['fake.tsx'].replace('ui-button ui-button--primary', 'botao-caseiro') }, css],
  ['summary sem contrato', { 'fake.tsx': base['fake.tsx'].replace(' className="dobra__titulo"', '') }, css],
  ['tabela sem scroll', { 'fake.tsx': base['fake.tsx'].replace('<div className="ui-scroll-x">', '<div>') }, css],
  ['alvo agenda', base, css.replace('width: var(--size-touch);', 'width: 28px;')],
];
for (const [nome, fontes, cssMutado] of casos) {
  assert.ok(avaliarV8Estatico(fontes, cssMutado).length > 0, `deveria detectar ${nome}`);
}
console.log(`${casos.length}/${casos.length} mutações negativas do V8 estático detectadas`);
