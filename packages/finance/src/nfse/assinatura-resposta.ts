import { idNotaNfseValido, idCancelamentoValido } from './identificadores.js';
import { X509Certificate } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { NAMESPACE_NFSE } from './assinatura.js';
import { conferirXmlFiscal } from './xml-seguro.js';
import { NfseError } from './erros.js';

const DS = 'http://www.w3.org/2000/09/xmldsig#';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const EXCLUSIVE_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const SIGNATURES = new Set([`${DS}rsa-sha1`, 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256']);
const DIGESTS = new Set([`${DS}sha1`, 'http://www.w3.org/2001/04/xmlenc#sha256']);

function recusarAssinatura(): never {
  throw new NfseError('nfse_assinatura_resposta_invalida', 'Não foi possível confirmar a assinatura da autoridade fiscal.', 502);
}
function recusarConfiguracao(): never {
  throw new NfseError('nfse_autoridades_nao_configuradas', 'A emissão fiscal ainda precisa ser habilitada pela plataforma.', 503);
}

/**
 * Confiança explícita no certificado da autoridade, obtido fora da resposta.
 * Não aceita a cadeia apresentada pelo emitente como raiz confiável. O catálogo
 * pode conter certificados de transição; remoção passa a valer na próxima leitura.
 * Esta pinagem não substitui validação de cadeia ICP-Brasil/revogação do A1.
 */
export function certificadosDasAutoridades(agora = new Date()): readonly X509Certificate[] {
  const valor = process.env['FISCAL_AUTORIDADES_PEM_B64'];
  if (!valor || valor.length > 128 * 1024 || !Number.isFinite(agora.getTime())) return recusarConfiguracao();
  try {
    const bytes = Buffer.from(valor, 'base64');
    if (bytes.toString('base64') !== valor) return recusarConfiguracao();
    const texto = bytes.toString('utf8');
    const blocos = texto.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    if (blocos.length === 0 || blocos.length > 32 || texto.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) {
      return recusarConfiguracao();
    }
    const certificados = blocos.map(pem => new X509Certificate(pem));
    if (certificados.some(c => c.ca || c.publicKey.asymmetricKeyType !== 'rsa' ||
      (c.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)) return recusarConfiguracao();
    const validos = certificados.filter(c => agora >= new Date(c.validFrom) && agora < new Date(c.validTo));
    if (!validos.length) return recusarConfiguracao();
    return validos;
  } catch { return recusarConfiguracao(); }
}

export function autoridadesFiscaisDisponiveis(agora = new Date()): boolean {
  try { certificadosDasAutoridades(agora); return true; } catch { return false; }
}

function filhos(no: Element, nome: string, namespace: string): Element[] {
  return Array.from(no.childNodes).filter((n): n is Element =>
    n.nodeType === 1 && (n as Element).localName === nome && (n as Element).namespaceURI === namespace);
}
function unico(no: Element, nome: string, namespace = DS): Element {
  const encontrados = filhos(no, nome, namespace);
  if (encontrados.length !== 1) return recusarAssinatura();
  return encontrados[0]!;
}

/** Devolve somente o fragmento cuja assinatura foi verificada criptograficamente. */
export function verificarAssinaturaDaResposta(xml: string, tipo: 'NFSe' | 'evento', agora = new Date()): string {
  return verificarComAutoridades(xml, tipo, certificadosDasAutoridades(agora)).fragmento;
}

/** Verificação criptográfica; a confiança/validade das chaves é do chamador. */
export function verificarComAutoridades(xml: string, tipo: 'NFSe' | 'evento', autoridades: readonly X509Certificate[]) {
  try {
    conferirXmlFiscal(xml);
    const doc = new DOMParser({ errorHandler: {
      warning: () => recusarAssinatura(), error: () => recusarAssinatura(), fatalError: () => recusarAssinatura(),
    } }).parseFromString(xml, 'application/xml');
    const raiz = doc.documentElement;
    if (raiz.localName !== tipo || raiz.namespaceURI !== NAMESPACE_NFSE) return recusarAssinatura();
    const conteudo = unico(raiz, tipo === 'NFSe' ? 'infNFSe' : 'infEvento', NAMESPACE_NFSE);
    const id = conteudo.getAttribute('Id');
    if (!id || !(tipo === 'NFSe' ? idNotaNfseValido(id) : idCancelamentoValido(id))) return recusarAssinatura();
    // A assinatura da DPS/pedido é interna e não autentica a resposta da autoridade.
    const assinatura = unico(raiz, 'Signature');
    const ids = new Set<string>();
    for (const elemento of Array.from(doc.getElementsByTagName('*'))) {
      for (const a of Array.from(elemento.attributes)) {
        if (a.localName.toLowerCase() !== 'id') continue;
        if (!a.value || ids.has(a.value)) return recusarAssinatura();
        ids.add(a.value);
      }
    }
    const signedInfo = unico(assinatura, 'SignedInfo');
    if (!SIGNATURES.has(unico(signedInfo, 'SignatureMethod').getAttribute('Algorithm') ?? '') ||
      ![C14N, EXCLUSIVE_C14N].includes(unico(signedInfo, 'CanonicalizationMethod').getAttribute('Algorithm') ?? '')) {
      return recusarAssinatura();
    }
    const ref = unico(signedInfo, 'Reference');
    if (ref.getAttribute('URI') !== `#${id}` || !DIGESTS.has(unico(ref, 'DigestMethod').getAttribute('Algorithm') ?? '')) return recusarAssinatura();
    const transforms = filhos(unico(ref, 'Transforms'), 'Transform', DS).map(t => t.getAttribute('Algorithm'));
    if (transforms.length !== 2 || transforms[0] !== `${DS}enveloped-signature` ||
      ![C14N, EXCLUSIVE_C14N].includes(transforms[1] ?? '')) return recusarAssinatura();
    const keyInfo = unico(assinatura, 'KeyInfo');
    const x509 = unico(keyInfo, 'X509Data');
    const apresentados = filhos(x509, 'X509Certificate', DS);
    if (!apresentados.length || apresentados.length > 16) return recusarAssinatura();
    const fingerprints = new Set(apresentados.map(n => {
      const base64 = (n.textContent ?? '').replace(/\s/g, '');
      const der = Buffer.from(base64, 'base64');
      if (!base64 || der.toString('base64') !== base64 || der.length > 16 * 1024) return recusarAssinatura();
      return new X509Certificate(der).fingerprint256;
    }));
    for (const autoridade of autoridades.filter(c => fingerprints.has(c.fingerprint256))) {
      // Desabilitar a seleção automática é obrigatório: a chave vem do catálogo,
      // nunca de um certificado arbitrário fornecido dentro do XML recebido.
      const verifier = new SignedXml({ publicCert: autoridade.toString(), getCertFromKeyInfo: () => null });
      verifier.loadSignature(assinatura);
      if (!verifier.checkSignature(xml)) continue;
      const referencias = verifier.getSignedReferences();
      if (referencias.length !== 1 || verifier.getReferences()[0]?.uri !== `#${id}`) return recusarAssinatura();
      return { fragmento: referencias[0]!, assinante: autoridade };
    }
    return recusarAssinatura();
  } catch { return recusarAssinatura(); }
}
