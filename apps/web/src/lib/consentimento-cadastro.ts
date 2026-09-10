import { cookies } from 'next/headers';
import { chamar } from './admin-api/core';
function nome(slug: string) { return `wa_cadastro_${slug.replace(/[^a-z0-9-]/gi, '')}`; }
export async function guardarConsentimentoCadastro(slug: string, appointmentId: string, p: { token: string; expiresAt: string }) {
  (await cookies()).set(nome(slug), `${p.token}.${appointmentId}`, { httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', path: `/${slug}`, expires: new Date(p.expiresAt) });
}
export async function lerPedidoConsentimentoCadastro(slug: string) {
  const valor = (await cookies()).get(nome(slug))?.value;
  const partes = valor?.match(/^([A-Za-z0-9_-]{43})\.([0-9a-f-]{36})$/);
  return partes ? { token: partes[1]!, appointmentId: partes[2]! } : null;
}
export async function esquecerConsentimentoCadastro(slug: string) {
  (await cookies()).set(nome(slug), '', { httpOnly: true, sameSite: 'lax', path: `/${slug}`, maxAge: 0 });
}
export const consultarConsentimentoCadastroNaApi = (slug: string, sessao: string, token: string) => chamar<{ texto: string; confirmado: boolean }>('POST', `/v1/b/${encodeURIComponent(slug)}/auth/whatsapp-cadastro/consultar`, { token }, sessao);
export const confirmarConsentimentoCadastroNaApi = (slug: string, sessao: string, token: string) => chamar<{ confirmado: true; novoAceite: boolean }>('POST', `/v1/b/${encodeURIComponent(slug)}/auth/whatsapp-cadastro/confirmar`, { token }, sessao);
