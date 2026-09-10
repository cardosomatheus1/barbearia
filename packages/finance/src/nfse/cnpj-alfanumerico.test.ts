import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { certificadoNfseSintetico, nfseSintetica, eventoNfseSintetico, CHAVE_TESTE_NFSE, CNPJ_TESTE_NFSE } from '../../test/nfse-fixtures.js';
import { lerCertificadoA1 } from './certificado.js';
import { gerarDps } from './dps.js';
import { assinarDps, assinarPedidoDeCancelamento } from './assinatura.js';
import { gerarPedidoDeCancelamento } from './cancelamento.js';
import { gerarDanfse } from './danfse.js';
import { lerNotaAutorizada, lerCancelamentoConfirmado } from './respostas.js';
import { compactarXmlFiscal } from './xml-seguro.js';
import { CHAVE_NFSE, ID_DPS_NFSE, caminhoNfsePermitido } from './identificadores.js';
import { httpNfse } from './transporte.js';

const cnpj = '12ABC34501DE35'; // Exemplo do manual de DV publicado pela RFB.
const chave = CHAVE_TESTE_NFSE.replace(CNPJ_TESTE_NFSE, cnpj);
let cred: ReturnType<typeof certificadoNfseSintetico>;
let dps: string; let xml: string; let id: string;
beforeAll(() => {
  cred = certificadoNfseSintetico(cnpj);
  const d = gerarDps({ ambiente: 'homologacao', cnpj, municipioEmissor: '3550308', municipioPrestacao: '3550308',
    regime: 'mei', serie: 1, numero: '1', emitidaEm: new Date('2026-09-10T01:00:00Z'), competencia: '2026-09-09',
    codigoNacional: '060101', descricao: 'Corte sintetico', servicoCents: 5000,
    tomador: { nome: 'Tomador sintetico', documento: cnpj } });
  id = d.id; dps = assinarDps(d.xml, cred.certificado, id, 'sha1');
  xml = nfseSintetica(dps, cred.certificado, chave);
});
beforeEach(() => vi.stubEnv('FISCAL_AUTORIDADES_PEM_B64', Buffer.from(cred.certificado.certificadoPem).toString('base64')));
afterEach(() => vi.unstubAllEnvs());

describe('CNPJ alfanumérico no contrato nacional de julho/2026', () => {
  it('preserva CNPJ no certificado, DPS e resposta assinada', () => {
    expect(cred.certificado.cnpj).toBe(cnpj);
    expect(() => lerCertificadoA1(cred.pfx, cred.senha, CNPJ_TESTE_NFSE)).toThrow('certificado_cnpj_divergente');
    expect(dps.match(new RegExp(`<CNPJ>${cnpj}</CNPJ>`, 'g'))).toHaveLength(2);
    expect(ID_DPS_NFSE.test(id)).toBe(true);
    expect(lerNotaAutorizada({ chaveAcesso: chave, nfseXmlGZipB64: compactarXmlFiscal(xml) }, dps))
      .toMatchObject({ chave, numero: '12' });
  });
  it('valida pedido e evento de cancelamento sem perder letras da chave', () => {
    const p = gerarPedidoDeCancelamento({ ambiente: 'homologacao', cnpj, chave,
      motivo: 'Servico nao foi prestado ao cliente', quando: new Date('2026-09-10T01:00:00Z') });
    const pedido = assinarPedidoDeCancelamento(p.xml, cred.certificado, p.id, 'sha1');
    const evento = eventoNfseSintetico(pedido, cred.certificado, chave);
    expect(lerCancelamentoConfirmado({ eventoXmlGZipB64: compactarXmlFiscal(evento) }, chave, 'homologacao')).toBe(evento);
  });
  it('imprime CNPJ com máscara e preserva a chave no link de consulta do DANFSe', async () => {
    const pdf = await gerarDanfse(xml, chave, { arialNegrito: 'Helvetica-Bold', arialRegular: 'Helvetica', conteudo: 'Helvetica' });
    const doc = await getDocument({ data: Uint8Array.from(pdf), useSystemFonts: true }).promise;
    try {
      const page = await doc.getPage(1);
      const texto = (await page.getTextContent()).items.map(i => 'str' in i ? i.str : '').join(' ');
      expect(texto).toContain('12.ABC.345/01DE-35'); expect(texto).toContain(chave);
      expect((await page.getAnnotations()).some(a => a.url === `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${chave}`)).toBe(true);
    } finally { await doc.destroy(); }
  });
  it('permite somente letras na inscrição CNPJ, mantendo a barreira de destinos e caminhos', async () => {
    for (const path of [`/dps/${id}`, `/nfse/${chave}`, `/nfse/${chave}/eventos`, `/nfse/${chave}/eventos/101101/1`]) {
      expect(caminhoNfsePermitido(path)).toBe(true);
    }
    const enviar = vi.fn();
    const trocar = (pos: number, valor = 'A') => chave.slice(0, pos) + valor + chave.slice(pos + 1);
    for (const invalida of [trocar(0), trocar(7), trocar(8), trocar(8, '1'), trocar(21), trocar(22), trocar(23), trocar(49), chave.toLowerCase()]) {
      expect(CHAVE_NFSE.test(invalida)).toBe(false);
      await expect(httpNfse({ ambiente: 'homologacao', certificado: cred.certificado, metodo: 'GET', caminho: `/nfse/${invalida}` }, enviar))
        .rejects.toMatchObject({ code: 'nfse_destino_invalido' });
    }
    for (const sufixo of ['?url=//outro.host', '/../../segredo', '/eventos/101101/1/extra', '%2fsegredo']) {
      expect(caminhoNfsePermitido(`/nfse/${chave}${sufixo}`)).toBe(false);
    }
    expect(enviar).not.toHaveBeenCalled();
  });
});
