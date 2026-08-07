/**
 * Erros do domínio traduzidos para HTTP.
 *
 * O cliente recebe um `code` estável e uma mensagem genérica; o detalhe fica no
 * log (CLAUDE.md §2). Nunca vaza nome de tabela, SQL, stack ou id interno.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (code: string, message: string): DomainError =>
  new DomainError(code, 404, message);

export const badRequest = (code: string, message: string): DomainError =>
  new DomainError(code, 400, message);
