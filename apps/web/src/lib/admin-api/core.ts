import { ApiTimeoutError, fetchComTimeout } from '../fetch-com-timeout';

/**
 * Cliente da API do painel.
 *
 * Sempre `no-store`: o painel mostra o que a barbearia acabou de salvar, e
 * qualquer cache aqui faria a etapa seguinte trabalhar sobre dado velho.
 */

export const BASE = process.env['API_URL'] ?? 'http://127.0.0.1:3000';

export type Resposta<T> =
  | { ok: true; dados: T }
  | { ok: false; code: string; message: string; detail?: unknown };

export async function chamar<T>(
  metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  token?: string,
  idempotencyKey?: string,
): Promise<Resposta<T>> {
  let resposta: Response;
  try {
    resposta = await fetchComTimeout(`${BASE}${path}`, {
      method: metodo,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
    });
  } catch (erro) {
    if (erro instanceof ApiTimeoutError) {
      return { ok: false, code: 'api_timeout', message: 'A API demorou mais do que o esperado. Tente novamente.' };
    }
    return {
      ok: false,
      code: 'api_indisponivel',
      message: 'Não foi possível falar com o servidor. Confira a conexão e tente novamente.',
    };
  }

  if (!resposta.ok) {
    const corpo = (await resposta.json().catch(() => null)) as {
      error?: { code?: string; message?: string; detail?: unknown };
    } | null;
    return {
      ok: false,
      code: corpo?.error?.code ?? 'request_failed',
      message: corpo?.error?.message ?? 'Não foi possível salvar. Tente de novo.',
      ...(corpo?.error?.detail !== undefined ? { detail: corpo.error.detail } : {}),
    };
  }

  return { ok: true, dados: (await resposta.json()) as T };
}
