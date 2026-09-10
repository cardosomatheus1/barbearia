import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignedXml } from 'xml-crypto';
import { certificadoNfseSintetico, nfseSintetica, eventoNfseSintetico, CHAVE_TESTE_NFSE, CNPJ_TESTE_NFSE } from '../../test/nfse-fixtures.js';
import { gerarDps } from './dps.js';
import { assinarDps, assinarPedidoDeCancelamento } from './assinatura.js';
import { gerarPedidoDeCancelamento } from './cancelamento.js';
import { compactarXmlFiscal } from './xml-seguro.js';
import { lerNotaAutorizada, lerCancelamentoConfirmado } from './respostas.js';
import { certificadosDasAutoridades, autoridadesFiscaisDisponiveis, verificarAssinaturaDaResposta } from './assinatura-resposta.js';

let autoridade: ReturnType<typeof certificadoNfseSintetico>;
let intruso: ReturnType<typeof certificadoNfseSintetico>;
let dps: string;
let nota: string;
let evento: string;

function lerNota(xml: string) {
  return lerNotaAutorizada({ chaveAcesso: CHAVE_TESTE_NFSE, nfseXmlGZipB64: compactarXmlFiscal(xml) }, dps);
}
function lerEvento(xml: string) {
  return lerCancelamentoConfirmado({ eventoXmlGZipB64: compactarXmlFiscal(xml) }, CHAVE_TESTE_NFSE, 'homologacao');
}
function adulterarUltimoValor(xml: string, tag: string): string {
  const posicao = xml.lastIndexOf(`<${tag}>`) + tag.length + 2;
  if (posicao < tag.length + 2) throw new Error('A fixture precisa conter o campo a adulterar');
  return xml.slice(0, posicao) + (xml[posicao] === 'A' ? 'B' : 'A') + xml.slice(posicao + 1);
}

beforeAll(() => {
  autoridade = certificadoNfseSintetico(); intruso = certificadoNfseSintetico();
  const gerada = gerarDps({ ambiente: 'homologacao', cnpj: CNPJ_TESTE_NFSE,
    municipioEmissor: '3550308', municipioPrestacao: '3550308', regime: 'mei', serie: 1,
    numero: '1', emitidaEm: new Date('2026-09-10T01:00:00Z'), competencia: '2026-09-09',
    codigoNacional: '060101', descricao: 'Corte sintetico', servicoCents: 5000 });
  dps = assinarDps(gerada.xml, autoridade.certificado, gerada.id, 'sha1');
  nota = nfseSintetica(dps, autoridade.certificado);
  const pedido = gerarPedidoDeCancelamento({ ambiente: 'homologacao', cnpj: CNPJ_TESTE_NFSE,
    chave: CHAVE_TESTE_NFSE, motivo: 'Servico nao foi prestado ao cliente', quando: new Date('2026-09-10T01:00:00Z') });
  evento = eventoNfseSintetico(assinarPedidoDeCancelamento(pedido.xml, autoridade.certificado, pedido.id, 'sha1'), autoridade.certificado);
});
beforeEach(() => vi.stubEnv('FISCAL_AUTORIDADES_PEM_B64', Buffer.from(autoridade.certificado.certificadoPem).toString('base64')));
afterEach(() => vi.unstubAllEnvs());

describe('autenticidade das respostas fiscais antes de autorizar ou cancelar', () => {
  it('aceita nota e evento assinados pelo certificado autorizado fora da resposta', () => {
    expect(lerNota(nota).numero).toBe('12'); expect(lerEvento(evento)).toContain('e101101');
  });
  it('recusa numero de nota adulterado mesmo com XSD, chave e DPS corretos', () => {
    expect(() => lerNota(nota.replace('<nNFSe>12</nNFSe>', '<nNFSe>13</nNFSe>'))).toThrow();
  });
  it('recusa a assinatura externa corrompida sem confundi-la com a assinatura interna da DPS', () => {
    expect(() => lerNota(adulterarUltimoValor(nota, 'SignatureValue'))).toThrow();
  });
  it('recusa digest corrompido da autoridade', () => {
    expect(() => lerNota(adulterarUltimoValor(nota, 'DigestValue'))).toThrow();
  });
  it('certificado embutido por um terceiro nao concede autoridade para emitir nota', () => {
    expect(() => lerNota(nfseSintetica(dps, intruso.certificado))).toThrow();
  });
  it('ausencia da configuracao de autoridades nao confia no certificado da resposta', () => {
    vi.stubEnv('FISCAL_AUTORIDADES_PEM_B64', ''); expect(() => lerNota(nota)).toThrow();
  });
  it('configuracao ilegivel de autoridades falha fechada', () => {
    vi.stubEnv('FISCAL_AUTORIDADES_PEM_B64', 'nao-e-um-certificado'); expect(() => lerNota(nota)).toThrow();
  });
  it('certificado expirado nao valida resposta nem informa prontidao', () => {
    const futuro = new Date('2041-01-01T00:00:00Z');
    expect(autoridadesFiscaisDisponiveis(futuro)).toBe(false);
    expect(() => certificadosDasAutoridades(futuro)).toThrow();
    expect(() => verificarAssinaturaDaResposta(nota, 'NFSe', futuro)).toThrow();
  });
  it('troca de certificados permite sobreposicao e retirar um certificado tem efeito imediato', () => {
    const catalogo = autoridade.certificado.certificadoPem + intruso.certificado.certificadoPem;
    vi.stubEnv('FISCAL_AUTORIDADES_PEM_B64', Buffer.from(catalogo).toString('base64'));
    expect(lerNota(nota).numero).toBe('12');
    expect(lerNota(nfseSintetica(dps, intruso.certificado)).numero).toBe('12');
    vi.stubEnv('FISCAL_AUTORIDADES_PEM_B64', Buffer.from(intruso.certificado.certificadoPem).toString('base64'));
    expect(() => lerNota(nota)).toThrow();
  });
  it('catalogo publico nao aceita uma chave privada junto dos certificados', () => {
    vi.stubEnv('FISCAL_AUTORIDADES_PEM_B64', Buffer.from(autoridade.certificado.certificadoPem + autoridade.certificado.chavePem).toString('base64'));
    expect(autoridadesFiscaisDisponiveis()).toBe(false);
  });
  it('cancelamento com aplicacao adulterada nao confirma o evento', () => {
    expect(() => lerEvento(evento.replace('<verAplic>Teste_1.0</verAplic>', '<verAplic>Intruso_1.0</verAplic>'))).toThrow();
  });
  it('assinatura valida de um fragmento interno nao autentica a nota inteira', () => {
    const inicio = nota.lastIndexOf('<Signature '); const fim = nota.indexOf('</Signature>', inicio) + '</Signature>'.length;
    expect(inicio).toBeGreaterThan(0);
    const semAssinaturaExterna = nota.slice(0, inicio) + nota.slice(fim);
    const c14n = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
    const s = new SignedXml({ privateKey: autoridade.certificado.chavePem, publicCert: autoridade.certificado.certificadoPem,
      canonicalizationAlgorithm: c14n, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' });
    s.addReference({ xpath: "//*[local-name()='infDPS']", digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', c14n] });
    s.computeSignature(semAssinaturaExterna);
    expect(() => lerNota(s.getSignedXml())).toThrow();
  });
});
