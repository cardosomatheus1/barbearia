import { cookies } from 'next/headers';

/**
 * Sessão de quem administra a barbearia.
 *
 * Separada da sessão do cliente em nome **e** em caminho. O dono que também é
 * cliente de outra barbearia teria os dois cookies no mesmo navegador, e um
 * nome compartilhado faria o painel ler o token errado.
 *
 * O caminho `/admin` também limita o envio: o cookie do painel não acompanha
 * nenhuma requisição das páginas públicas.
 */

const NOME = 'gestor';
const CAMINHO = '/admin';

export async function lerSessaoGestor(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(NOME)?.value ?? null;
}

export async function gravarSessaoGestor(token: string, expiraEm: string): Promise<void> {
  const jar = await cookies();
  jar.set(NOME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // `strict` e não `lax`: o painel não é aberto por link de fora, e é o
    // token que altera catálogo, equipe e preço.
    sameSite: 'strict',
    path: CAMINHO,
    expires: new Date(expiraEm),
  });
}

export async function apagarSessaoGestor(): Promise<void> {
  const jar = await cookies();
  jar.set(NOME, '', { httpOnly: true, path: CAMINHO, maxAge: 0 });
}
