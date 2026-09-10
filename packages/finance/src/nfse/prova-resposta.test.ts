import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { confiancaA1Sintetica } from '../../test/nfse-confianca-fixture.js';
import { nfseSintetica, CHAVE_TESTE_NFSE } from '../../test/nfse-fixtures.js';
import { gerarDps } from './dps.js';
import { assinarDps } from './assinatura.js';
import { autenticarRespostaAtual, verificarRespostaArquivada } from './prova-resposta.js';
import { gerarDanfse } from './danfse.js';

let pki: ReturnType<typeof confiancaA1Sintetica>; let xml: string;
const agora = new Date('2026-09-10T12:00:00Z');
const contexto = 'tenant:unidade:nota:validacao_nfse';
describe('validação atual e reprodução histórica da resposta fiscal', () => {
  beforeAll(() => {
    pki = confiancaA1Sintetica();
    const d = gerarDps({ ambiente: 'homologacao', cnpj: pki.certificado.cnpj, municipioEmissor: '3550308', municipioPrestacao: '3550308',
      regime: 'mei', serie: 1, numero: '1', emitidaEm: agora, competencia: '2026-09-10', codigoNacional: '060101', descricao: 'Corte sintetico', servicoCents: 5000 });
    xml = nfseSintetica(assinarDps(d.xml, pki.certificado, d.id, 'sha1'), pki.certificado);
  });
  afterAll(() => pki?.limpar());
  beforeEach(() => {
    vi.stubEnv('FISCAL_CONFIANCA_DIR', pki.pasta);
    vi.stubEnv('FISCAL_AUTORIDADES_PEM_B64', Buffer.from(pki.certificado.certificadoPem).toString('base64'));
    vi.stubEnv('FISCAL_SECRET_KEY', Buffer.alloc(32, 19).toString('base64')); pki.atualizarCrls();
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
  it('recusa assinante revogado mesmo que sua assinatura e pin confiram', async () => {
    pki.atualizarCrls({ revogarFolha: true });
    await expect(autenticarRespostaAtual(xml, 'NFSe', contexto, agora)).rejects.toMatchObject({ code: 'nfse_autoridade_sem_confianca' });
  });
  it('recusa resposta nova sem CRL, com intermediária revogada ou fora da validade', async () => {
    for (const opcoes of [{ semRaiz: true }, { revogarIntermediaria: true }, { vencida: true }]) {
      pki.atualizarCrls(opcoes);
      await expect(autenticarRespostaAtual(xml, 'NFSe', contexto, agora)).rejects.toMatchObject({ code: 'nfse_autoridade_sem_confianca' });
    }
    await expect(autenticarRespostaAtual(xml, 'NFSe', contexto, new Date('2041-01-01'))).rejects.toThrow();
  });
  it('reproduz prova anterior depois de expiração/rotação e gera PDF sem catálogo atual', async () => {
    const prova = await autenticarRespostaAtual(xml, 'NFSe', contexto, agora);
    expect(prova.envelope).not.toContain('BEGIN CERTIFICATE');
    vi.stubEnv('FISCAL_AUTORIDADES_PEM_B64', ''); vi.stubEnv('FISCAL_CONFIANCA_DIR', '');
    const futuro = new Date('2041-01-01');
    expect(verificarRespostaArquivada(xml, 'NFSe', prova, futuro)).toContain('infNFSe');
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(futuro);
    const pdf = await gerarDanfse(xml, CHAVE_TESTE_NFSE,
      { arialNegrito: 'Helvetica-Bold', arialRegular: 'Helvetica', conteudo: 'Helvetica' }, true, prova);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    await expect(gerarDanfse(xml, CHAVE_TESTE_NFSE,
      { arialNegrito: 'Helvetica-Bold', arialRegular: 'Helvetica', conteudo: 'Helvetica' })).rejects.toThrow();
  });
  it('não transplanta prova entre documentos, unidades ou tipos e recusa XML alterado', async () => {
    const prova = await autenticarRespostaAtual(xml, 'NFSe', contexto, agora);
    for (const contextoErrado of ['tenant:outra-unidade:nota:validacao_nfse', 'tenant:unidade:outra-nota:validacao_nfse']) {
      expect(() => verificarRespostaArquivada(xml, 'NFSe', { ...prova, contexto: contextoErrado }, agora)).toThrow();
    }
    expect(() => verificarRespostaArquivada(xml.replace('Corte sintetico', 'Outro servico'), 'NFSe', prova, agora)).toThrow();
    expect(() => verificarRespostaArquivada(xml, 'evento', prova, agora)).toThrow();
    expect(() => verificarRespostaArquivada(xml, 'NFSe', { ...prova, envelope: prova.envelope + 'a' }, agora)).toThrow();
    expect(() => verificarRespostaArquivada(xml, 'NFSe', prova, new Date('2026-09-09'))).toThrow();
  });
});
