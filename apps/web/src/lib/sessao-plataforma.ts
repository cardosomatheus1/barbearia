import { cookies } from 'next/headers';

/**
 * Sessão do Super Admin.
 *
 * Nome **e** caminho próprios, pelo mesmo motivo que separa a sessão do gestor
 * da do cliente — e aqui a consequência é maior: quem administra a plataforma
 * quase sempre também tem uma conta de gestor para testar. Os dois cookies
 * conviveriam no mesmo navegador, e um nome compartilhado faria o painel da
 * plataforma mandar o token da barbearia (ou o contrário) para uma API que o
 * recusaria com 401 sem explicar por quê.
 *
 * O caminho `/plataforma` também limita o envio: este cookie não acompanha
 * nenhuma requisição do painel da barbearia nem das páginas públicas.
 */

const NOME = 'plataforma';
const CAMINHO = '/plataforma';

export async function lerSessaoDaPlataforma(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(NOME)?.value ?? null;
}

export async function gravarSessaoDaPlataforma(token: string, expiraEm: string): Promise<void> {
  const jar = await cookies();
  jar.set(NOME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // `strict`: este painel bloqueia contas e troca planos de todas as
    // barbearias. Nenhum link de fora tem motivo para abri-lo autenticado.
    sameSite: 'strict',
    path: CAMINHO,
    expires: new Date(expiraEm),
  });
}

export async function apagarSessaoDaPlataforma(): Promise<void> {
  const jar = await cookies();
  jar.set(NOME, '', { httpOnly: true, path: CAMINHO, maxAge: 0 });
}
