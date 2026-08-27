#!/usr/bin/env node
/**
 * Toda hora desenhada numa tela diz de que fuso ela é.
 *
 * ## O que ela pega, e por que só isso
 *
 * `Intl.DateTimeFormat` e `toLocale*String` sem `timeZone` caem no fuso do
 * **processo** — UTC no servidor, o do aparelho no navegador. Quando o formato
 * pede `hour` ou `minute`, os dois lados escrevem strings diferentes, o React
 * não reidrata e a **página inteira** cai com o erro 418: não é a hora errada
 * num canto, é a tela em branco. Foi assim que a ficha do cliente quebrou no
 * percurso da medição do bloco 134, e as outras oito estavam de pé desde antes.
 *
 * O corte foi **medido antes de escrever esta guarda**, que é o que separa uma
 * guarda de um incômodo: "toda formatação sem `timeZone`" acusava 42 de 63
 * chamadas e teria sido desligada na primeira semana; "pede hora e não diz o
 * fuso" acusava 8, e as 8 eram defeito. As 34 restantes mostram só data e erram
 * um dia por ano no pior caso — ficam de fora de propósito, e o dia em que uma
 * delas passar a pedir hora, esta guarda a pega.
 *
 * ## De onde sai o fuso
 *
 * Da unidade (`estado.empresa.timezone`), nunca do aparelho — é a regra que
 * este repositório escreve desde o defeito D2. O painel da plataforma atravessa
 * barbearias e não tem unidade: ele usa `FUSO_DA_PLATAFORMA`, que é constante
 * nomeada em `packages/core` e não literal solto numa página.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = process.env['HORA_RAIZ'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const alvo = join(raiz, 'apps/web/src');

/** Comentário fora antes de casar: guarda que proíbe documentar o próprio motivo é guarda que alguém apaga. */
const semComentarios = (t) =>
  t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function arquivos(dir) {
  const saida = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) saida.push(...arquivos(caminho));
    else if (/\.tsx?$/.test(nome) && !/\.test\.tsx?$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

/** Os argumentos da chamada, com os parênteses equilibrados — o formato pode ser multilinha. */
function argumentos(texto, aberturaEm) {
  let profundidade = 0;
  for (let i = aberturaEm; i < texto.length; i += 1) {
    if (texto[i] === '(') profundidade += 1;
    else if (texto[i] === ')') {
      profundidade -= 1;
      if (profundidade === 0) return texto.slice(aberturaEm, i + 1);
    }
  }
  return texto.slice(aberturaEm);
}

const problemas = [];
for (const caminho of arquivos(alvo)) {
  const texto = semComentarios(readFileSync(caminho, 'utf8'));
  const padrao = /(Intl\.DateTimeFormat|toLocale(?:Date|Time)?String)\s*\(/g;
  let achado;
  while ((achado = padrao.exec(texto)) !== null) {
    const args = argumentos(texto, achado.index + achado[0].length - 1);
    if (args.includes('timeZone')) continue;
    const pedeHora =
      args.includes('hour:') || args.includes('minute:') || achado[1] === 'toLocaleTimeString';
    if (!pedeHora) continue;
    const linha = texto.slice(0, achado.index).split('\n').length;
    problemas.push(`${relative(raiz, caminho)}:${linha} — ${achado[1]} pede hora sem dizer o fuso`);
  }
}

if (problemas.length) {
  console.error(`hora com fuso: ${problemas.length} problema(s)\n`);
  for (const p of problemas) console.error(`  - ${p}`);
  console.error(
    '\n  O fuso vem da unidade (`estado.empresa.timezone`), nunca do aparelho.',
  );
  console.error('  No painel da plataforma, que atravessa barbearias, use `FUSO_DA_PLATAFORMA`.');
  console.error('  Sem `timeZone`, servidor e navegador escrevem horas diferentes e a página cai com o erro 418.');
  process.exit(1);
}
console.log('hora com fuso: toda hora desenhada diz de que fuso ela é');
