#!/usr/bin/env node
/**
 * Auditoria barata de navegação interna.
 *
 * Confere URLs /admin/... literais no código de produção contra as páginas e
 * route handlers reais do App Router. Links dinâmicos continuam cobertos pelas
 * guardas de cada fluxo e pelo build do Next; aqui o objetivo é pegar o caso
 * simples e caro de descobrir em produção: link literal apontando para nada.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const APP = join(ROOT, 'apps/web/src/app');
const SRC = join(ROOT, 'apps/web/src');

function arquivos(dir) {
  const saida = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    const stat = statSync(caminho);
    if (stat.isDirectory()) saida.push(...arquivos(caminho));
    else saida.push(caminho);
  }
  return saida;
}

function padraoDaRota(arquivo) {
  const pasta = relative(APP, arquivo).split('/').slice(0, -1);
  const partes = [];
  for (const parte of pasta) {
    if (/^\(.+\)$/.test(parte)) continue; // route group não entra na URL
    if (/^\[\[\.\.\..+\]\]$/.test(parte) || /^\[\.\.\..+\]$/.test(parte)) partes.push('**');
    else if (/^\[.+\]$/.test(parte)) partes.push('*');
    else partes.push(parte);
  }
  return `/${partes.join('/')}`.replace(/\/$/, '') || '/';
}

function corresponde(rota, padrao) {
  const r = rota.split('/').filter(Boolean);
  const p = padrao.split('/').filter(Boolean);
  let i = 0;
  for (const item of p) {
    if (item === '**') return true;
    if (i >= r.length) return false;
    if (item !== '*' && item !== r[i]) return false;
    i += 1;
  }
  return i === r.length;
}

const rotas = arquivos(APP)
  .filter((p) => p.endsWith('/page.tsx') || p.endsWith('/route.ts'))
  .map(padraoDaRota);

const referencias = [];
for (const arquivo of arquivos(SRC)) {
  if (!/\.(?:ts|tsx|js|jsx|mjs)$/.test(arquivo)) continue;
  if (/\.(?:test|spec)\.[^.]+$/.test(arquivo) || arquivo.includes('/__tests__/')) continue;
  const texto = readFileSync(arquivo, 'utf8');
  // Só strings fechadas: template com ${...} é dinâmico e não deve ser julgado
  // por esta guarda textual.
  for (const match of texto.matchAll(/(['"])(\/admin\/[A-Za-z0-9_./-]+)\1/g)) {
    referencias.push({ rota: match[2].replace(/\/$/, ''), arquivo: relative(ROOT, arquivo) });
  }
}

const quebradas = referencias.filter(({ rota }) => !rotas.some((padrao) => corresponde(rota, padrao)));
if (quebradas.length) {
  console.error('Rotas internas literais sem página/handler:');
  for (const item of quebradas) console.error(`- ${item.rota} em ${item.arquivo}`);
  process.exit(1);
}

console.log(`rotas web: ${rotas.length} página(s)/handler(s); ${referencias.length} referência(s) literais válidas`);
