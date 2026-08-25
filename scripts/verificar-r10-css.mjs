#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { arquivosCssDoApp, lerCssDoApp } from './css-do-app.mjs';

const raiz = process.cwd();
const indice = join(raiz, 'apps/web/src/app/globals.css');
const pasta = join(dirname(indice), 'styles');
const fonteIndice = readFileSync(indice, 'utf8');
const arquivos = arquivosCssDoApp(raiz);
const falhas = [];
const exigir = (condicao, mensagem) => { if (!condicao) falhas.push(mensagem); };

// O índice só ordena a cascata. Regra nova escrita aqui recria o monólito.
const semComentarios = fonteIndice.replace(/\/\*[\s\S]*?\*\//g, '');
const semImports = semComentarios.replace(/@import\s+['"][^'"]+['"]\s*;/g, '').trim();
exigir(semImports === '', 'globals.css voltou a conter regras; ele deve ser apenas índice de imports');

const nomes = arquivos.map((arquivo) => basename(arquivo));
exigir(new Set(nomes).size === nomes.length, 'um fragmento CSS foi importado mais de uma vez');
exigir(arquivos.length >= 10, `partição encolheu para ${arquivos.length} fragmentos; superfícies voltaram a se misturar`);

const existentes = readdirSync(pasta).filter((n) => n.endsWith('.css')).sort();
const importados = [...nomes].sort();
exigir(JSON.stringify(existentes) === JSON.stringify(importados), 'há fragmento de styles/ não importado ou import inexistente');

// Prefixo numérico é a ordem de cascata escrita no nome; evita reordenar por acidente.
const ordens = nomes.map((nome) => Number(nome.match(/^(\d+)-/)?.[1] ?? Number.NaN));
exigir(ordens.every(Number.isFinite), 'todo fragmento precisa de prefixo numérico de ordem');
exigir(ordens.every((n, i) => i === 0 || n > ordens[i - 1]), 'ordem dos imports não acompanha os prefixos dos fragmentos');

let maior = { nome: '', linhas: 0 };
for (const arquivo of arquivos) {
  const linhas = readFileSync(arquivo, 'utf8').split('\n').length;
  if (linhas > maior.linhas) maior = { nome: basename(arquivo), linhas };
  // Não é definição de arquitetura; é alarme contra outro arquivo de 10 mil linhas.
  exigir(linhas <= 1600, `${basename(arquivo)} cresceu para ${linhas} linhas; precisa nova fronteira de superfície`);
}

// Duplicata exata é cópia sem função: mesmo seletor, mesmas declarações.
// O parser é deliberadamente conservador e ignora comentários; regras aninhadas
// com chaves no corpo não entram na expressão, então ele só reprova quando tem
// certeza da repetição simples.
const css = lerCssDoApp(raiz).replace(/\/\*[\s\S]*?\*\//g, '');
const regras = new Map();
for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const seletor = (match[1] ?? '').replace(/\s+/g, ' ').trim();
  if (!seletor || seletor.startsWith('@')) continue;
  const corpo = (match[2] ?? '').split(';').map((x) => x.trim()).filter(Boolean).join(';');
  const chave = `${seletor}{${corpo}}`;
  regras.set(chave, (regras.get(chave) ?? 0) + 1);
}
const duplicadas = [...regras.entries()].filter(([, n]) => n > 1).map(([regra]) => regra.slice(0, 140));
exigir(duplicadas.length === 0, `regras CSS idênticas duplicadas: ${duplicadas.join(' | ')}`);

if (falhas.length) {
  console.error(`R10 reprovado (${falhas.length})`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}

console.log(`R10 ok: ${arquivos.length} fragmentos; maior ${maior.nome} com ${maior.linhas} linhas; zero regra idêntica duplicada.`);
