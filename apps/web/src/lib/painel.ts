import { redirect } from 'next/navigation';
import { estadoDoPainel, type EstadoOnboarding } from './admin-api';

/**
 * Estado do painel, ou o desvio certo.
 *
 * Toda tela do painel começa igual, e o desvio importa: quem entrou com a senha
 * de primeiro acesso recebe 403 em tudo até trocá-la. Mandar essa pessoa para o
 * login — que era o que cada tela fazia — cria um laço: ela entra, é recusada,
 * volta para o login, entra de novo.
 */
export async function painelOuDesvio(token: string): Promise<EstadoOnboarding> {
  const estado = await estadoDoPainel(token);
  if (estado.ok) return estado.dados;

  if (estado.code === 'must_change_password') redirect('/admin/trocar-senha');
  redirect('/admin/entrar');
}

/**
 * A mesma pergunta que a API faz.
 *
 * A tela esconde o que a guarda recusaria — não por segurança, que está no
 * servidor, mas porque botão que só serve para dar erro é pior que botão
 * ausente para quem opera.
 */
export function podeNaTela(estado: EstadoOnboarding, permissao: string): boolean {
  return estado.staff.permissions.includes(permissao);
}
