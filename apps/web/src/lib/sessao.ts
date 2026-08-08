import { cookies } from 'next/headers';

/**
 * Sessão do cliente, guardada em cookie **httpOnly**.
 *
 * Não vai para `localStorage`: o token é a credencial que cancela um horário, e
 * qualquer script na página o leria de lá. Em cookie httpOnly nem o próprio
 * JavaScript da aplicação alcança — só o servidor, que é quem precisa dele.
 */

/**
 * Um cookie por barbearia, no nome **e** no caminho.
 *
 * O caminho sozinho não basta: `cookies().get()` busca por nome e a API do
 * Next não expõe o `path` de cada cookie. Quem tivesse sessão em duas
 * barbearias teria dois cookies homônimos e leria o primeiro que viesse — o
 * token errado, para a barbearia errada.
 *
 * O slug vem da URL. O filtro deixa passar só o alfabeto que a API aceita em
 * slug; assim nada do caminho vaza para o nome do cookie.
 */
function nome(slug: string): string {
  return `sessao_${slug.replace(/[^a-z0-9-]/gi, '')}`;
}

function caminho(slug: string): string {
  return `/${slug}`;
}

export async function lerSessao(slug: string): Promise<string | null> {
  const jar = await cookies();
  return jar.get(nome(slug))?.value ?? null;
}

export async function gravarSessao(
  slug: string,
  token: string,
  expiraEm: string,
): Promise<void> {
  const jar = await cookies();
  jar.set(nome(slug), token, {
    httpOnly: true,
    // Em desenvolvimento o servidor é http; exigir `secure` faria o cookie ser
    // descartado em silêncio e o login pareceria simplesmente não funcionar.
    secure: process.env.NODE_ENV === 'production',
    // `lax` deixa o cookie ir num clique de link vindo do WhatsApp — que é como
    // o cliente chega — mas não numa requisição de terceiro que dispare escrita.
    sameSite: 'lax',
    path: caminho(slug),
    expires: new Date(expiraEm),
  });
}

export async function apagarSessao(slug: string): Promise<void> {
  const jar = await cookies();
  jar.set(nome(slug), '', { httpOnly: true, path: caminho(slug), maxAge: 0 });
}
