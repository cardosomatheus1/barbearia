import { chamar } from './core';

export interface ConfiguracaoNfseNaTela {
  ambiente: 'homologacao' | 'producao'; serie: number; codigoNacional: string;
  codigoMunicipal: string | null; nbs: string | null; aliquotaTotalSimplesBps: number | null; habilitada: boolean;
}
export interface SituacaoNfseNaTela {
  modo: 'nenhum' | 'fake' | 'nacional'; configuracao: ConfiguracaoNfseNaTela | null;
  certificado: { validoAte: string; correspondeAoCnpj: boolean } | null;
  pronta: boolean; motivo: string | null;
}
export const situacaoNfseNaApi = (token: string) => chamar<SituacaoNfseNaTela>('GET', '/v1/admin/fiscal/nacional', undefined, token);
export const salvarNfseNaApi = (token: string, config: ConfiguracaoNfseNaTela) =>
  chamar<{ ok: true }>('PUT', '/v1/admin/fiscal/nacional/configuracao', config, token);
export const certificadoNfseNaApi = (token: string, arquivo: string, senha: string) =>
  chamar<{ ok: true }>('POST', '/v1/admin/fiscal/nacional/certificado', { arquivo, senha }, token);
export const removerCertificadoNfseNaApi = (token: string) =>
  chamar<{ ok: true }>('DELETE', '/v1/admin/fiscal/nacional/certificado', undefined, token);
export const xmlNfseNaApi = (token: string, id: string) =>
  chamar<{ xml: string }>('GET', `/v1/admin/fiscal/nacional/notas/${id}/xml`, undefined, token);
export const pdfNfseNaApi = (token: string, id: string) =>
  chamar<{ arquivo: string }>('GET', `/v1/admin/fiscal/nacional/notas/${id}/pdf`, undefined, token);
export const documentoFiscalPeloLinkNaApi = (token: string) =>
  chamar<{ arquivo: string }>('POST', '/v1/fiscal/documento', { token });
