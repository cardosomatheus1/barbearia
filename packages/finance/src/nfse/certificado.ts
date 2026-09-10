import { CNPJ_NORMALIZADO } from '@barbearia/core';
import forge from 'node-forge';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';

/** Adaptado do certificate-reader do ERP Raiz (ebc59f0), com seleção da chave/folha. */
export interface CertificadoA1 {
  readonly cnpj: string;
  readonly certificadoPem: string;
  /** Folha e intermediárias do PFX em ordem de emissão, para apresentação mTLS. */
  readonly cadeiaPem: string;
  readonly chavePem: string;
  readonly validoDesde: Date;
  readonly validoAte: Date;
  readonly fingerprint: string;
}

function cnpjIcpBrasil(cert: forge.pki.Certificate): string {
  // GeneralNames -> otherName [0] -> OID + value [0]. Não extrair quaisquer
  // dígitos do SAN: o otherName de CPF também carrega data e identificadores.
  const ext = cert.extensions.find(e => e.id === '2.5.29.17');
  if (!ext || typeof ext.value !== 'string') return '';
  const san = forge.asn1.fromDer(ext.value);
  if (!Array.isArray(san.value)) return '';
  for (const name of san.value) {
    if (typeof name === 'string' || name.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || name.type !== 0 ||
      !Array.isArray(name.value)) continue;
    const oid = name.value[0]; const wrapper = name.value[1];
    if (!oid || typeof oid === 'string' || oid.type !== forge.asn1.Type.OID || typeof oid.value !== 'string' ||
      forge.asn1.derToOid(oid.value) !== '2.16.76.1.3.3' || !wrapper || typeof wrapper === 'string' ||
      !Array.isArray(wrapper.value)) continue;
    const value = wrapper.value[0];
    if (value && typeof value !== 'string' && typeof value.value === 'string' && CNPJ_NORMALIZADO.test(value.value)) {
      return value.value;
    }
  }
  return '';
}

/**
 * Lê material local. O cadastro e cada uso ainda exigem validarConfiancaA1;
 * montar uma cadeia não prova confiança nem ausência de revogação.
 */
export function lerCertificadoA1(pfx: Buffer, senha: string, cnpjEsperado: string, agora = new Date()): CertificadoA1 {
  if (pfx.length === 0 || pfx.length > 512 * 1024 || senha.length > 1024 || !CNPJ_NORMALIZADO.test(cnpjEsperado) || !Number.isFinite(agora.getTime())) {
    throw new Error('certificado_entrada_invalida');
  }
  let p12: forge.pkcs12.Pkcs12Pfx;
  try { p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(pfx.toString('binary')), false, senha); }
  catch { throw new Error('certificado_arquivo_ou_senha_invalido'); }
  const keyOid = '1.2.840.113549.1.12.10.1.2';
  const certOid = '1.2.840.113549.1.12.10.1.3';
  const bags = p12.getBags({ bagType: keyOid });
  const chaves = bags[keyOid] ?? [];
  if (chaves.length !== 1 || !chaves[0]?.key) throw new Error('certificado_chave_ambigua_ou_ausente');
  const chavePem = forge.pki.privateKeyToPem(chaves[0].key);
  const chave = createPrivateKey(chavePem);
  if (chave.asymmetricKeyType !== 'rsa' || (chave.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error('certificado_chave_rsa_invalida');
  }
  const pub = createPublicKey(chave).export({ type: 'spki', format: 'der' });
  const certificados = p12.getBags({ bagType: certOid })[certOid] ?? [];
  const material = certificados.flatMap(b => {
    if (!b.cert) return [];
    const pem = forge.pki.certificateToPem(b.cert);
    const x509 = new X509Certificate(pem);
    return [{ cert: b.cert, pem, x509 }];
  });
  const folhas = material.filter(c => !c.x509.ca && c.x509.publicKey.export({ type: 'spki', format: 'der' }).equals(pub));
  if (folhas.length !== 1) throw new Error('certificado_folha_ambigua_ou_incompativel');
  const folha = folhas[0]!;
  const uso = folha.cert.extensions.find(e => e.id === '2.5.29.15');
  // RN da DPS exige X.509 v3, assinatura digital e não repúdio. A finalidade
  // sslclient do OpenSSL, sozinha, também aceita folhas sem esses usos fiscais.
  if (folha.cert.version !== 2 || uso?.digitalSignature !== true || uso.nonRepudiation !== true) {
    throw new Error('certificado_padrao_assinatura_invalido');
  }
  const cnpj = cnpjIcpBrasil(folha.cert);
  if (cnpj !== cnpjEsperado) throw new Error('certificado_cnpj_divergente');
  const validoDesde = folha.cert.validity.notBefore;
  const validoAte = folha.cert.validity.notAfter;
  if (agora < validoDesde || agora >= validoAte) throw new Error('certificado_fora_da_validade');
  // O servidor precisa das intermediárias para chegar à sua própria raiz de
  // confiança. Montar a cadeia do PFX não declara confiança ICP-Brasil nem CRL.
  const cadeia = [folha.pem]; const vistos = new Set([folha.x509.fingerprint256]);
  let atual = folha;
  while (!(atual.x509.checkIssued(atual.x509) && atual.x509.verify(atual.x509.publicKey))) {
    const candidatas = material.filter(c => c.x509.ca && !vistos.has(c.x509.fingerprint256) &&
      atual.x509.checkIssued(c.x509) && atual.x509.verify(c.x509.publicKey));
    if (candidatas.length === 0) break;
    if (candidatas.length !== 1 || vistos.size >= 16) throw new Error('certificado_cadeia_ambigua');
    const emissora = candidatas[0]!;
    if (agora < emissora.cert.validity.notBefore || agora >= emissora.cert.validity.notAfter) {
      throw new Error('certificado_cadeia_fora_da_validade');
    }
    vistos.add(emissora.x509.fingerprint256);
    if (emissora.x509.checkIssued(emissora.x509) && emissora.x509.verify(emissora.x509.publicKey)) break;
    cadeia.push(emissora.pem); atual = emissora;
  }
  return { cnpj, certificadoPem: folha.pem, cadeiaPem: cadeia.join(''), chavePem, validoDesde, validoAte, fingerprint: folha.x509.fingerprint256 };
}
