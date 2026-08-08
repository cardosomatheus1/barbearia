import type { ServiceTemplate } from '@barbearia/core';

/**
 * Cliente da API do painel.
 *
 * Sempre `no-store`: o painel mostra o que a barbearia acabou de salvar, e
 * qualquer cache aqui faria a etapa seguinte trabalhar sobre dado velho.
 */

const BASE = process.env['API_URL'] ?? 'http://127.0.0.1:3000';

export type Resposta<T> =
  | { ok: true; dados: T }
  | { ok: false; code: string; message: string; detail?: unknown };

async function chamar<T>(
  metodo: 'GET' | 'POST' | 'PUT',
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

export interface SessaoGestor {
  token: string;
  expiresAt: string;
  tenantId: string;
  slug: string;
  name: string;
  role: string;
}

/**
 * Cria a conta.
 *
 * Não devolve sessão: a API responde igual para e-mail livre e já cadastrado,
 * para não revelar quem é dono de barbearia na plataforma. O passo seguinte é
 * sempre o login.
 */
export const criarConta = (dados: {
  name: string;
  email: string;
  password: string;
  phone: string;
  businessName: string;
}) => chamar<{ next: string }>('POST', '/v1/admin/signup', dados);

export const entrarComoGestor = (email: string, password: string) =>
  chamar<SessaoGestor>('POST', '/v1/admin/login', { email, password });

export const sairDoGestor = (token: string) =>
  chamar<{ revoked: boolean }>('POST', '/v1/admin/logout', {}, token);

export interface EstadoOnboarding {
  tenantId: string;
  businessName: string;
  slug: string;
  step: number;
  publishedAt: string | null;
  locationId: string;
  counts: { services: number; professionals: number; schedules: number };
  staff: { name: string; role: string };
}

export const estadoDoPainel = (token: string) =>
  chamar<EstadoOnboarding>('GET', '/v1/admin/state', undefined, token);

export const templatesDeServico = (token: string) =>
  chamar<{ templates: ServiceTemplate[] }>('GET', '/v1/admin/templates', undefined, token);

export const salvarEmpresa = (token: string, dados: Record<string, unknown>) =>
  chamar<{ slug: string }>('PUT', '/v1/admin/business', dados, token);

export const salvarServicos = (token: string, services: unknown[]) =>
  chamar<{ created: number }>('PUT', '/v1/admin/services', { services }, token);

export const salvarProfissionais = (token: string, professionals: unknown[]) =>
  chamar<{ created: number }>('PUT', '/v1/admin/professionals', { professionals }, token);

export const salvarPagamentos = (token: string, methods: string[]) =>
  chamar<{ saved: boolean }>('PUT', '/v1/admin/payments', { methods }, token);

export const publicarBarbearia = (token: string) =>
  chamar<{ slug: string; publishedAt: string }>('POST', '/v1/admin/publish', {}, token);

export const salvarJanela = (
  token: string,
  dados: {
    cancelMinHours: number;
    rescheduleMinHours: number;
    maxReschedules: number;
    cancellationPolicy?: string;
  },
) => chamar<{ saved: boolean }>('PUT', '/v1/admin/change-window', dados, token);
