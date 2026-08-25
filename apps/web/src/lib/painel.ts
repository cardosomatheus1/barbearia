import { notFound, redirect } from 'next/navigation';
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
 * Este recurso está ligado para esta barbearia?
 *
 * A lista vem do servidor, da mesma função que a `PermissaoGuard` consulta —
 * nunca de um cálculo daqui. É o desenho de `podeNaTela`, e a razão é a mesma:
 * duas noções de "esta casa tem fiscal?" divergem no primeiro ajuste.
 *
 * A diferença para a permissão é o que a tela faz com a resposta. Sem
 * permissão, o item continua no menu e a tela explica; sem o recurso, ele
 * **some** — porque quem decidiu não foi a barbearia, e mandá-la procurar o
 * dono para liberar algo que o dono também não tem é o pior recado possível.
 */
export function recursoNaTela(estado: EstadoOnboarding, recurso: string): boolean {
  return estado.recursos.includes(recurso);
}

/**
 * A porta da tela de um recurso desligado.
 *
 * Esconder o link do menu não fecha a tela: o endereço continua digitável, e
 * quem o tem salvo no navegador chegaria a uma página que pede à API algo que
 * ela responde 404 — estado de erro no lugar de "isto não existe aqui".
 *
 * Vale para **toda** tela gateada, e não só para a que motivou o mecanismo: há
 * guarda derivada que percorre `secoes.ts` e cobra esta chamada em cada destino
 * que declara `recurso`.
 */
export function exigirRecurso(estado: EstadoOnboarding, recurso: string): void {
  if (!recursoNaTela(estado, recurso)) notFound();
}


/**
 * Porta inicial depois do login.
 *
 * O cadastro incompleto continua tendo precedência: mandar um dono que ainda
 * não publicou a casa para um painel vazio seria trocar orientação por um
 * atalho. Depois disso, o destino é o trabalho do papel — barbeiro no próprio
 * dia, recepção/gerência em Hoje, e quem tem escopo de dono no Painel.
 *
 * O papel é o sinal principal, mas permissões entram na decisão porque elas são
 * editáveis. Um gerente que recebeu explicitamente o mesmo escopo de gestão do
 * dono não deve ser forçado para uma casa operacional que já não representa o
 * trabalho dele.
 */
export function destinoInicialDoPainel(estado: {
  readonly publishedAt: string | null;
  readonly staff: { readonly role: string; readonly permissions: readonly string[] };
}): string {
  if (estado.staff.role === 'professional') return '/admin/meu-dia';

  if (estado.publishedAt === null && estado.staff.permissions.includes('settings.manage')) {
    return '/admin/onboarding';
  }

  const temEscopoDeDono =
    estado.staff.role === 'owner' ||
    ['reports.operational', 'finance.view_profit', 'team.manage'].every((p) =>
      estado.staff.permissions.includes(p),
    );

  if (temEscopoDeDono && estado.staff.permissions.includes('reports.operational')) {
    return '/admin/painel';
  }

  return '/admin/dia';
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
