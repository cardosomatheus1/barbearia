import { execFile } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { mkdtemp, open, rm, writeFile, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { CertificadoA1 } from './certificado.js';
import { recusarNfse } from './erros.js';

const executar = promisify(execFile);

async function arquivoPublico(caminho: string, limite: number): Promise<string> {
  const arquivo = await open(caminho, 'r');
  try {
    const stat = await arquivo.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > limite) throw new Error('arquivo_invalido');
    // Leitura limitada também se o arquivo for substituído/crescer durante a leitura.
    const buffer = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await arquivo.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > stat.size) throw new Error('arquivo_alterado');
    return buffer.subarray(0, total).toString('ascii');
  } finally { await arquivo.close(); }
}

function blocosPublicos(pem: string, tipo: 'CERTIFICATE' | 'X509 CRL'): string[] {
  const regex = new RegExp(`-----BEGIN ${tipo}-----[A-Za-z0-9+/=\\r\\n]+-----END ${tipo}-----`, 'g');
  const blocos = pem.match(regex);
  if (!blocos?.length || pem.replace(regex, '').trim()) throw new Error('catalogo_invalido');
  return blocos;
}

/** A raiz vem da instalação; o PFX nunca pode acrescentar uma âncora de confiança. */
export async function validarCadeiaFiscal(certificadoPem: string, cadeiaPem: string | undefined, agora: Date, finalidade: 'sslclient' | 'any') {
  let cadeia = cadeiaPem;
  let raizes: string; let crls: string;
  try {
    let pasta = process.env['FISCAL_CONFIANCA_DIR'];
    if (!pasta || !isAbsolute(pasta) || !Number.isFinite(agora.getTime())) throw new Error('configuracao_ausente');
    // A atualização publica raiz e CRLs como uma geração. Resolver o apontador
    // uma única vez impede combinar arquivos de duas renovações concorrentes.
    let temGeracao = false;
    try { await lstat(join(pasta, 'current')); temGeracao = true; }
    catch (erro) { if (!(erro instanceof Error) || !('code' in erro) || erro.code !== 'ENOENT') throw erro; }
    // Apontador quebrado falha fechado; nunca recupera um catálogo antigo.
    if (temGeracao) pasta = await realpath(join(pasta, 'current'));
    [raizes, crls] = await Promise.all([
      arquivoPublico(join(pasta, 'raizes.pem'), 512 * 1024),
      arquivoPublico(join(pasta, 'crls.pem'), 32 * 1024 * 1024),
    ]);
    if (cadeia === undefined) {
      try { cadeia = await arquivoPublico(join(pasta, 'cadeias.pem'), 2 * 1024 * 1024); }
      catch (erro) { if (!(erro instanceof Error) || !('code' in erro) || erro.code !== 'ENOENT') throw erro; }
    }
    for (const pem of blocosPublicos(raizes, 'CERTIFICATE')) {
      const raiz = new X509Certificate(pem);
      if (!raiz.ca || !raiz.checkIssued(raiz) || !raiz.verify(raiz.publicKey)) throw new Error('raiz_invalida');
    }
    blocosPublicos(crls, 'X509 CRL');
  } catch {
    recusarNfse('nfse_confianca_indisponivel', 'A plataforma precisa atualizar a confiança dos certificados fiscais.', 503);
  }

  // Somente material público é escrito aqui. PFX, senha e chave privada nunca
  // entram em arquivo, argumento, variável do subprocesso ou mensagem de erro.
  const pasta = await mkdtemp(join(tmpdir(), 'nfse-confianca-'));
  try {
    await Promise.all([
      writeFile(join(pasta, 'raizes.pem'), raizes, { mode: 0o600 }),
      writeFile(join(pasta, 'crls.pem'), crls, { mode: 0o600 }),
      writeFile(join(pasta, 'folha.pem'), certificadoPem, { mode: 0o600 }),
      writeFile(join(pasta, 'cadeia.pem'), cadeia || certificadoPem, { mode: 0o600 }),
    ]);
    // OpenSSL valida caminho, restrições de CA, uso de chave, validade e CRL
    // de cada nível. Sem fontes padrão nem download de URLs vindas do PFX.
    await executar('/usr/bin/openssl', ['verify', '-no-CAfile', '-no-CApath', '-no-CAstore',
      '-trusted', join(pasta, 'raizes.pem'), '-untrusted', join(pasta, 'cadeia.pem'),
      '-CRLfile', join(pasta, 'crls.pem'), '-crl_check_all', '-x509_strict',
      '-purpose', finalidade, '-auth_level', '2', '-verify_depth', '16',
      '-attime', String(Math.floor(agora.getTime() / 1000)), join(pasta, 'folha.pem')],
    { timeout: 5000, maxBuffer: 64 * 1024, env: { LANG: 'C' } });
    return { rootsSha256: createHash('sha256').update(raizes).digest('hex'),
      crlsSha256: createHash('sha256').update(crls).digest('hex') };
  } catch {
    recusarNfse('nfse_certificado_sem_confianca', 'Não foi possível validar o A1. Confira a cadeia do certificado e a atualização das listas de revogação.', 400);
  } finally { await rm(pasta, { recursive: true, force: true }); }
}

/** Wrapper do A1 mantém a finalidade TLS e nunca escreve sua chave privada. */
export async function validarConfiancaA1(certificado: CertificadoA1, agora = new Date()): Promise<void> {
  await validarCadeiaFiscal(certificado.certificadoPem, certificado.cadeiaPem, agora, 'sslclient');
}
