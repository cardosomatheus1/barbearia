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
    /**
     * Detalhe estruturado do que o **próprio cliente** enviou de errado.
     *
     * Só para isso. "Este combo declara 40 min e as partes somam 55" é a
     * informação sem a qual a tela só consegue dizer "dados inválidos" e o
     * usuário não sabe o que corrigir. Nada de origem interna entra aqui — a
     * regra de não vazar schema continua valendo.
     */
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (code: string, message: string): DomainError =>
  new DomainError(code, 404, message);

export const badRequest = (code: string, message: string): DomainError =>
  new DomainError(code, 400, message);
