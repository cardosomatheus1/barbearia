/**
 * Timeout único para chamadas do Next à API.
 *
 * Sem isso uma conexão aceita pela API mas travada em banco/proxy pode segurar
 * Server Component/Action até o limite da infraestrutura. O timeout é de borda:
 * não muda a transação da API e nunca tenta repetir mutação automaticamente.
 */
export class ApiTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`A API excedeu ${timeoutMs} ms.`);
    this.name = 'ApiTimeoutError';
  }
}

export async function fetchComTimeout(
  input: Parameters<typeof fetch>[0],
  init: RequestInit & { next?: { revalidate?: number } } = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await fetch(input, { ...init, signal });
  } catch (erro) {
    if (timeout.aborted && !init.signal?.aborted) throw new ApiTimeoutError(timeoutMs);
    throw erro;
  }
}
