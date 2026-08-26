#!/usr/bin/env node
/**
 * Cada superfície com casco próprio escreve o próprio 404.
 *
 * O `not-found.tsx` da raiz diz "Estabelecimento não encontrado — confira o
 * endereço na bio da barbearia". Está certo para quem digitou errado o endereço
 * público de uma barbearia, e é a única audiência que ele imagina. Sem um 404
 * por superfície, o dono que erra uma rota do próprio painel — ou abre um link
 * salvo de uma versão anterior, que foi como isto apareceu — é mandado conferir
 * o Instagram da própria barbearia.
 *
 * É a forma 404 do que a convenção já registra sobre o 403 respondido com
 * "recarregue a página": recusa vestida de outra coisa, com uma instrução que
 * nunca vai funcionar.
 *
 * O corte é derivado, não uma lista: **quem tem `layout.tsx` próprio tem casco
 * próprio, e portanto público próprio**. A superfície que alguém criar no bloco
 * seguinte nasce cobrada, sem ninguém lembrar dela. A raiz fica de fora porque
 * é ela que atende o público — o texto dela é o certo para o visitante anônimo.
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const raiz = resolve(import.meta.dirname, '..');
const APP = 'apps/web/src/app';

export function falhasDo404PorSuperficie(base = resolve(raiz, APP)) {
  const f = [];
  for (const entrada of readdirSync(base, { withFileTypes: true })) {
    // `[slug]` é a página pública da barbearia: o texto da raiz é o dela.
    if (!entrada.isDirectory() || entrada.name.startsWith('[')) continue;
    const dir = resolve(base, entrada.name);
    if (!existsSync(resolve(dir, 'layout.tsx'))) continue;
    const nf = resolve(dir, 'not-found.tsx');
    if (!existsSync(nf)) {
      f.push(`${entrada.name} tem casco próprio e nenhum 404 próprio`);
      continue;
    }
    // Um arquivo que só repete o texto da raiz não resolve nada. O comentário sai
    // antes de casar: este arquivo **cita** a frase da raiz para explicar por que
    // existe, e uma guarda que proíbe documentar o próprio motivo é guarda que
    // alguém apaga — foi o defeito da guarda de pureza do `core`.
    const semComentario = readFileSync(nf, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (semComentario.includes('bio da barbearia')) {
      f.push(`${entrada.name} repete o 404 do público, que fala com outra pessoa`);
    }
  }
  return f;
}

const direto = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direto) {
  const f = falhasDo404PorSuperficie();
  if (f.length) { console.error(f.map((x) => `FAIL: ${x}`).join('\n')); process.exitCode = 1; }
  else console.log('404 por superfície: OK');
}
