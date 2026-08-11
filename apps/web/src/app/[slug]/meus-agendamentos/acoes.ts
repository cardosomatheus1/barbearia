'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  aceitarConviteDaEspera,
  cancelarAgendamento,
  decidirConsentimento,
  encerrarSessao,
  pedirMeusDados,
  remarcarAgendamento,
  sairDaEsperaNaApi,
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
 * Pedir uma cópia dos próprios dados, ou pedir para ser apagado.
 *
 * O botão **registra** o pedido; quem responde é a barbearia, que é a
 * controladora. Devolver o arquivo aqui mandaria dado pessoal por uma rota cuja
 * única prova de identidade é a posse de um celular — e o titular pode ter
 * trocado de número. Apagar aqui seria pior ainda pelo mesmo motivo, e tiraria
 * da barbearia a conferência de guarda legal que a lei manda ela fazer.
 *
 * O tipo vem do formulário e é conferido: campo de formulário é entrada
 * externa, e um valor solto viraria `data_request_kind` inválido no banco.
 */
export async function pedirDados(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const token = await lerSessao(slug);
  if (!token) redirect(`/${slug}/entrar`);

  const bruto = String(form.get('tipo') ?? '');
  const tipo = bruto === 'deletion' ? 'deletion' : 'export';

  const resultado = await pedirMeusDados(slug, token, tipo);
  redirect(
    resultado.ok
      ? `/${slug}/meus-agendamentos?feito=${tipo === 'deletion' ? 'pediu_exclusao' : 'pediu'}`
      : `/${slug}/meus-agendamentos?erro=${resultado.code}`,
  );
}

/**
 * Sai da lista de espera (bloco 38).
 *
 * Todo estado precisa de saída **na tela**, não só no domínio (CLAUDE.md §6).
 * Sem este botão, entrar na lista seria um caminho de ida: a pessoa gastaria
 * uma das três vagas e não teria como devolvê-la — e a lista da barbearia
 * encheria de gente que já resolveu por outro lado.
 */
export async function sairDaEspera(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const token = await lerSessao(slug);
  if (!token) redirect(`/${slug}/entrar`);

  const resultado = await sairDaEsperaNaApi(slug, token, String(form.get('id') ?? ''));
  redirect(
    resultado.ok
      ? `/${slug}/meus-agendamentos?feito=espera`
      : `/${slug}/meus-agendamentos?erro=${resultado.code}`,
  );
}

/**
 * Aceita o convite de vaga pela própria tela (bloco 39).
 *
 * O caminho normal é o link da mensagem. Este existe porque a mensagem pode não
 * chegar, e sem ele a pessoa lê "um horário abriu para você" sem ter como
 * pegá-lo — que é estado sem saída na interface.
 */
export async function aceitarVaga(form: FormData): Promise<void> {
  const slug = String(form.get('slug') ?? '');
  const token = await lerSessao(slug);
  if (!token) redirect(`/${slug}/entrar`);

  const resultado = await aceitarConviteDaEspera(slug, token, String(form.get('id') ?? ''));
  revalidatePath(`/${slug}/meus-agendamentos`);
  redirect(
    resultado.ok
      ? `/${slug}/meus-agendamentos?feito=vaga`
      : `/${slug}/meus-agendamentos?erro=${resultado.code}`,
  );
}
