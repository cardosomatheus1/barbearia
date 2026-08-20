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

/**
 * O segredo do segundo fator e os códigos de recuperação, do servidor para a
 * tela seguinte.
 *
 * Mesmo mecanismo e mesmo motivo do bloco 19, agravado: aqui a conta protegida
 * é a que enxerga todas as barbearias. O segredo TOTP gera todos os códigos
 * futuros e os de recuperação valem como segundo fator inteiro — nenhum dos
 * dois pode ir na URL, que fica no histórico do navegador e em log de proxy.
 */
const SEGREDO = 'plataforma-mfa';
const SEGUNDOS_NA_TELA = 120;

export interface SegredoDaPlataforma {
  readonly segredoBase32: string;
  readonly uri: string;
  readonly codigosDeRecuperacao: readonly string[];
}

export async function guardarSegredoDaPlataforma(dados: SegredoDaPlataforma): Promise<void> {
  const jar = await cookies();
  jar.set(SEGREDO, JSON.stringify(dados), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/plataforma/seguranca',
    maxAge: SEGUNDOS_NA_TELA,
  });
}

export async function lerSegredoDaPlataforma(): Promise<SegredoDaPlataforma | null> {
  const bruto = (await cookies()).get(SEGREDO)?.value;
  if (!bruto) return null;

  try {
    const lido: unknown = JSON.parse(bruto);
    if (
      typeof lido === 'object' && lido !== null &&
      'segredoBase32' in lido && typeof lido.segredoBase32 === 'string' &&
      'uri' in lido && typeof lido.uri === 'string' &&
      'codigosDeRecuperacao' in lido && Array.isArray(lido.codigosDeRecuperacao)
    ) {
      return lido as unknown as SegredoDaPlataforma;
    }
  } catch {
    // Cookie corrompido não derruba a tela de segurança.
  }
  return null;
}

/**
 * A frase que a API escreveu quando recusou, do servidor para a tela seguinte.
 *
 * Espelha `guardarRecusa` do painel da barbearia, com nome e caminho próprios
 * pelo mesmo motivo que separa as duas sessões: quem administra a plataforma
 * quase sempre tem também uma conta de gestor no mesmo navegador, e um cookie
 * compartilhado faria a recusa de um painel aparecer no outro.
 *
 * Vai por cookie e não pela URL porque o endereço fica no histórico, no
 * autocompletar e no referrer — e aqui a frase pode nomear a barbearia, o plano
 * e o motivo de um bloqueio.
 */
const RECUSA = 'plataforma-recusa';

export async function guardarRecusaDaPlataforma(mensagem: string): Promise<void> {
  const jar = await cookies();
  jar.set(RECUSA, mensagem.slice(0, 300), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: CAMINHO,
    maxAge: SEGUNDOS_NA_TELA,
  });
}

/** Lê sem apagar, como a do painel: quem limpa é o tempo curto. */
export async function lerRecusaDaPlataforma(): Promise<string | null> {
  return (await cookies()).get(RECUSA)?.value ?? null;
}
