#!/usr/bin/env node
/**
 * Quem pede menos movimento recebe menos movimento — em toda a cascata.
 *
 * O §5 promete que `prefers-reduced-motion` desliga o movimento. Havia **uma**
 * regra dessas em todo o produto, escopada ao trilho e à faixa de abas: as doze
 * transições e oito animações restantes a ignoravam. Promessa escrita valendo
 * para dois seletores.
 *
 * O que se cobra é a regra global, e que ela seja a **última** da cascata — é a
 * ordem que a faz vencer, porque a especificidade é de propósito baixa (`*`).
 * Assim a transição escrita amanhã em qualquer arquivo anterior nasce coberta,
 * sem ninguém lembrar deste teste.
 *
 * Ela também recusa `duration: none`: com `none` o `transitionend` nunca dispara
 * e uma sequência que espere por ele trava sem sintoma.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const raiz = resolve(import.meta.dirname, '..');
const ler = (p) => readFileSync(resolve(raiz, p), 'utf8');

export function falhasDoMovimentoReduzido(fontes = {}) {
  const indice = fontes.indice ?? ler('apps/web/src/app/globals.css');
  const f = [];

  const imports = [...indice.matchAll(/@import\s+'\.\/styles\/([^']+)'/g)].map((m) => m[1]);
  const ultimo = imports.at(-1);
  if (ultimo !== '140-reduced-motion.css') {
    f.push(`a regra de movimento reduzido não é a última da cascata (última: ${ultimo ?? 'nenhuma'})`);
    return f;
  }

  const regra = fontes.regra ?? ler('apps/web/src/app/styles/140-reduced-motion.css');
  const semComentario = regra.replace(/\/\*[\s\S]*?\*\//g, '');
  if (!/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(semComentario)) {
    f.push('o arquivo final não declara prefers-reduced-motion');
  }
  if (!/\*\s*,[\s\S]*\*::before[\s\S]*\*::after/.test(semComentario)) {
    f.push('a regra não alcança todo elemento e seus pseudo-elementos');
  }
  for (const propriedade of ['animation-duration', 'transition-duration', 'scroll-behavior']) {
    if (!new RegExp(`${propriedade}:[^;]*!important`).test(semComentario)) {
      f.push(`${propriedade} não é desligada com !important`);
    }
  }
  if (/(animation|transition)-duration:\s*none/.test(semComentario)) {
    f.push('duração `none` impede transitionend de disparar; use 0.01ms');
  }
  return f;
}

const direto = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direto) {
  const f = falhasDoMovimentoReduzido();
  if (f.length) { console.error(f.map((x) => `FAIL: ${x}`).join('\n')); process.exitCode = 1; }
  else console.log('movimento reduzido: OK');
}
