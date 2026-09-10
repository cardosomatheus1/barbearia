import { X509Certificate, createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, mkdtemp, rename, symlink, rm, realpath, chmod, readdir, lstat } from 'node:fs/promises';
import { isAbsolute, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { baixarPublico, urlDaFonte } from './fiscal-confianca-download.mjs';
import { reservarAtualizacao } from './fiscal-confianca-lock.mjs';

const executar = promisify(execFile);
async function openssl(args) {
  return (await executar('/usr/bin/openssl', args, { timeout: 10_000, maxBuffer: 64 * 1024, env: { LANG: 'C' } })).stdout;
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function exigir(condicao, codigo) { if (!condicao) throw new Error(codigo); }

export function validarManifesto(m) {
  exigir(m && m.version === 1 && Array.isArray(m.cas) && m.cas.length > 0 && m.cas.length <= 64 &&
    Array.isArray(m.crls) && m.crls.length > 0 && m.crls.length <= 64, 'manifesto_invalido');
  const ids = new Set();
  for (const ca of m.cas) {
    exigir(ca && /^[a-z0-9_-]{1,50}$/.test(ca.id) && !ids.has(ca.id) &&
      /^[a-f0-9]{64}$/.test(ca.sha256) && typeof ca.root === 'boolean', 'ca_invalida');
    urlDaFonte(ca.url); ids.add(ca.id);
  }
  exigir(m.cas.some(ca => ca.root), 'raiz_ausente');
  const emissores = new Set();
  for (const crl of m.crls) {
    exigir(crl && ids.has(crl.issuer) && !emissores.has(crl.issuer), 'crl_invalida');
    urlDaFonte(crl.url, true); emissores.add(crl.issuer);
  }
  // Toda CA configurada pode emitir certificados utilizados no caminho.
  exigir(ids.size === emissores.size, 'crl_ausente');
  return m;
}

/** Só publica após conferir pins, cadeia, assinatura, vigência e avanço das CRLs. */
export async function atualizarConfianca(manifesto, destino, { baixar = baixarPublico, agora = new Date() } = {}) {
  const m = validarManifesto(manifesto);
  exigir(isAbsolute(destino) && Number.isFinite(agora.getTime()), 'destino_invalido');
  await mkdir(destino, { recursive: true, mode: 0o750 });
  const liberar = await reservarAtualizacao(join(destino, '.atualizando.lock'));
  let pasta; let publicada = false; let apontador;
  try {
    pasta = await mkdtemp(join(destino, 'geracao-'));
    await chmod(pasta, 0o750);
    let anterior = { crls: {} };
    try { anterior = JSON.parse(await readFile(join(destino, 'current', 'estado.json'), 'utf8')); }
    catch (erro) { if (erro.code !== 'ENOENT') throw new Error('estado_anterior_invalido'); }
    const certificados = new Map(); const raizes = []; const todas = [];
    for (const ca of m.cas) {
      const bytes = await baixar(ca.url, 128 * 1024, false);
      const c = new X509Certificate(bytes);
      exigir(hash(c.raw) === ca.sha256 && c.ca && agora >= new Date(c.validFrom) && agora < new Date(c.validTo), 'ca_sem_confianca');
      if (ca.root) exigir(c.checkIssued(c) && c.verify(c.publicKey), 'raiz_invalida');
      certificados.set(ca.id, c); todas.push(c.toString()); if (ca.root) raizes.push(c.toString());
      exigir(Buffer.byteLength(raizes.join('\n')) <= 512 * 1024 && Buffer.byteLength(todas.join('\n')) <= 2 * 1024 * 1024, 'catalogo_limite');
      await writeFile(join(pasta, `${ca.id}.pem`), c.toString(), { mode: 0o640 });
    }
    await writeFile(join(pasta, 'raizes.pem'), raizes.join('\n'), { mode: 0o640 });
    await writeFile(join(pasta, 'cadeias.pem'), todas.join('\n'), { mode: 0o640 });
    const listas = []; const estado = { version: 1, checkedAt: agora.toISOString(), crls: {} };
    let validaAte = Infinity;
    for (const fonte of m.crls) {
      const raw = await baixar(fonte.url, 16 * 1024 * 1024, true);
      const entrada = join(pasta, `${fonte.issuer}.crl.raw`); const saida = join(pasta, `${fonte.issuer}.crl.pem`);
      await writeFile(entrada, raw, { mode: 0o640 });
      await openssl(['crl', '-inform', raw.subarray(0, 30).toString().startsWith('-----BEGIN') ? 'PEM' : 'DER', '-in', entrada, '-out', saida]);
      await openssl(['crl', '-in', saida, '-verify', '-CAfile', join(pasta, `${fonte.issuer}.pem`), '-noout']);
      const info = await openssl(['crl', '-in', saida, '-lastupdate', '-nextupdate', '-crlnumber', '-noout']);
      const ultima = Date.parse(info.match(/^lastUpdate=(.+)$/m)?.[1] ?? '');
      const proxima = Date.parse(info.match(/^nextUpdate=(.+)$/m)?.[1] ?? '');
      const numero = info.match(/^crlNumber=(0x[0-9A-Fa-f]+)$/m)?.[1];
      exigir(Number.isFinite(ultima) && Number.isFinite(proxima) && ultima <= agora.getTime() &&
        proxima > agora.getTime() + 3600_000 && proxima > ultima, 'crl_fora_da_vigencia');
      const pem = await readFile(saida); const digest = hash(pem);
      const pin = hash(certificados.get(fonte.issuer).raw); const antes = anterior.crls[pin];
      if (antes) {
        exigir(ultima >= antes.lastUpdate && (ultima !== antes.lastUpdate || digest === antes.sha256) &&
          (!antes.number || (numero && BigInt(numero) >= BigInt(antes.number))), 'crl_retrocedeu');
      }
      estado.crls[pin] = { lastUpdate: ultima, nextUpdate: proxima, sha256: digest, number: numero ?? null };
      validaAte = Math.min(validaAte, proxima); listas.push(pem.toString());
      exigir(Buffer.byteLength(listas.join('\n')) <= 32 * 1024 * 1024, 'catalogo_limite');
      await rm(entrada);
    }
    const crls = listas.join('\n'); exigir(Buffer.byteLength(crls) <= 32 * 1024 * 1024, 'catalogo_limite');
    await writeFile(join(pasta, 'crls.pem'), crls, { mode: 0o640 });
    for (const ca of m.cas) {
      await openssl(['verify', '-no-CAfile', '-no-CApath', '-no-CAstore', '-trusted', join(pasta, 'raizes.pem'),
        '-untrusted', join(pasta, 'cadeias.pem'), '-CRLfile', join(pasta, 'crls.pem'), '-crl_check_all',
        '-x509_strict', '-auth_level', '2', '-verify_depth', '16', '-purpose', 'any',
        '-attime', String(Math.floor(agora.getTime() / 1000)), join(pasta, `${ca.id}.pem`)]);
    }
    await writeFile(join(pasta, 'estado.json'), JSON.stringify(estado, null, 2) + '\n', { mode: 0o640 });
    // Sem mudança no material, não acumular uma geração a cada quinze minutos.
    if (JSON.stringify(anterior.crls) === JSON.stringify(estado.crls)) {
      try {
        if ((await readFile(join(destino, 'current', 'raizes.pem'), 'utf8')) === raizes.join('\n')) {
          return { status: 'sem_alteracao', validUntil: new Date(validaAte).toISOString(), authorities: certificados.size };
        }
      } catch (erro) { if (erro.code !== 'ENOENT') throw erro; }
    }
    apontador = join(destino, `.current-${randomUUID()}`);
    await symlink(basename(pasta), apontador); await rename(apontador, join(destino, 'current')); publicada = true;
    // Retenção de 7 dias permite leituras em andamento e diagnóstico. Somente
    // diretórios gerados por este utilitário e com seu estado são candidatos.
    for (const item of await readdir(destino, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^geracao-[A-Za-z0-9]{6}$/.test(item.name) || item.name === basename(pasta)) continue;
      const antiga = join(destino, item.name);
      try {
        const stat = await lstat(join(antiga, 'estado.json'));
        if (stat.isFile() && stat.mtimeMs < Date.now() - 7 * 86400_000) await rm(antiga, { recursive: true });
      } catch { /* Falha de limpeza não desfaz a publicação já validada. */ }
    }
    return { status: 'atualizado', validUntil: new Date(validaAte).toISOString(), authorities: certificados.size };
  } finally {
    if (apontador) await rm(apontador, { force: true });
    if (pasta && !publicada) await rm(pasta, { recursive: true, force: true });
    await liberar();
  }
}

async function main() {
  const [modo, config, destino] = process.argv.slice(2);
  if (modo === '--health') {
    try {
      exigir(isAbsolute(config), 'diretorio_invalido');
      const s = JSON.parse(await readFile(join(config, 'ultima-verificacao.json'), 'utf8'));
      exigir(Date.now() - Date.parse(s.checkedAt) >= 0 && Date.now() - Date.parse(s.checkedAt) < 3600_000 &&
        Date.parse(s.validUntil) > Date.now() + 3600_000, 'atualizacao_atrasada');
    } catch { process.exitCode = 1; }
    return;
  }
  exigir(['--once', '--loop'].includes(modo) && config && destino && isAbsolute(config), 'uso: --once|--loop /manifesto.json /destino');
  let parar = false; let timer; let acordar;
  const encerrar = () => { parar = true; clearTimeout(timer); acordar?.(); };
  process.once('SIGINT', encerrar); process.once('SIGTERM', encerrar);
  do {
    try {
      const bytes = await readFile(config); exigir(bytes.length <= 128 * 1024, 'manifesto_limite');
      const resultado = await atualizarConfianca(JSON.parse(bytes.toString()), destino);
      const status = join(destino, `.verificacao-${randomUUID()}`);
      await writeFile(status, JSON.stringify({ ...resultado, checkedAt: new Date().toISOString() }), { mode: 0o640 });
      await rename(status, join(destino, 'ultima-verificacao.json'));
      console.log(JSON.stringify(resultado));
    } catch {
      // Não imprimir URLs nem saídas de processos. A geração válida anterior
      // permanece no lugar, mas continua sujeita à própria expiração.
      console.error(JSON.stringify({ status: 'falhou', code: 'fiscal_confianca_atualizacao_falhou' }));
      if (modo === '--once') process.exitCode = 1;
    }
    if (modo === '--once' || parar) break;
    await new Promise(resolve => { acordar = resolve; timer = setTimeout(resolve, 15 * 60_000); });
  } while (!parar);
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) await main();
