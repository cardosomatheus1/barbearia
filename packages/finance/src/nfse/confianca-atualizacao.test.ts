import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readlink, rm, writeFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { confiancaA1Sintetica } from '../../test/nfse-confianca-fixture.js';
import { validarConfiancaA1 } from './confianca-a1.js';

// Exercita o utilitário operacional real com download substituído. Nenhuma
// conexão sai para uma CA. Certificados, CRLs e OpenSSL não são simulados.
const { atualizarConfianca, validarManifesto } = await import(new URL('../../../../scripts/fiscal-confianca-atualizar.mjs', import.meta.url).href);
const { enderecoPublico, urlDaFonte } = await import(new URL('../../../../scripts/fiscal-confianca-download.mjs', import.meta.url).href);
let pki: ReturnType<typeof confiancaA1Sintetica>; let destino: string;
const agora = new Date('2026-09-10T12:00:00Z');
type Manifesto = { version: number; cas: { id: string; sha256: string; root: boolean; url: string }[]; crls: { issuer: string; url: string }[] };
let manifesto: Manifesto;
const baixar = async (url: string) => readFile(join(pki.pasta, new URL(url).pathname.slice(1)));
const atualizar = (m = manifesto, download = baixar) => atualizarConfianca(m, destino, { baixar: download, agora });
describe('renovação atômica da confiança fiscal', () => {
  beforeAll(async () => {
    pki = confiancaA1Sintetica();
    const { X509Certificate } = await import('node:crypto');
    manifesto = { version: 1, cas: [], crls: [] };
    for (const id of ['raiz', 'intermediaria']) {
      const c = new X509Certificate(await readFile(join(pki.pasta, `${id}.pem`)));
      manifesto.cas.push({ id, sha256: createHash('sha256').update(c.raw).digest('hex'), root: id === 'raiz', url: `https://fiscal.example.invalid/${id}.pem` });
      manifesto.crls.push({ issuer: id, url: `https://fiscal.example.invalid/${id}.crl` });
    }
  });
  afterAll(() => pki?.limpar());
  beforeEach(async () => { destino = await mkdtemp(join(tmpdir(), 'nfse-updater-')); pki.atualizarCrls(); vi.stubEnv('FISCAL_CONFIANCA_DIR', destino); });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(destino, { recursive: true, force: true }); });
  it('publica somente material público verificado e o validador usa a mesma geração', async () => {
    expect(await atualizar()).toMatchObject({ status: 'atualizado', authorities: 2 });
    await expect(validarConfiancaA1(pki.certificado, agora)).resolves.toBeUndefined();
    const atual = await readlink(join(destino, 'current'));
    const arquivos = await readdir(join(destino, atual));
    for (const arquivo of arquivos) expect((await readFile(join(destino, atual, arquivo), 'utf8'))).not.toContain('PRIVATE KEY');
    expect(await atualizar()).toMatchObject({ status: 'sem_alteracao' });
    expect(await readlink(join(destino, 'current'))).toBe(atual);
    expect((await readdir(destino)).filter(f => f.startsWith('geracao-'))).toHaveLength(1);
  });
  it('fonte indisponível, pin trocado ou CRL adulterada preservam a geração anterior', async () => {
    await atualizar(); const anterior = await readlink(join(destino, 'current'));
    await expect(atualizar(manifesto, async () => { throw new Error('timeout'); })).rejects.toThrow();
    await expect(atualizar({ ...manifesto, cas: manifesto.cas.map(c => ({ ...c, sha256: '0'.repeat(64) })) })).rejects.toThrow('ca_sem_confianca');
    const crl = await readFile(join(pki.pasta, 'intermediaria.crl'), 'utf8');
    await writeFile(join(pki.pasta, 'intermediaria.crl'), crl.replace(/([A-Za-z0-9+/])=*(\r?\n-----END X509 CRL-----)/,
      (_t, c: string, fim: string) => `${c === 'A' ? 'B' : 'A'}${fim}`));
    await expect(atualizar()).rejects.toThrow();
    expect(await readlink(join(destino, 'current'))).toBe(anterior);
    await expect(validarConfiancaA1(pki.certificado, agora)).resolves.toBeUndefined();
  });
  it.each([{ vencida: true }, { futura: true }, { revogarIntermediaria: true }])('recusa catálogo inválido %j sem publicar', async opcoes => {
    pki.atualizarCrls(opcoes); await expect(atualizar()).rejects.toThrow();
    await expect(readlink(join(destino, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('aceita nova revogação da folha e impede voltar a uma CRL anterior ainda vigente', async () => {
    await atualizar(); const velha = await readFile(join(pki.pasta, 'intermediaria.crl'));
    pki.atualizarCrls({ revogarFolha: true, emitidaEm: '20260910110000Z' });
    await atualizar(); const revogada = await readlink(join(destino, 'current'));
    await expect(validarConfiancaA1(pki.certificado, agora)).rejects.toMatchObject({ code: 'nfse_certificado_sem_confianca' });
    await writeFile(join(pki.pasta, 'intermediaria.crl'), velha);
    await expect(atualizar()).rejects.toThrow('crl_retrocedeu');
    expect(await readlink(join(destino, 'current'))).toBe(revogada);
  });
  it('não usa arquivos antigos quando o apontador da geração está quebrado', async () => {
    await writeFile(join(destino, 'raizes.pem'), pki.raizPem);
    await writeFile(join(destino, 'crls.pem'), await readFile(join(pki.pasta, 'crls.pem')));
    await symlink('geracao-inexistente', join(destino, 'current'));
    await expect(validarConfiancaA1(pki.certificado, agora)).rejects.toMatchObject({ code: 'nfse_confianca_indisponivel' });
  });
  it('duas renovações concorrentes não publicam versões fora de ordem', async () => {
    let liberar!: () => void; let entrou!: () => void;
    const gate = new Promise<void>(r => { liberar = r; }); const iniciou = new Promise<void>(r => { entrou = r; });
    const primeira = atualizar(manifesto, async url => { entrou(); await gate; return baixar(url); });
    try {
      await iniciou; await expect(atualizar()).rejects.toThrow('atualizacao_em_curso');
    } finally { liberar(); }
    await expect(primeira).resolves.toMatchObject({ status: 'atualizado' });
  });
  it('morte do atualizador não deixa lock órfão', async () => {
    const modulo = new URL('../../../../scripts/fiscal-confianca-lock.mjs', import.meta.url).href;
    const lock = join(destino, '.atualizando.lock');
    const programa = `const { reservarAtualizacao } = await import(${JSON.stringify(modulo)});
      await reservarAtualizacao(${JSON.stringify(lock)}); console.log('pronto'); setInterval(() => {}, 1000);`;
    const filho = spawn(process.execPath, ['--input-type=module', '-e', programa], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(filho.stdout, 'data');
      const terminou = once(filho, 'close'); filho.kill('SIGKILL'); await terminou;
      // A espera é pelo lock efetivo, sem assumir tempo de escalonamento do cat.
      await promisify(execFile)('/usr/bin/flock', ['--wait', '2', lock, '/bin/true']);
      expect(await atualizar()).toMatchObject({ status: 'atualizado' });
    } finally { filho.kill(); }
  });
  it('healthcheck exige verificação recente e margem de validade', async () => {
    const script = new URL('../../../../scripts/fiscal-confianca-atualizar.mjs', import.meta.url).pathname;
    const executar = promisify(execFile);
    const health = () => executar(process.execPath, [script, '--health', destino]);
    await expect(health()).rejects.toThrow();
    const status = { checkedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 7200_000).toISOString() };
    await writeFile(join(destino, 'ultima-verificacao.json'), JSON.stringify(status));
    await expect(health()).resolves.toMatchObject({ stdout: '' });
    await writeFile(join(destino, 'ultima-verificacao.json'), JSON.stringify({ ...status, checkedAt: new Date(Date.now() - 7200_000).toISOString() }));
    await expect(health()).rejects.toThrow();
    await writeFile(join(destino, 'ultima-verificacao.json'), JSON.stringify({ ...status, validUntil: new Date().toISOString() }));
    await expect(health()).rejects.toThrow();
  });
  it('manifesto exige todos os emissores e fontes não alcançam serviços locais', () => {
    expect(() => validarManifesto({ ...manifesto, crls: manifesto.crls.slice(1) })).toThrow('crl_ausente');
    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fd00::1',
      '2001:0:1:1::1', '2001:0000:1:1::1', '2002:7f00:1::1', '2001:db8::1', '3fff::1']) {
      expect(enderecoPublico(ip)).toBe(false);
    }
    for (const url of ['http://ca.example.invalid/cert', 'https://127.0.0.1/crl', 'https://ca.example.invalid:8080/crl', 'https://u:p@ca.example.invalid/crl']) {
      expect(() => urlDaFonte(url)).toThrow();
    }
    expect(urlDaFonte('http://ca.example.invalid/lista.crl', true).protocol).toBe('http:');
    expect(enderecoPublico('1.1.1.1')).toBe(true); expect(enderecoPublico('2001:4860:4860::8888')).toBe(true);
  });
});
