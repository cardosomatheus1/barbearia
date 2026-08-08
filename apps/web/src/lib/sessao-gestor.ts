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

/**
 * A senha de primeiro acesso, do servidor para a tela seguinte.
 *
 * Cookie e não parâmetro de URL. A primeira versão redirecionava para
 * `/admin/equipe?senha=…` e o argumento — "o painel é `noindex` e a senha morre
 * no primeiro uso" — não cobria onde a URL de fato para:
 *
 * - o cabeçalho `Location` do 303 e todo `Referer` seguinte vão para o log do
 *   servidor e do proxy, porque a política padrão do navegador manda a URL
 *   inteira em requisição de mesma origem;
 * - o histórico e o autocompletar do balcão guardam a senha por tempo
 *   indeterminado — e o balcão é uma máquina compartilhada.
 *
 * E "morre no primeiro uso" é mais fraco do que parece: `must_change_password`
 * bloqueia o painel, não o login. Quem lê a URL primeiro fica com a conta, e a
 * pessoa certa descobre pelo "senha incorreta".
 *
 * `httpOnly` mantém fora do JavaScript, o caminho restrito mantém fora das
 * outras telas, e o tempo curto é o que substitui o apagamento — componente de
 * servidor não apaga cookie durante a renderização.
 */
const SENHA_NOVA = 'senha-nova';
const CAMINHO_EQUIPE = '/admin/equipe';
const SEGUNDOS_NA_TELA = 120;

export async function guardarSenhaDeUmaVez(nome: string, senha: string): Promise<void> {
  const jar = await cookies();
  jar.set(SENHA_NOVA, JSON.stringify({ nome, senha }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: CAMINHO_EQUIPE,
    maxAge: SEGUNDOS_NA_TELA,
  });
}

export async function lerSenhaDeUmaVez(): Promise<{ nome: string; senha: string } | null> {
  const bruto = (await cookies()).get(SENHA_NOVA)?.value;
  if (!bruto) return null;

  try {
    const lido: unknown = JSON.parse(bruto);
    if (
      typeof lido === 'object' && lido !== null &&
      'nome' in lido && 'senha' in lido &&
      typeof lido.nome === 'string' && typeof lido.senha === 'string'
    ) {
      return { nome: lido.nome, senha: lido.senha };
    }
  } catch {
    // Cookie corrompido não derruba a tela de equipe inteira.
  }
  return null;
}

/**
 * A jornada recusada e quem ficaria de fora, do servidor para a tela seguinte.
 *
 * Mesmo motivo do cookie de senha, por outro caminho: a proposta é a semana
 * inteira que a pessoa acabou de digitar e a lista de conflitos traz **nome de
 * cliente**. Nenhuma das duas coisas pode ir na URL — a primeira estoura o
 * limite prático de uma query string, e a segunda acabaria no histórico do
 * balcão, que é máquina compartilhada.
 *
 * Vida curta e caminho restrito. Se a pessoa não confirmar em cinco minutos, o
 * cookie some e a tela volta a mostrar a jornada gravada — que é o estado real.
 */
const CONFLITO_JORNADA = 'jornada-conflito';
const CAMINHO_PROFISSIONAIS = '/admin/profissionais';
const SEGUNDOS_PARA_CONFIRMAR = 300;

export interface JornadaEmConflito {
  readonly professionalId: string;
  readonly faixas: readonly {
    weekday: number;
    startMinute: number;
    endMinute: number;
    breaks: { start: number; end: number }[];
  }[];
  readonly conflitos: readonly {
    appointmentId: string;
    date: string;
    time: string;
    customerName: string | null;
  }[];
}

export async function guardarConflitoDeJornada(dados: JornadaEmConflito): Promise<void> {
  const jar = await cookies();
  jar.set(CONFLITO_JORNADA, JSON.stringify(dados), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: CAMINHO_PROFISSIONAIS,
    maxAge: SEGUNDOS_PARA_CONFIRMAR,
  });
}

export async function lerConflitoDeJornada(): Promise<JornadaEmConflito | null> {
  const bruto = (await cookies()).get(CONFLITO_JORNADA)?.value;
  if (!bruto) return null;

  try {
    const lido: unknown = JSON.parse(bruto);
    if (
      typeof lido === 'object' && lido !== null &&
      'professionalId' in lido && typeof lido.professionalId === 'string' &&
      'faixas' in lido && Array.isArray(lido.faixas) &&
      'conflitos' in lido && Array.isArray(lido.conflitos)
    ) {
      return lido as unknown as JornadaEmConflito;
    }
  } catch {
    // Cookie corrompido não derruba a tela de equipe inteira.
  }
  return null;
}
