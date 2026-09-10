import forge from 'node-forge';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { certificadoNfseSintetico } from './nfse-fixtures.js';
import { lerCertificadoA1 } from '../src/nfse/certificado.js';

/** PKI efêmera para verificar OpenSSL real; não é material ICP-Brasil. */
export function confiancaA1Sintetica(senha = ' senha sintetica com espacos ', cnpj?: string, nome = 'sintetica') {
  const pasta = mkdtempSync(join(tmpdir(), 'nfse-pki-teste-'));
  const original = certificadoNfseSintetico(cnpj);
  const chaveRaiz = forge.pki.rsa.generateKeyPair(2048);
  const chaveIntermediaria = forge.pki.rsa.generateKeyPair(2048);
  function ca(nome: string, serial: string, par: forge.pki.rsa.KeyPair, emissora?: forge.pki.Certificate) {
    const c = forge.pki.createCertificate(); c.publicKey = par.publicKey; c.serialNumber = serial;
    c.validity.notBefore = new Date('2020-01-01'); c.validity.notAfter = new Date('2040-01-01');
    c.setSubject([{ name: 'commonName', value: nome }]); c.setIssuer((emissora ?? c).subject.attributes);
    c.setExtensions([{ name: 'basicConstraints', critical: true, cA: true, pathLenConstraint: emissora ? 0 : 1 },
      { name: 'keyUsage', critical: true, keyCertSign: true, cRLSign: true },
      { name: 'subjectKeyIdentifier' },
      { name: 'authorityKeyIdentifier', keyIdentifier: (emissora ?? c).generateSubjectKeyIdentifier().getBytes() }]);
    c.sign(chaveRaiz.privateKey, forge.md.sha256.create()); return c;
  }
  const raiz = ca(`Raiz ${nome}`,  '03', chaveRaiz);
  const intermediaria = ca(`Intermediaria ${nome}`,  '02', chaveIntermediaria, raiz);
  const folha = forge.pki.certificateFromPem(original.certificado.certificadoPem);
  folha.setIssuer(intermediaria.subject.attributes);
  folha.setExtensions([...folha.extensions,
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: intermediaria.generateSubjectKeyIdentifier().getBytes() }]);
  folha.sign(chaveIntermediaria.privateKey, forge.md.sha256.create());
  const chave = forge.pki.privateKeyFromPem(original.certificado.chavePem);
  const pfx = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(chave, [folha, intermediaria, raiz], senha,
    { algorithm: '3des' })).getBytes(), 'binary');
  const certificado = lerCertificadoA1(pfx, senha, original.certificado.cnpj, new Date('2026-09-10'));
  const raizPem = forge.pki.certificateToPem(raiz);
  writeFileSync(join(pasta, 'raizes.pem'), raizPem);
  writeFileSync(join(pasta, 'cadeias.pem'), forge.pki.certificateToPem(intermediaria));
  for (const [nome, cert, key] of [['raiz', raiz, chaveRaiz.privateKey], ['intermediaria', intermediaria, chaveIntermediaria.privateKey]] as const) {
    writeFileSync(join(pasta, `${nome}.pem`), forge.pki.certificateToPem(cert));
    writeFileSync(join(pasta, `${nome}.key`), forge.pki.privateKeyToPem(key), { mode: 0o600 });
    writeFileSync(join(pasta, `${nome}.cnf`), `[ca]\ndefault_ca=CA\n[CA]\ndatabase=${nome}.index\nprivate_key=${nome}.key\ncertificate=${nome}.pem\ndefault_md=sha256\ndefault_crl_days=30\n`);
  }
  function atualizarCrls(opcoes: { revogarFolha?: boolean; revogarIntermediaria?: boolean; vencida?: boolean; futura?: boolean; semRaiz?: boolean; emitidaEm?: string } = {}) {
    const crls: string[] = [];
    for (const nome of ['raiz', 'intermediaria']) {
      const revogar = nome === 'raiz' ? opcoes.revogarIntermediaria : opcoes.revogarFolha;
      writeFileSync(join(pasta, `${nome}.index`), revogar ? `R\t400101000000Z\t260101000000Z\t${nome === 'raiz' ? '02' : '01'}\tunknown\t/CN=Sintetico\n` : '');
      execFileSync('openssl', ['ca', '-gencrl', '-config', `${nome}.cnf`, '-crl_lastupdate', opcoes.futura ? '20300101000000Z' : opcoes.emitidaEm ?? '20200101000000Z',
        '-crl_nextupdate', opcoes.vencida ? '20250101000000Z' : '20400101000000Z', '-out', `${nome}.crl`], { cwd: pasta, stdio: 'pipe' });
      if (nome !== 'raiz' || !opcoes.semRaiz) crls.push(readFileSync(join(pasta, `${nome}.crl`), 'utf8'));
    }
    writeFileSync(join(pasta, 'crls.pem'), crls.join(''));
  }
  atualizarCrls();
  return { pasta, pfx, senha, certificado, raizPem, atualizarCrls, limpar: () => rmSync(pasta, { recursive: true, force: true }) };
}
