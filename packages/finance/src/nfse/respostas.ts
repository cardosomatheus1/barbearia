import { idNotaNfseValido } from './identificadores.js';
import { isDeepStrictEqual } from 'node:util';
import { registro } from './transporte.js';
import { descompactarXmlFiscal, lerXmlFiscal } from './xml-seguro.js';
import { validarSchemaNfse } from './schema.js';
import { NfseError } from './erros.js';
import { verificarAssinaturaDaResposta } from './assinatura-resposta.js';
import { respostaIbsCbsConfere } from './ibscbs-resposta.js';

function respostaInvalida(): never {
  throw new NfseError('nfse_resposta_divergente', 'A resposta fiscal não corresponde ao documento enviado.', 502);
}

export function lerNotaAutorizada(dados: unknown, dpsXml: string, chaveEsperada?: string): { xml: string; chave: string; numero: string } {
  const r = registro(dados);
  if (typeof r['nfseXmlGZipB64'] !== 'string') return respostaInvalida();
  const xml = descompactarXmlFiscal(r['nfseXmlGZipB64']);
  validarSchemaNfse(xml, 'NFSe');
  const assinado = verificarAssinaturaDaResposta(xml, 'NFSe');
  const nfse = registro(registro(lerXmlFiscal(xml))['NFSe']);
  const inf = registro(registro(lerXmlFiscal(assinado))['infNFSe']);
  const dps = registro(registro(inf['DPS'])['infDPS']);
  const esperado = registro(registro(registro(lerXmlFiscal(dpsXml))['DPS'])['infDPS']);
  const id = inf['@_Id']; const numero = inf['nNFSe'];
  if (nfse['@_versao'] !== '1.01' || typeof id !== 'string' || !idNotaNfseValido(id) ||
    typeof numero !== 'string' || !/^\d{1,13}$/.test(numero) || inf['cStat'] !== '100' ||
    !isDeepStrictEqual(dps, esperado) || !respostaIbsCbsConfere(inf, esperado) || (r['chaveAcesso'] !== undefined && r['chaveAcesso'] !== id.slice(3)) ||
    (chaveEsperada !== undefined && id.slice(3) !== chaveEsperada)) return respostaInvalida();
  return { xml, chave: id.slice(3), numero };
}

export function lerCancelamentoConfirmado(dados: unknown, chave: string, ambiente: 'producao' | 'homologacao'): string {
  const base64 = registro(dados)['eventoXmlGZipB64'];
  if (typeof base64 !== 'string') return respostaInvalida();
  const xml = descompactarXmlFiscal(base64);
  validarSchemaNfse(xml, 'evento');
  const assinado = verificarAssinaturaDaResposta(xml, 'evento');
  const inf = registro(registro(lerXmlFiscal(assinado))['infEvento']);
  const pedido = registro(registro(inf['pedRegEvento'])['infPedReg']);
  if (inf['@_Id'] !== `EVT${chave}101101001` || pedido['@_Id'] !== `PRE${chave}101101` ||
    pedido['chNFSe'] !== chave || pedido['tpAmb'] !== (ambiente === 'producao' ? '1' : '2') ||
    !Object.hasOwn(pedido, 'e101101')) return respostaInvalida();
  return xml;
}
