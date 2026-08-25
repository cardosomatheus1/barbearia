#!/usr/bin/env node
/**
 * Varredura de segredos sem imprimir o valor encontrado.
 *
 * - Sempre examina a árvore atual.
 * - Com `--history`, examina também o diff histórico quando existe um checkout
 *   Git real. ZIPs deliberadamente não têm `.git`; nesse caso o script informa
 *   a limitação, mas a árvore atual continua sendo verificada.
 * - Só padrões de alta confiança derrubam o portão. Isso evita transformar a
 *   esteira numa coleção de falsos positivos que acaba ignorada.
 */
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

const HISTORICO = process.argv.includes('--history');
const IGNORAR_DIR = new Set([
  '.git', 'node_modules', '.pnpm-store', 'dist', '.next', 'coverage', '.turbo',
  'playwright-report', 'test-results', '.cache',
]);
const MAX_BYTES = 2 * 1024 * 1024;
const BINARIAS = new Set([
  '.png','.jpg','.jpeg','.gif','.webp','.ico','.pdf','.zip','.gz','.tgz','.woff','.woff2','.ttf','.otf',
  '.mp4','.mov','.webm','.mp3','.wav','.sqlite','.db',
]);

const PLACEHOLDER = /(?:example|exemplo|changeme|troque|gere[-_]|replace|placeholder|dummy|fake|test|teste|local|localhost|your[_-]|seu[_-]|<[^>]+>|\$\{|\$\(|\$[A-Z_]|process\.env|github\.run|000000|xxxx)/i;
const PATTERNS = [
  ['chave privada PEM', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Stripe live secret', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g],
  ['GitHub token', /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
];

const ENV_REAL = /^\.env(?:\..+)?$/;
const ENV_PERMITIDOS = new Set(['.env.example', '.env.sample', '.env.template']);

const suspeitas = [];
function registrar(tipo, arquivo, linha) {
  suspeitas.push({ tipo, arquivo, linha });
}
function scanTexto(texto, arquivo) {
  const linhas = texto.split(/\r?\n/);
  for (let i=0;i<linhas.length;i+=1) {
    const linha = linhas[i];
    for (const [tipo, regex] of PATTERNS) {
      regex.lastIndex = 0;
      const m = regex.exec(linha);
      if (m && !PLACEHOLDER.test(m[0])) registrar(tipo, arquivo, i+1);
    }
    // Literal de alta entropia atribuído a variável que por nome deveria ser secret.
    // Em código exigimos string literal; em arquivo estilo env aceitamos valor sem aspas.
    if (!/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(arquivo)) {
      const nomeSensivel = '[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|ENCRYPTION_KEY)[A-Z0-9_]*';
      const cotado = new RegExp(`\\b${nomeSensivel}\\b\\s*[:=]\\s*['\"]([^'\"\\n]{20,})['\"]`).exec(linha);
      const envLike = new RegExp(`^\\s*(?:export\\s+)?${nomeSensivel}\\s*=\\s*([^\\s#]{20,})`).exec(linha);
      const valor = cotado?.[1] ?? envLike?.[1];
      if (valor && !PLACEHOLDER.test(valor)) registrar('secret literal', arquivo, i+1);
    }
  }
}

async function* arquivos(dir='.') {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory() && IGNORAR_DIR.has(e.name)) continue;
    const caminho = join(dir,e.name);
    if (e.isDirectory()) yield* arquivos(caminho);
    else yield caminho;
  }
}

for await (const caminho of arquivos('.')) {
  const rel = relative('.', caminho) || basename(caminho);
  const base = basename(caminho);
  if (ENV_REAL.test(base) && !ENV_PERMITIDOS.has(base)) registrar('arquivo .env versionável', rel, 1);
  if (BINARIAS.has(extname(base).toLowerCase())) continue;
  const info = await stat(caminho);
  if (info.size > MAX_BYTES) continue;
  let buf;
  try { buf = await readFile(caminho); } catch { continue; }
  if (buf.includes(0)) continue;
  scanTexto(buf.toString('utf8'), rel);
}

let historico = 'não solicitado';
if (HISTORICO) {
  if (!existsSync('.git')) {
    historico = 'indisponível neste artefato (sem .git)';
  } else {
    try {
      const diff = execFileSync('git', ['log','-p','--all','--no-color','--format='], {
        encoding:'utf8', maxBuffer: 128*1024*1024,
      });
      const nomes = execFileSync('git', ['log','--all','--name-only','--pretty=format:'], {
        encoding:'utf8', maxBuffer: 64*1024*1024,
      });
      for (const nome of nomes.split(/\r?\n/).filter(Boolean)) {
        const base = basename(nome);
        if (ENV_REAL.test(base) && !ENV_PERMITIDOS.has(base)) registrar('arquivo .env no histórico Git', 'git-history', 0);
      }
      for (const [tipo, regex] of PATTERNS) {
        regex.lastIndex = 0;
        let m;
        while ((m = regex.exec(diff))) {
          if (!PLACEHOLDER.test(m[0])) registrar(`${tipo} no histórico Git`, 'git-history', 0);
        }
      }
      for (const linha of diff.split(/\r?\n/)) {
        if (!/^\+[^+]/.test(linha)) continue;
        const adicionada = linha.slice(1);
        const nomeSensivel = '[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|ENCRYPTION_KEY)[A-Z0-9_]*';
        const cotado = new RegExp(`\\b${nomeSensivel}\\b\\s*[:=]\\s*['\"]([^'\"\\n]{20,})['\"]`).exec(adicionada);
        const envLike = new RegExp(`^\\s*(?:export\\s+)?${nomeSensivel}\\s*=\\s*([^\\s#]{20,})`).exec(adicionada);
        const valor = cotado?.[1] ?? envLike?.[1];
        if (valor && !PLACEHOLDER.test(valor)) registrar('secret literal no histórico Git', 'git-history', 0);
      }
      historico = 'verificado';
    } catch (erro) {
      console.error(`secret scan: não foi possível ler o histórico Git (${erro?.name ?? 'erro'})`);
      process.exit(2);
    }
  }
}

if (suspeitas.length) {
  console.error(`secret scan: ${suspeitas.length} achado(s); valores não são exibidos`);
  for (const s of suspeitas) console.error(`- ${s.tipo}: ${s.arquivo}${s.linha ? `:${s.linha}` : ''}`);
  process.exit(1);
}
console.log(`secret scan: árvore atual limpa; histórico Git: ${historico}`);
