import { chamar } from './core';

export interface ConfiguracaoMunicipalNaTela {
  ambiente: 'homologacao' | 'producao'; serie: string; numeroInicial: number; serieExclusiva: true; itemListaServico: string; codigoMunicipal: string;
  codigoCancelamento: string; cnae: string | null; nbs: string | null;
  razaoSocial: string; layoutSaoPaulo: 1 | 2; habilitada: boolean;
  enderecoPrestador: { logradouro: string; numero: string; bairro: string; cep: string;
    municipio: number; nomeMunicipio: string; uf: string; complemento?: string | null };
}
export interface SituacaoMunicipalNaTela {
  configuracao: ConfiguracaoMunicipalNaTela | null;
  municipio: { codigo: number; nome: string; uf: string; padrao: string; homologacao: boolean; producao: boolean } | null;
  emissor: string; temCredenciais: boolean; pronta: boolean; motivo: string | null;
}
export const situacaoMunicipalNaApi = (token: string) => chamar<SituacaoMunicipalNaTela>('GET', '/v1/admin/fiscal/municipal', undefined, token);
export const salvarMunicipalNaApi = (token: string, body: { config: ConfiguracaoMunicipalNaTela;
  credenciais?: { usuario: string | null; senha: string | null; token: string | null } }) =>
  chamar<{ ok: true }>('PUT', '/v1/admin/fiscal/municipal/configuracao', body, token);
