'use server';
import { redirect } from 'next/navigation';
import { lerSessao } from '@/lib/sessao';
import { lerPedidoConsentimentoCadastro, confirmarConsentimentoCadastroNaApi, esquecerConsentimentoCadastro } from '@/lib/consentimento-cadastro';
export async function confirmarAceiteCadastro(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? ''); if (!/^[a-z0-9-]+$/.test(slug)) redirect('/');
  const sessao = await lerSessao(slug); const pedido = await lerPedidoConsentimentoCadastro(slug);
  if (!sessao) redirect(`/${slug}/entrar?destino=${encodeURIComponent(`/${slug}/consentimento-whatsapp`)}`);
  if (!pedido) redirect(`/${slug}/meus-agendamentos`);
  const r = await confirmarConsentimentoCadastroNaApi(slug, sessao, pedido.token);
  if (!r.ok) redirect(`/${slug}/consentimento-whatsapp?erro=1`);
  await esquecerConsentimentoCadastro(slug);
  redirect(`/${slug}/meus-agendamentos?feito=${r.dados.novoAceite ? 'aceitou' : 'aceite_anterior'}`);
}
export async function dispensarAceiteCadastro(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? ''); if (!/^[a-z0-9-]+$/.test(slug)) redirect('/');
  await esquecerConsentimentoCadastro(slug); redirect(`/${slug}/meus-agendamentos`);
}
