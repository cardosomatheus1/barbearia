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
