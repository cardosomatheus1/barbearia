import { beforeAll, describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { gzipSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';
import { lerCertificadoA1 } from './certificado.js';
import { assinarDps, NAMESPACE_NFSE } from './assinatura.js';
import { compactarXmlFiscal, descompactarXmlFiscal, lerXmlFiscal, LIMITE_XML_NFSE } from './xml-seguro.js';

const CNPJ = '12345678000195';
const AGORA = new Date('2026-09-09T12:00:00Z');
const SENHA = 'senha-de-certificado-sintetico';
let key: forge.pki.rsa.KeyPair;
let outra: forge.pki.rsa.KeyPair;
function cert(par: forge.pki.rsa.KeyPair, cnpj = CNPJ, ca = false) {
  const c = forge.pki.createCertificate();
  c.publicKey = par.publicKey;
  c.serialNumber = ca ? '02' : '01';
  c.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  c.validity.notAfter = new Date('2027-01-01T00:00:00Z');
  c.setSubject([{ name: 'commonName', value: 'Certificado sintetico' }]); c.setIssuer(c.subject.attributes);
  const a = forge.asn1;
  const san = a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
    a.create(a.Class.CONTEXT_SPECIFIC, 0, true, [
      a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer('2.16.76.1.3.3').getBytes()),
      a.create(a.Class.CONTEXT_SPECIFIC, 0, true, [a.create(a.Class.UNIVERSAL, a.Type.UTF8, false, cnpj)]),
    ]),
  ]);
  c.setExtensions([{ name: 'basicConstraints', cA: ca }, { id: '2.5.29.17', value: a.toDer(san).getBytes() }]);
  c.sign(par.privateKey, forge.md.sha256.create());
  return c;
}
function pfx(certificados: forge.pki.Certificate[], chave = key.privateKey) {
  const asn = forge.pkcs12.toPkcs12Asn1(chave, certificados, SENHA, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(asn).getBytes(), 'binary');
}

describe('infraestrutura própria de NFS-e adaptada do Raiz', () => {
  beforeAll(() => { key = forge.pki.rsa.generateKeyPair(2048); outra = forge.pki.rsa.generateKeyPair(2048); });
  it('seleciona a folha correspondente à chave mesmo quando a CA aparece primeiro', () => {
    const lido = lerCertificadoA1(pfx([cert(outra, CNPJ, true), cert(key)]), SENHA, CNPJ, AGORA);
    expect(lido.cnpj).toBe(CNPJ);
    expect(lido.validoAte.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
  it('recusa senha errada, chave incompatível, CNPJ de outra empresa e validade futura/expirada', () => {
    const arquivo = pfx([cert(key)]);
    expect(() => lerCertificadoA1(arquivo, 'incorreta', CNPJ, AGORA)).toThrow('certificado_arquivo_ou_senha_invalido');
    expect(() => lerCertificadoA1(pfx([cert(outra)]), SENHA, CNPJ, AGORA)).toThrow('certificado_folha_ambigua_ou_incompativel');
    expect(() => lerCertificadoA1(arquivo, SENHA, '99999999000191', AGORA)).toThrow('certificado_cnpj_divergente');
    expect(() => lerCertificadoA1(arquivo, SENHA, CNPJ, new Date('2025-01-01'))).toThrow('certificado_fora_da_validade');
    expect(() => lerCertificadoA1(arquivo, SENHA, CNPJ, new Date('2027-01-01'))).toThrow('certificado_fora_da_validade');
  });
  it('apresenta somente a folha e a intermediária que a assinou, sem incluir a raiz', () => {
    const raiz = cert(outra, CNPJ, true);
    raiz.setSubject([{ name: 'commonName', value: 'Raiz sintetica' }]); raiz.setIssuer(raiz.subject.attributes);
    raiz.sign(outra.privateKey, forge.md.sha256.create());
    const intermediaria = cert(outra, CNPJ, true);
    intermediaria.setSubject([{ name: 'commonName', value: 'Intermediaria sintetica' }]);
    intermediaria.setIssuer(raiz.subject.attributes); intermediaria.sign(outra.privateKey, forge.md.sha256.create());
    const folha = cert(key); folha.setIssuer(intermediaria.subject.attributes); folha.sign(outra.privateKey, forge.md.sha256.create());
    const lido = lerCertificadoA1(pfx([raiz, folha, intermediaria]), SENHA, CNPJ, AGORA);
    expect(lido.cadeiaPem).toBe(forge.pki.certificateToPem(folha)+forge.pki.certificateToPem(intermediaria));
    expect(lido.certificadoPem).toBe(forge.pki.certificateToPem(folha));
    // Mesmo nome de emissora não basta: uma CA que não assinou a folha não entra.
    intermediaria.publicKey = key.publicKey; intermediaria.sign(outra.privateKey, forge.md.sha256.create());
    expect(lerCertificadoA1(pfx([raiz, folha, intermediaria]), SENHA, CNPJ, AGORA).cadeiaPem).toBe(lido.certificadoPem);
  });
  it('assinatura cobre exatamente a DPS e a alteração posterior do valor é detectada', () => {
    const certificado = lerCertificadoA1(pfx([cert(key)]), SENHA, CNPJ, AGORA);
    const id = `DPS355030821234567800019500001000000000000001`;
    const xml = `<DPS xmlns="${NAMESPACE_NFSE}" versao="1.01"><infDPS Id="${id}"><valor>100.00</valor></infDPS></DPS>`;
    const assinado = assinarDps(xml, certificado, id, 'sha256');
    const assinatura = assinado.match(/<Signature[\s\S]*?<\/Signature>/)![0];
    const verificar = (s: string) => {
      const v = new SignedXml({ publicCert: certificado.certificadoPem }); v.loadSignature(assinatura); return v.checkSignature(s);
    };
    expect(verificar(assinado)).toBe(true);
    expect(verificar(assinado.replace('100.00', '900.00'))).toBe(false);
    expect(() => assinarDps(xml, certificado, "DPS' or 1=1", 'sha256')).toThrow('nfse_id_dps_invalido');
  });
  it('recusa entidades externas antes do parser e limita também XML descomprimido', () => {
    expect(() => lerXmlFiscal('<!DOCTYPE a [<!ENTITY b SYSTEM "file:///etc/passwd">]><a>&b;</a>')).toThrow('nfse_xml_invalido');
    const bomba = gzipSync(Buffer.alloc(LIMITE_XML_NFSE + 1, 65)).toString('base64');
    expect(() => descompactarXmlFiscal(bomba)).toThrow('nfse_resposta_invalida');
    expect(() => descompactarXmlFiscal('qualquer coisa')).toThrow('nfse_resposta_invalida');
    const xml = '<NFSe><numero>0000123</numero></NFSe>';
    expect(descompactarXmlFiscal(compactarXmlFiscal(xml))).toBe(xml);
    expect(lerXmlFiscal(xml)).toEqual({ NFSe: { numero: '0000123' } });
  });
});
