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
function scanTexto(texto, arquivo, historico = false, primeiraLinha = 1) {
  const achado = (tipo, linha) => registrar(historico ? `${tipo} no histórico Git` : tipo, arquivo, linha);
  const linhas = texto.split(/\r?\n/);
  for (let i=0;i<linhas.length;i+=1) {
    const linha = linhas[i];
    for (const [tipo, regex] of PATTERNS) {
      regex.lastIndex = 0;
      const m = regex.exec(linha);
      if (m && !PLACEHOLDER.test(m[0])) achado(tipo, primeiraLinha+i);
    }
    // Literal de alta entropia atribuído a variável que por nome deveria ser secret.
    // Em código exigimos string literal; em arquivo estilo env aceitamos valor sem aspas.
    if (!/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(arquivo)) {
      const nomeSensivel = '[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|ENCRYPTION_KEY)[A-Z0-9_]*';
      const cotado = new RegExp(`\\b${nomeSensivel}\\b\\s*[:=]\\s*['\"]([^'\"\\n]{20,})['\"]`).exec(linha);
      const envLike = new RegExp(`^\\s*(?:export\\s+)?${nomeSensivel}\\s*=\\s*([^\\s#]{20,})`).exec(linha);
      const valor = cotado?.[1] ?? envLike?.[1];
      if (valor && !PLACEHOLDER.test(valor)) achado('secret literal', primeiraLinha+i);
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
      // O caminho acompanha cada trecho. Fixtures têm a mesma regra na árvore
      // e no histórico; padrões de credencial continuam proibidos nos testes.
      const diff = execFileSync('git', ['-c', 'core.quotePath=false', 'log', '-p',
        '--all', '--no-color', '--no-ext-diff', '--no-renames', '--format=commit:%H', '--unified=0'], {
        encoding: 'utf8', maxBuffer: 128*1024*1024,
      });
      let arquivo = null;
      let commit = '';
      let numero = 0;
      let noTrecho = false;
      for (const linha of diff.split(/\r?\n/)) {
        if (/^commit:[a-f0-9]{40,64}$/.test(linha)) {
          commit = linha.slice(7); arquivo = null; noTrecho = false;
        } else if (linha.startsWith('diff --git ')) {
          arquivo = null; noTrecho = false;
        } else if (!noTrecho && linha.startsWith('+++ ')) {
          let destino = linha.slice(4);
          if (destino.startsWith('"')) destino = JSON.parse(destino);
          arquivo = destino.startsWith('b/') ? destino.slice(2) : null;
          if (arquivo && ENV_REAL.test(basename(arquivo)) && !ENV_PERMITIDOS.has(basename(arquivo))) {
            registrar('arquivo .env no histórico Git', `${arquivo}@${commit}`, 0);
          }
        } else if (linha.startsWith('@@ ')) {
          noTrecho = true;
          numero = Number(/\+(\d+)/.exec(linha)?.[1] ?? 1);
        } else if (arquivo && linha.startsWith('+')) {
          const antes = suspeitas.length;
          scanTexto(linha.slice(1), arquivo, true, numero++);
          for (const achado of suspeitas.slice(antes)) achado.arquivo += `@${commit}`;
        }
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
