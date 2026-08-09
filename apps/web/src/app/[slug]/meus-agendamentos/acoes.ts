'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  cancelarAgendamento,
  decidirConsentimento,
  encerrarSessao,
  pedirMeusDados,
  remarcarAgendamento,
} from '@/lib/api';
import { VERSAO_DO_CONSENTIMENTO } from '@/lib/politica';
import { apagarSessao, lerSessao } from '@/lib/sessao';

/**
 * Cancelar, remarcar e sair.
 *
 * Toda ação relê a sessão do cookie httpOnly no servidor. O id do agendamento
 * vem do formulário e é palpite fácil de manipular — quem autoriza é o token,
 * e a API confere que o agendamento é deste cliente. A tela não decide nada.
 */

export async function cancelar(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const id = String(form.get('id') ?? '');

  const token = await lerSessao(slug);
  if (!token) redirect(`/${slug}/entrar`);

  const resultado = await cancelarAgendamento(slug, token, id);

  // `revalidatePath` antes do redirect: sem isso a lista volta do cache com o
  // agendamento ainda lá, e o cliente cancela de novo achando que falhou.
  revalidatePath(`/${slug}/meus-agendamentos`);

  redirect(
    resultado.ok
      ? `/${slug}/meus-agendamentos?feito=cancelado`
      : `/${slug}/meus-agendamentos?erro=${resultado.code}`,
  );
}

export async function remarcar(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const id = String(form.get('id') ?? '');
  const date = String(form.get('date') ?? '');
  const start = String(form.get('start') ?? '');
  const professionalId = String(form.get('professionalId') ?? '');

  const token = await lerSessao(slug);
  if (!token) redirect(`/${slug}/entrar`);

  const resultado = await remarcarAgendamento(slug, token, id, {
    date,
    start,
    ...(professionalId && professionalId !== 'any' ? { professionalId } : {}),
  });

  revalidatePath(`/${slug}/meus-agendamentos`);

  if (!resultado.ok) {
    const busca = new URLSearchParams({ d: date, erro: resultado.code });
    redirect(`/${slug}/meus-agendamentos/${id}/remarcar?${busca.toString()}`);
  }

  redirect(`/${slug}/meus-agendamentos?feito=remarcado`);
}

export async function sair(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const token = await lerSessao(slug);

  // Revoga no servidor **antes** de apagar o cookie. Só apagar deixaria o token
  // aceito por quem o tivesse capturado — e "Sair" num aparelho compartilhado,
  // que é o caso numa barbearia, precisa encerrar de verdade.
  if (token) await encerrarSessao(slug, token);
  await apagarSessao(slug);

  redirect(`/${slug}`);
}

/**
 * A decisão do titular sobre receber promoção (bloco 31).
 *
 * A versão do texto vai junto e sai de `politica.ts`, nunca do formulário: um
 * cliente que editasse o campo escondido gravaria um consentimento com a versão
 * que ele quisesse, e a prova viraria o que o navegador dele digitou.
 */
export async function decidirMarketing(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const token = await lerSessao(slug);
  if (!token) redirect(`/${slug}/entrar`);

  const marketing = String(form.get('marketing') ?? '') === '1';
  await decidirConsentimento(slug, token, marketing, VERSAO_DO_CONSENTIMENTO);

  redirect(`/${slug}/meus-agendamentos?feito=${marketing ? 'aceitou' : 'recusou'}`);
}

/**
 * Pedir uma cópia dos próprios dados (bloco 31).
 *
 * O botão registra o pedido; quem responde é a barbearia, que é a controladora.
 * Devolver o arquivo aqui mandaria dado pessoal por uma rota cuja única prova de
 * identidade é a posse de um celular — e o titular pode ter trocado de número.
 */
export async function pedirDados(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const token = await lerSessao(slug);
  if (!token) redirect(`/${slug}/entrar`);

  const resultado = await pedirMeusDados(slug, token);
  redirect(
    resultado.ok
      ? `/${slug}/meus-agendamentos?feito=pediu`
      : `/${slug}/meus-agendamentos?erro=${resultado.code}`,
  );
}
