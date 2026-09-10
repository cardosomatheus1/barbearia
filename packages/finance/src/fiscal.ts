/**
 * Fachada pública do domínio fiscal.
 *
 * A implementação fica separada por responsabilidade para que configuração,
 * emissão, persistência/consulta e entrega ao cliente evoluam sem recriar o
 * antigo hotspot monolítico.
 */

export * from './fiscal-emissor.js';
export { FiscalError } from './fiscal-erros.js';
export type { FiscalRepoFailure } from './fiscal-erros.js';
export * from './fiscal-configuracao.js';
export * from './fiscal-notas.js';
export * from './fiscal-emissao.js';
export * from './fiscal-entrega.js';

export { chaveDaNota } from '@barbearia/core';
export { NfseError } from './nfse/erros.js';
export { situacaoNfse, salvarConfiguracaoNfse, salvarCertificadoNfse, removerCertificadoNfse } from './nfse/configuracao.js';
export type { ConfiguracaoNfse } from './nfse/configuracao.js';
export { baixarXmlNfse } from './nfse/documentos.js';
export { prepararPdfsNfse, baixarPdfNfse, pdfPeloLinkNfse } from './nfse/pdf.js';
export { situacaoMunicipal, salvarConfiguracaoMunicipal } from './nfse-municipal/configuracao.js';
export type { CredenciaisMunicipais, SituacaoMunicipal } from './nfse-municipal/configuracao.js';
export type { ConfiguracaoMunicipal, EnderecoMunicipal } from './nfse-municipal/contrato.js';
export { baixarXmlMunicipal } from './nfse-municipal/documentos.js';
