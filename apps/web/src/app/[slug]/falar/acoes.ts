'use server';

import { redirect } from 'next/navigation';
import { mandarRecadoNaApi } from '@/lib/api';
import { lerSessao } from '@/lib/sessao';

/**
 * Manda o recado (bloco 40).
 *
 * A sessão entra quando existe, e não é exigida. Com ela o recado fica ligado ao
 * cadastro e a barbearia sabe a quem responder; sem ela, quem quiser resposta
 * deixa nome e celular; quem não quiser nada fica anônimo — e o anônimo é
 * legítimo, não um caso degradado.
 */
export async function mandar(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const tipo = String(form.get('tipo') ?? '');
  const texto = String(form.get('texto') ?? '');
  const nome = String(form.get('nome') ?? '').trim();
  const telefone = String(form.get('telefone') ?? '').trim();

  const token = await lerSessao(slug);

  const resultado = await mandarRecadoNaApi(slug, {
    tipo,
    texto,
    ...(nome ? { nome } : {}),
    ...(telefone ? { telefone } : {}),
    ...(token ? { token } : {}),
  });

  redirect(
    resultado.ok
      ? `/${slug}/falar?feito=1`
      : `/${slug}/falar?erro=${resultado.code}&t=${encodeURIComponent(tipo)}`,
  );
}
