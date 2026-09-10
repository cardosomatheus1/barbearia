import { ID_DPS_NFSE, idPedidoCancelamentoValido } from './identificadores.js';
import { SignedXml } from 'xml-crypto';
import type { CertificadoA1 } from './certificado.js';
import { conferirXmlFiscal } from './xml-seguro.js';

export const NAMESPACE_NFSE = 'http://www.sped.fazenda.gov.br/nfse';
/**
 * Estrutura adaptada de xml-signer.ts do Raiz. Algoritmo é obrigatório no
 * contrato: a regra da NF-e não pode se tornar padrão silencioso para NFS-e.
 */
export function assinarDps(xml: string, certificado: CertificadoA1, id: string,
  algoritmo: 'sha1' | 'sha256'): string {
  if (!ID_DPS_NFSE.test(id)) throw new Error('nfse_id_dps_invalido');
  return assinarElemento(xml, certificado, id, algoritmo, 'DPS', 'infDPS');
}

export function assinarPedidoDeCancelamento(xml: string, certificado: CertificadoA1, id: string,
  algoritmo: 'sha1' | 'sha256'): string {
  if (!idPedidoCancelamentoValido(id)) throw new Error('nfse_id_evento_invalido');
  return assinarElemento(xml, certificado, id, algoritmo, 'pedRegEvento', 'infPedReg');
}

function assinarElemento(xml: string, certificado: CertificadoA1, id: string,
  algoritmo: 'sha1' | 'sha256', raiz: string, elemento: string): string {
  conferirXmlFiscal(xml);
  if (algoritmo !== 'sha1' && algoritmo !== 'sha256') throw new Error('nfse_algoritmo_invalido');
  const referencia = `/*[local-name()='${raiz}' and namespace-uri()='${NAMESPACE_NFSE}']/*[local-name()='${elemento}' and namespace-uri()='${NAMESPACE_NFSE}' and @Id='${id}']`;
  const c14n = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
  const assinatura = new SignedXml({
    privateKey: certificado.chavePem, publicCert: certificado.certificadoPem,
    canonicalizationAlgorithm: c14n,
    signatureAlgorithm: algoritmo === 'sha1' ? 'http://www.w3.org/2000/09/xmldsig#rsa-sha1' : 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  });
  assinatura.addReference({ xpath: referencia,
    digestAlgorithm: algoritmo === 'sha1' ? 'http://www.w3.org/2000/09/xmldsig#sha1' : 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', c14n] });
  assinatura.computeSignature(xml, { location: { reference: referencia, action: 'after' } });
  const resultado = assinatura.getSignedXml();
  const verifier = new SignedXml({ publicCert: certificado.certificadoPem });
  verifier.loadSignature(assinatura.getSignatureXml());
  if (!verifier.checkSignature(resultado) || verifier.getSignedReferences().length !== 1) {
    throw new Error('nfse_assinatura_invalida');
  }
  return resultado;
}
