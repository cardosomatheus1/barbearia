import forge from 'node-forge';
import { create } from 'xmlbuilder2';
import { SignedXml } from 'xml-crypto';
import { lerCertificadoA1, type CertificadoA1 } from '../src/nfse/certificado.js';
import { NAMESPACE_NFSE } from '../src/nfse/assinatura.js';
import { validarSchemaNfse } from '../src/nfse/schema.js';

export const CNPJ_TESTE_NFSE = '12345678000195';
export const CHAVE_TESTE_NFSE = '35503082212345678000195000000000000126090000000000';

export function certificadoNfseSintetico(cnpj = CNPJ_TESTE_NFSE) {
  const par = forge.pki.rsa.generateKeyPair(2048); const c = forge.pki.createCertificate();
  c.publicKey = par.publicKey; c.serialNumber = '01';
  c.validity.notBefore = new Date('2020-01-01T00:00:00Z'); c.validity.notAfter = new Date('2040-01-01T00:00:00Z');
  c.setSubject([{ name: 'commonName', value: 'Certificado sintetico sem valor fiscal' }]); c.setIssuer(c.subject.attributes);
  const a = forge.asn1;
  const san = a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [a.create(a.Class.CONTEXT_SPECIFIC, 0, true, [
    a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer('2.16.76.1.3.3').getBytes()),
    a.create(a.Class.CONTEXT_SPECIFIC, 0, true, [a.create(a.Class.UNIVERSAL, a.Type.UTF8, false, cnpj)]),
  ])]);
  c.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { id: '2.5.29.17', value: a.toDer(san).getBytes() }]);
  c.sign(par.privateKey, forge.md.sha256.create());
  const senha = 'senha-sintetica-sem-valor';
  const pfx = Buffer.from(a.toDer(forge.pkcs12.toPkcs12Asn1(par.privateKey, [c], senha, { algorithm: '3des' })).getBytes(), 'binary');
  return { pfx, senha, certificado: lerCertificadoA1(pfx, senha, cnpj, new Date('2026-09-10T01:00:00Z')) };
}

function assinarResposta(xml: string, cert: CertificadoA1, elemento: string): string {
  const c14n = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
  const s = new SignedXml({ privateKey: cert.chavePem, publicCert: cert.certificadoPem,
    canonicalizationAlgorithm: c14n, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' });
  s.addReference({ xpath: `//*[local-name()='${elemento}']`, digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', c14n] });
  s.computeSignature(xml); return s.getSignedXml();
}

export function nfseSintetica(dps: string, cert: CertificadoA1, chave = CHAVE_TESTE_NFSE): string {
  const doc = create({ version: '1.0' }).ele('NFSe', { xmlns: NAMESPACE_NFSE, versao: '1.01' });
  const inf = doc.ele('infNFSe', { Id: `NFS${chave}` });
  inf.ele('xLocEmi').txt('Municipio sintetico'); inf.ele('xLocPrestacao').txt('Municipio sintetico'); inf.ele('nNFSe').txt('12');
  inf.ele('xTribNac').txt('Servicos de barbearia'); inf.ele('verAplic').txt('Teste_1.0');
  inf.ele('ambGer').txt('2'); inf.ele('tpEmis').txt('1'); inf.ele('cStat').txt('100');
  inf.ele('dhProc').txt('2026-09-10T01:00:00+00:00'); inf.ele('nDFSe').txt('1');
  const emit = inf.ele('emit'); emit.ele('CNPJ').txt(cert.cnpj); emit.ele('xNome').txt('Barbearia sintetica');
  const end = emit.ele('enderNac'); end.ele('xLgr').txt('Rua sintetica'); end.ele('nro').txt('1');
  end.ele('xBairro').txt('Centro'); end.ele('cMun').txt('3550308'); end.ele('UF').txt('SP'); end.ele('CEP').txt('01001000');
  inf.ele('valores').ele('vLiq').txt('50.00'); inf.import(create(dps).root());
  const xml = assinarResposta(doc.end({ prettyPrint: false }), cert, 'infNFSe');
  validarSchemaNfse(xml, 'NFSe'); return xml;
}

export function eventoNfseSintetico(pedido: string, cert: CertificadoA1, chave = CHAVE_TESTE_NFSE): string {
  const doc = create({ version: '1.0' }).ele('evento', { xmlns: NAMESPACE_NFSE, versao: '1.01' });
  const inf = doc.ele('infEvento', { Id: `EVT${chave}101101001` });
  inf.ele('verAplic').txt('Teste_1.0'); inf.ele('ambGer').txt('2'); inf.ele('nSeqEvento').txt('1');
  inf.ele('dhProc').txt('2026-09-10T01:00:00+00:00'); inf.ele('nDFSe').txt('2'); inf.import(create(pedido).root());
  const xml = assinarResposta(doc.end({ prettyPrint: false }), cert, 'infEvento');
  validarSchemaNfse(xml, 'evento'); return xml;
}
