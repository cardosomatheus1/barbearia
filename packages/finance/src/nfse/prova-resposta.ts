import { createHash, X509Certificate } from 'node:crypto';
import { certificadosDasAutoridades, verificarComAutoridades } from './assinatura-resposta.js';
import { validarCadeiaFiscal } from './confianca-a1.js';
import { cifrarFiscal, decifrarFiscal } from './cofre.js';
import { NfseError } from './erros.js';

interface ProvaResposta {
  version: 1; tipo: 'NFSe' | 'evento'; xmlSha256: string; verifiedAt: string;
  certificatePem: string; certificateSha256: string; rootsSha256: string; crlsSha256: string;
}
export interface ProvaArquivada { readonly envelope: string; readonly contexto: string }
const hash = (valor: string | Buffer) => createHash('sha256').update(valor).digest('hex');

/** Não iniciar uma operação sem ao menos um assinante autorizado e válido. */
export async function exigirAutoridadeFiscalDisponivel(agora = new Date()): Promise<void> {
  for (const cert of certificadosDasAutoridades(agora)) {
    try { await validarCadeiaFiscal(cert.toString(), undefined, agora, 'any'); return; }
    catch { /* Um catálogo pode conter assinantes de transição já revogados. */ }
  }
  throw new NfseError('nfse_autoridade_sem_confianca', 'A plataforma precisa atualizar a confiança dos assinantes fiscais.', 503);
}

/** Recebimento novo exige pin independente, cadeia e revogação atuais. */
export async function autenticarRespostaAtual(xml: string, tipo: 'NFSe' | 'evento', contexto: string, agora = new Date()): Promise<ProvaArquivada> {
  const { assinante } = verificarComAutoridades(xml, tipo, certificadosDasAutoridades(agora));
  let catalogo;
  try { catalogo = await validarCadeiaFiscal(assinante.toString(), undefined, agora, 'any'); }
  catch { throw new NfseError('nfse_autoridade_sem_confianca', 'Não foi possível validar a cadeia e a revogação do assinante fiscal. A resposta será consultada novamente.', 503); }
  const prova: ProvaResposta = { version: 1, tipo, xmlSha256: hash(xml), verifiedAt: agora.toISOString(),
    certificatePem: assinante.toString(), certificateSha256: hash(assinante.raw), ...catalogo };
  return { envelope: cifrarFiscal(JSON.stringify(prova), contexto), contexto };
}

/**
 * Reproduz a verificação registrada no recebimento. A prova é cifrada/autenticada
 * e vinculada à unidade/nota/tipo. Não presume validade atual do certificado e
 * não é um carimbo do tempo ICP-Brasil nem prova legal de validação de longo prazo.
 */
export function verificarRespostaArquivada(xml: string, tipo: 'NFSe' | 'evento', prova: ProvaArquivada, agora = new Date()): string {
  try {
    const p = JSON.parse(decifrarFiscal(prova.envelope, prova.contexto)) as ProvaResposta;
    const quando = new Date(p.verifiedAt);
    if (p.version !== 1 || p.tipo !== tipo || p.xmlSha256 !== hash(xml) || !Number.isFinite(quando.getTime()) ||
      quando > agora || !/^[a-f0-9]{64}$/.test(p.rootsSha256) || !/^[a-f0-9]{64}$/.test(p.crlsSha256)) throw new Error('prova_invalida');
    const cert = new X509Certificate(p.certificatePem);
    if (cert.ca || hash(cert.raw) !== p.certificateSha256 || quando < new Date(cert.validFrom) || quando >= new Date(cert.validTo)) throw new Error('assinante_invalido');
    return verificarComAutoridades(xml, tipo, [cert]).fragmento;
  } catch { throw new NfseError('nfse_prova_historica_invalida', 'Não foi possível conferir o registro de validação deste documento fiscal.', 503); }
}
