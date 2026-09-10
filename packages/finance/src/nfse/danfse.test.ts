import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { certificadoNfseSintetico, nfseSintetica, CHAVE_TESTE_NFSE } from '../../test/nfse-fixtures.js';
import { gerarDps } from './dps.js';
import { assinarDps } from './assinatura.js';
import { gerarDanfse } from './danfse.js';
import { localidade, somarValores, valorFiscal, dataFiscal, tributosAproximadosDanfse } from './danfse-campos.js';
import { fontesDanfse, type FontesDanfse } from './danfse-fontes.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// As fontes padrão são somente para a prova sintética. Produção exige os TTF
// licenciados da NT008; a ausência não provoca substituição silenciosa.
const fontes: FontesDanfse = { arialNegrito: 'Helvetica-Bold', arialRegular: 'Helvetica', conteudo: 'Helvetica' };
let cred: ReturnType<typeof certificadoNfseSintetico>;
let xml: string;
beforeAll(() => {
  cred = certificadoNfseSintetico();
  const d = gerarDps({ ambiente: 'homologacao', cnpj: cred.certificado.cnpj, municipioEmissor: '3550308', municipioPrestacao: '3550308',
    serie: 1, numero: '1', emitidaEm: new Date('2026-09-10T01:00:00Z'), competencia: '2026-09-09', regime: 'normal',
    codigoNacional: '060101', nbs: '126021000', perfilIbsCbs: 'regular_presencial',
    tributosAproximadosBps: { federal: 1345, estadual: 0, municipal: 500 },
    descricao: 'Corte e barba — serviço sintético com acentuação.', servicoCents: 5000,
    tomador: { nome: 'Cliente do atendimento', documento: '52998224725' } });
  xml = nfseSintetica(assinarDps(d.xml, cred.certificado, d.id, 'sha1'), cred.certificado);
});
beforeEach(() => vi.stubEnv('FISCAL_AUTORIDADES_PEM_B64', Buffer.from(cred.certificado.certificadoPem).toString('base64')));
afterEach(() => vi.unstubAllEnvs());

describe('DANFSe próprio a partir da nota assinada', () => {
  it('gera PDF de uma página sem rede, identifica homologação e preserva dados e totais', async () => {
    const pdf = await gerarDanfse(xml, CHAVE_TESTE_NFSE, fontes);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/Count 1');
    expect(pdf.length).toBeLessThan(5 * 1024 * 1024);
    const documento = await getDocument({ data: Uint8Array.from(pdf), useSystemFonts: true }).promise;
    try {
      expect(documento.numPages).toBe(1);
      const pagina = await documento.getPage(1);
      const texto = (await pagina.getTextContent()).items.map(i => 'str' in i ? i.str : '').join(' ');
      for (const trecho of ['DANFSe v2.0', 'Documento Auxiliar da NFS-e', 'NFS-e SEM VALIDADE JURÍDICA', CHAVE_TESTE_NFSE, 'Cliente do atendimento',
        '529.982.247-25', '000 / 000001', '030101 / 3550308', '13,45%', 'R$ 50,00', 'R$ 0,45', 'INFORMAÇÕES COMPLEMENTARES']) {
        expect(texto).toContain(trecho);
      }
      const links = await pagina.getAnnotations();
      expect(links.some(a => a.url === `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${CHAVE_TESTE_NFSE}`)).toBe(true);
    } finally { await documento.destroy(); }
  });
  it('impressão interna de nota cancelada contém a marca de cancelamento', async () => {
    const pdf = await gerarDanfse(xml, CHAVE_TESTE_NFSE, fontes, true);
    const documento = await getDocument({ data: Uint8Array.from(pdf), useSystemFonts: true }).promise;
    try {
      const texto = (await (await documento.getPage(1)).getTextContent()).items.map(i => 'str' in i ? i.str : '').join(' ');
      expect(texto).toContain('CANCELADA'); expect(documento.numPages).toBe(1);
    } finally { await documento.destroy(); }
  });
  it('recusa assinatura adulterada, chave trocada e configuração ausente', async () => {
    await expect(gerarDanfse(xml.replace('Cliente do atendimento', 'Nome adulterado'), CHAVE_TESTE_NFSE, fontes)).rejects.toThrow();
    await expect(gerarDanfse(xml, '9'.repeat(50), fontes)).rejects.toMatchObject({ code: 'nfse_pdf_documento_invalido' });
    vi.stubEnv('FISCAL_DANFSE_FONTES_DIR', '');
    expect(() => fontesDanfse()).toThrow('fontes');
    vi.stubEnv('FISCAL_DANFSE_FONTES_DIR', 'relativo');
    expect(() => fontesDanfse()).toThrow('fontes');
  });
  it('formata valores sem perda de precisão e consulta municípios fora das capitais', () => {
    expect(somarValores('9999999999999.99', '0.01')).toBe('10000000000000.00');
    expect(valorFiscal('10000000000000.00')).toBe('R$ 10.000.000.000.000,00');
    expect(localidade('3500105')).toBe('Adamantina / SP');
    expect(localidade('2927408')).toBe('Salvador / BA');
    expect(localidade('3550308')).toBe('São Paulo / SP');
    expect(dataFiscal('2026-09-09T23:30:00-03:00')).toBe('09/09/2026 23:30:00');
    expect(tributosAproximadosDanfse({ valores: { trib: { totTrib: { pTotTrib: {
      pTotTribFed: '13.45', pTotTribEst: '0.00', pTotTribMun: '5.00' } } } } }))
      .toContain('Federais: 13,45%; Estaduais: 0,00%; Municipais: 5,00%');
  });
});
