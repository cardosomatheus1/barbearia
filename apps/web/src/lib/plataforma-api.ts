/**
 * Cliente da API da plataforma.
 *
 * Separado de `admin-api.ts` de propósito, e não por organização de arquivos:
 * são duas APIs com dois tipos de token, e um cliente único convidaria a passar
 * o token errado numa chamada nova. Aqui não existe função que aceite os dois.
 *
 * Sempre `no-store`: bloquear uma conta e ver a lista velha em seguida seria
 * pior do que não ter a tela.
 */

const BASE = process.env['API_URL'] ?? 'http://127.0.0.1:3000';

export type Resposta<T> =
  | { ok: true; dados: T }
  | { ok: false; code: string; message: string };

async function chamar<T>(
  metodo: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  token?: string,
): Promise<Resposta<T>> {
  const resposta = await fetch(`${BASE}${path}`, {
    method: metodo,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });

  if (!resposta.ok) {
    const corpo = (await resposta.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    return {
      ok: false,
      code: corpo?.error?.code ?? 'request_failed',
      message: corpo?.error?.message ?? 'Não foi possível concluir. Tente de novo.',
    };
  }

  return { ok: true, dados: (await resposta.json()) as T };
}

export interface SessaoDaPlataforma {
  token: string;
  expiraEm: string;
  admin: { id: string; nome: string };
}

export interface Plano {
  id: string;
  code: string;
  name: string;
  priceCents: number;
  maxChairs: number | null;
  active: boolean;
}

export interface BarbeariaNaPlataforma {
  tenantId: string;
  nome: string;
  slug: string | null;
  plano: { code: string; name: string; priceCents: number } | null;
  bloqueada: boolean;
  bloqueadaEm: string | null;
  motivoDoBloqueio: string | null;
  criadaEm: string;
}

export interface EventoDaPlataforma {
  acao: string;
  tenantId: string | null;
  detalhe: Record<string, unknown>;
  quando: string;
  adminNome: string | null;
}

export const entrarNaPlataforma = (email: string, senha: string) =>
  chamar<SessaoDaPlataforma>('POST', '/v1/plataforma/login', { email, senha });

export const sairDaPlataforma = (token: string) =>
  chamar<{ revoked: boolean }>('POST', '/v1/plataforma/logout', {}, token);

export const listarBarbearias = (token: string) =>
  chamar<{ barbearias: BarbeariaNaPlataforma[] }>('GET', '/v1/plataforma/barbearias', undefined, token);

export const listarPlanos = (token: string) =>
  chamar<{ planos: Plano[] }>('GET', '/v1/plataforma/planos', undefined, token);

export const trocarPlano = (token: string, tenantId: string, planoCode: string) =>
  chamar<{ ok: boolean }>('PUT', `/v1/plataforma/barbearias/${tenantId}/plano`, { planoCode }, token);

export const bloquear = (token: string, tenantId: string, motivo: string) =>
  chamar<{ ok: boolean }>('POST', `/v1/plataforma/barbearias/${tenantId}/bloqueio`, { motivo }, token);

export const desbloquear = (token: string, tenantId: string) =>
  chamar<{ ok: boolean }>('DELETE', `/v1/plataforma/barbearias/${tenantId}/bloqueio`, undefined, token);

export const trilhaDaPlataforma = (token: string, limite = 100) =>
  chamar<{ eventos: EventoDaPlataforma[] }>(
    'GET',
    `/v1/plataforma/trilha?limite=${limite}`,
    undefined,
    token,
  );
