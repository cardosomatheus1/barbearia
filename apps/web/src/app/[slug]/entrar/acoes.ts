'use server';

import { redirect } from 'next/navigation';
import { conferirCodigo, pedirCodigo } from '@/lib/api';
import { esquecerFone, guardarFone, lerFone } from '@/lib/login-fone';
import { destinoSeguro } from '@/lib/destino';
import { gravarSessao } from '@/lib/sessao';

/**
 * Entrar para ver, cancelar ou remarcar.
 *
 * Aqui o código **é** obrigatório, ao contrário de agendar. Sem ele bastaria
 * conhecer o telefone de alguém para desmarcar o horário dessa pessoa.
 *
 * As duas ações são server actions: o Next confere `Origin` contra `Host` antes
 * de executá-las, o que fecha a porta para um site de terceiro disparar login
 * ou cancelamento no navegador de quem está logado.
 */

export async function enviarCodigo(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const phone = String(form.get('phone') ?? '').trim();
  const destino = destinoSeguro(String(form.get('destino') ?? '') || null, slug);

  const resultado = await pedirCodigo(slug, phone);

  if (!resultado.ok) {
    // Cooldown e teto de envios só acontecem porque **já saiu um código**. Vale
    // mandar para o passo do código, não de volta ao celular: o cliente tem a
    // mensagem no WhatsApp e devolvê-lo ao começo faz parecer que travou.
    const jaTemCodigo = resultado.code === 'resend_too_soon' || resultado.code === 'too_many_sends';
    if (jaTemCodigo) await guardarFone(slug, phone);

    const busca = new URLSearchParams({
      ...(jaTemCodigo ? { e: 'codigo' } : {}),
      erro: resultado.code,
      destino,
    });
    redirect(`/${slug}/entrar?${busca.toString()}`);
  }

  await guardarFone(slug, phone);
  redirect(`/${slug}/entrar?e=codigo&destino=${encodeURIComponent(destino)}`);
}

export async function conferir(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const code = String(form.get('code') ?? '').trim();
  const destino = destinoSeguro(String(form.get('destino') ?? '') || null, slug);

  const phone = await lerFone(slug);
  if (!phone) {
    // O cookie do celular expirou: recomeçar é o único caminho honesto, e dizer
    // por quê evita o cliente digitar o código de novo achando que errou.
    redirect(`/${slug}/entrar?erro=sessao_expirada&destino=${encodeURIComponent(destino)}`);
  }

  const resultado = await conferirCodigo(slug, phone, code);

  if (!resultado.ok) {
    const busca = new URLSearchParams({ e: 'codigo', erro: resultado.code, destino });
    redirect(`/${slug}/entrar?${busca.toString()}`);
  }

  await gravarSessao(slug, resultado.dados.token, resultado.dados.expiresAt);
  await esquecerFone(slug);
  redirect(destino);
}
