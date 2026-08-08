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

/**
 * Onde cada papel começa o dia.
 *
 * O barbeiro tem `appointments.view` e a API já recorta a agenda dele pela
 * própria cadeira — então o painel do balcão **funciona** para ele. Funcionar
 * não é servir: aquela tela é uma tabela de cinco cadeiras feita para um
 * notebook aberto o dia inteiro, e ele a abre no celular entre um corte e
 * outro. A SPEC §1.2 pede "interface própria" para o barbeiro, e esta é a
 * função que a entrega.
 *
 * Papel, não permissão: é uma escolha de destino, não de autorização. Quem
 * pode o quê continua sendo decidido pela `PermissaoGuard` no servidor.
 */
export function casaDoPapel(estado: EstadoOnboarding): string {
  return estado.staff.role === 'professional' ? '/admin/meu-dia' : '/admin/dia';
}

/**
 * O painel, já desviando o barbeiro para a tela dele.
 *
 * Existe separado de `painelOuDesvio` porque a ficha do cliente e a tela de
 * segurança servem aos dois papéis: mandar o barbeiro embora de lá seria
 * trancá-lo fora de páginas que são dele.
 */
export async function painelDoBalcaoOuDesvio(token: string): Promise<EstadoOnboarding> {
  const estado = await painelOuDesvio(token);
  const casa = casaDoPapel(estado);
  if (casa !== '/admin/dia') redirect(casa);
  return estado;
}
