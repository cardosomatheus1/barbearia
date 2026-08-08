import { cookies } from 'next/headers';

/**
 * O celular digitado, entre pedir o código e conferi-lo.
 *
 * Vai em cookie de curta duração, não na URL. Celular é dado pessoal: na URL
 * ele fica no histórico do navegador — que numa barbearia é frequentemente um
 * aparelho compartilhado — e vaza no `Referer` de qualquer link externo da
 * página.
 *
 * Dez minutos cobrem com folga os cinco de validade do código.
 */

const MINUTOS = 10;

function nome(slug: string): string {
  return `login_${slug.replace(/[^a-z0-9-]/gi, '')}`;
}

export async function guardarFone(slug: string, phone: string): Promise<void> {
  const jar = await cookies();
  jar.set(nome(slug), phone, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: `/${slug}`,
    maxAge: MINUTOS * 60,
  });
}

export async function lerFone(slug: string): Promise<string | null> {
  const jar = await cookies();
  return jar.get(nome(slug))?.value ?? null;
}

export async function esquecerFone(slug: string): Promise<void> {
  const jar = await cookies();
  jar.set(nome(slug), '', { httpOnly: true, path: `/${slug}`, maxAge: 0 });
}
