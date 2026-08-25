#!/usr/bin/env node
/**
 * Guarda de SQL de produção.
 *
 * `$queryRawUnsafe`/`$executeRawUnsafe` aceitam uma string SQL em runtime. Mesmo
 * quando quem chama hoje usa `$1`, a função deixa uma futura concatenação virar
 * execução. Código de produto usa template tagged do Prisma ou `Prisma.sql`.
 *
 * Testes/limpeza ficam fora: `apps/api/test/limpar.ts` usa nome de tabela vindo
 * de um catálogo fechado para TRUNCATE, algo que não existe em request de produção.
 */
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const RAIZES = ['apps', 'packages'];
const IGNORAR_PARTES = new Set(['node_modules', 'dist', '.next', 'coverage', 'test', 'tests', '__tests__']);
const EXT = new Set(['.ts', '.tsx', '.mts', '.cts']);
const PROIBIDO = /\$(?:queryRawUnsafe|executeRawUnsafe)\b/g;

async function* arquivos(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (IGNORAR_PARTES.has(e.name)) continue;
    const caminho = join(dir, e.name);
    if (e.isDirectory()) yield* arquivos(caminho);
    else if (EXT.has(extname(e.name)) && !/\.(?:test|spec)\.[cm]?tsx?$/.test(e.name)) yield caminho;
  }
}

const falhas = [];
for (const raiz of RAIZES) {
  for await (const arquivo of arquivos(raiz)) {
    const texto = await readFile(arquivo, 'utf8');
    const linhas = texto.split(/\r?\n/);
    for (let i = 0; i < linhas.length; i += 1) {
      if (PROIBIDO.test(linhas[i])) falhas.push(`${relative('.', arquivo)}:${i + 1}`);
      PROIBIDO.lastIndex = 0;
    }
  }
}

if (falhas.length) {
  console.error(`SQL inseguro: ${falhas.length} ocorrência(s) de API raw-unsafe em produção:`);
  for (const f of falhas) console.error(`- ${f}`);
  process.exit(1);
}
console.log('SQL seguro: 0 chamadas raw-unsafe em código de produção');
