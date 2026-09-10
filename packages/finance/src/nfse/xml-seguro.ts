import { XMLParser } from 'fast-xml-parser';
import { gunzipSync, gzipSync } from 'node:zlib';

// Adaptado de sefaz-client/xml/xml-security.ts do ERP Raiz (ebc59f0).
// NFS-e não precisa de DTD. Rejeitar antes de qualquer parser ou assinatura.
export const LIMITE_XML_NFSE = 2 * 1024 * 1024;
export function conferirXmlFiscal(xml: string): void {
  if (!xml || Buffer.byteLength(xml) > LIMITE_XML_NFSE || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error('nfse_xml_invalido');
  }
}

export function lerXmlFiscal(xml: string): unknown {
  conferirXmlFiscal(xml);
  return new XMLParser({ ignoreAttributes: false, processEntities: false, htmlEntities: false,
    parseTagValue: false, parseAttributeValue: false, removeNSPrefix: true }).parse(xml);
}

export function compactarXmlFiscal(xml: string): string {
  conferirXmlFiscal(xml);
  return gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
}

export function descompactarXmlFiscal(base64: string): string {
  if (base64.length > 2 * LIMITE_XML_NFSE || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error('nfse_resposta_invalida');
  }
  let xml: string;
  try { xml = gunzipSync(Buffer.from(base64, 'base64'), { maxOutputLength: LIMITE_XML_NFSE }).toString('utf8'); }
  catch { throw new Error('nfse_resposta_invalida'); }
  conferirXmlFiscal(xml);
  return xml;
}
