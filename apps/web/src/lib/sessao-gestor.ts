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

/**
 * Onde a senha pode aparecer.
 *
 * Duas telas criam conta: a de equipe (recepção, gerência) e a de profissionais
 * (o convite do barbeiro). O caminho continua restrito — não é `/admin` — para
 * que o cookie não acompanhe a navegação pelo resto do painel.
 */
export type TelaDaSenha = 'equipe' | 'profissionais' | 'chaves' | 'webhooks';

const CAMINHO_DA_TELA: Record<TelaDaSenha, string> = {
  equipe: CAMINHO_EQUIPE,
  profissionais: '/admin/profissionais',
  // A chave de API sai por aqui pelo mesmo motivo da senha (bloco 78): ela
  // existe uma vez, e um parâmetro de consulta ficaria no histórico do
  // navegador, no autocompletar e em qualquer referrer.
  chaves: '/admin/chaves',
  // O segredo compartilhado do webhook sai pelo mesmo caminho, e pela mesma
  // razão: ele existe uma vez.
  webhooks: '/admin/webhooks',
};

export async function guardarSenhaDeUmaVez(
  nome: string,
  senha: string,
  tela: TelaDaSenha = 'equipe',
): Promise<void> {
  const jar = await cookies();
  jar.set(SENHA_NOVA, JSON.stringify({ nome, senha }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: CAMINHO_DA_TELA[tela],
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

/**
 * O link de acompanhamento, do servidor para a tela seguinte.
 *
 * Mesmo motivo do cookie da senha: o token é credencial ao portador — quem o
 * tiver vê a posição daquela pessoa — e a URL do painel para no histórico do
 * balcão, que é máquina compartilhada, e no `Referer` de toda requisição
 * seguinte.
 *
 * Vida curta porque a recepção entrega o link na hora: mostra o QR ou manda por
 * WhatsApp e pronto. Se perder, não há como reemitir — o banco só guarda o
 * hash, e gerar outro invalidaria o que a pessoa já está olhando.
 */
const LINK_FILA = 'link-fila';
const CAMINHO_FILA = '/admin/fila';
const SEGUNDOS_DO_LINK = 180;

export async function guardarLinkDaFila(nome: string, token: string): Promise<void> {
  const jar = await cookies();
  jar.set(LINK_FILA, JSON.stringify({ nome, token }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: CAMINHO_FILA,
    maxAge: SEGUNDOS_DO_LINK,
  });
}

export async function lerLinkDaFila(): Promise<{ nome: string; token: string } | null> {
  const bruto = (await cookies()).get(LINK_FILA)?.value;
  if (!bruto) return null;

  try {
    const lido: unknown = JSON.parse(bruto);
    if (
      typeof lido === 'object' && lido !== null &&
      'nome' in lido && 'token' in lido &&
      typeof lido.nome === 'string' && typeof lido.token === 'string'
    ) {
      return { nome: lido.nome, token: lido.token };
    }
  } catch {
    // Cookie corrompido não derruba a tela da fila inteira.
  }
  return null;
}

/**
 * A exceção recusada e quem ficaria de fora, do servidor para a tela seguinte.
 *
 * Mesmo motivo dos outros dois cookies de vida curta: a lista de conflitos traz
 * **nome de cliente**, e a URL do painel para no histórico do balcão — máquina
 * compartilhada — e no `Referer` de toda requisição seguinte.
 */
const CONFLITO_AGENDA = 'agenda-conflito';
const CAMINHO_AGENDA = '/admin/agenda';

export interface ExcecaoEmConflito {
  readonly kind: string;
  readonly date: string;
  readonly startMinute?: number | null;
  readonly endMinute?: number | null;
  readonly professionalId?: string;
  readonly reason?: string;
  readonly conflitos: readonly {
    appointmentId: string;
    start: string;
    customerName: string | null;
    professionalName: string;
  }[];
}

export async function guardarConflitoDaAgenda(dados: ExcecaoEmConflito): Promise<void> {
  const jar = await cookies();
  jar.set(CONFLITO_AGENDA, JSON.stringify(dados), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: CAMINHO_AGENDA,
    maxAge: SEGUNDOS_PARA_CONFIRMAR,
  });
}

export async function lerConflitoDaAgenda(): Promise<ExcecaoEmConflito | null> {
  const bruto = (await cookies()).get(CONFLITO_AGENDA)?.value;
  if (!bruto) return null;

  try {
    const lido: unknown = JSON.parse(bruto);
    if (
      typeof lido === 'object' && lido !== null &&
      'kind' in lido && typeof lido.kind === 'string' &&
      'date' in lido && typeof lido.date === 'string' &&
      'conflitos' in lido && Array.isArray(lido.conflitos)
    ) {
      return lido as unknown as ExcecaoEmConflito;
    }
  } catch {
    // Cookie corrompido não derruba a agenda inteira.
  }
  return null;
}

/**
 * O segredo do segundo fator e os códigos de recuperação, do servidor para a
 * tela seguinte.
 *
 * Mesmo mecanismo do cookie de senha e pelo mesmo motivo, agravado: o segredo
 * TOTP é a chave que gera todos os códigos futuros, e os de recuperação valem
 * como segundo fator inteiro. Nenhum dos dois pode ir na URL — ela fica no
 * histórico do navegador do balcão, que é máquina compartilhada, e em log de
 * proxy.
 *
 * Caminho restrito a `/admin/seguranca` e vida de dois minutos: tempo de ler o
 * QR Code e anotar os oito códigos, não mais.
 */
const SEGREDO_MFA = 'mfa-segredo';
const CAMINHO_SEGURANCA = '/admin/seguranca';

export interface SegredoDoSegundoFator {
  readonly segredoBase32: string;
  readonly uri: string;
}

export async function guardarSegredoDoMfa(dados: SegredoDoSegundoFator): Promise<void> {
  const jar = await cookies();
  jar.set(SEGREDO_MFA, JSON.stringify(dados), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: CAMINHO_SEGURANCA,
    maxAge: SEGUNDOS_NA_TELA,
  });
}

export async function lerSegredoDoMfa(): Promise<SegredoDoSegundoFator | null> {
  const bruto = (await cookies()).get(SEGREDO_MFA)?.value;
  if (!bruto) return null;

  try {
    const lido: unknown = JSON.parse(bruto);
    if (
      typeof lido === 'object' && lido !== null &&
      'segredoBase32' in lido && typeof lido.segredoBase32 === 'string' &&
      'uri' in lido && typeof lido.uri === 'string'
    ) {
      return { segredoBase32: lido.segredoBase32, uri: lido.uri };
    }
  } catch {
    // Cookie corrompido não derruba a tela de segurança.
  }
  return null;
}

const CODIGOS_MFA = 'mfa-recuperacao';

export async function guardarCodigosDeRecuperacao(codigos: readonly string[]): Promise<void> {
  const jar = await cookies();
  jar.set(CODIGOS_MFA, JSON.stringify(codigos), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: CAMINHO_SEGURANCA,
    maxAge: SEGUNDOS_NA_TELA,
  });
}

export async function lerCodigosDeRecuperacao(): Promise<string[] | null> {
  const bruto = (await cookies()).get(CODIGOS_MFA)?.value;
  if (!bruto) return null;

  try {
    const lido: unknown = JSON.parse(bruto);
    if (Array.isArray(lido) && lido.every((c) => typeof c === 'string')) return lido as string[];
  } catch {
    // Cookie corrompido não derruba a tela de segurança.
  }
  return null;
}

/**
 * O `state` da conexão com a Meta, guardado entre a ida e a volta (bloco 86).
 *
 * O fluxo de redirecionamento manda a pessoa para a Meta e ela volta para uma
 * rota nossa com `?code=&state=`. Sem conferir o `state`, um link montado por
 * terceiro faria esta barbearia conectar **uma conta que não é dela** — e o
 * token de outra pessoa ficaria cifrado no nosso banco, com a tela dizendo que
 * está tudo certo.
 *
 * `httpOnly` mantém fora do JavaScript. `sameSite: 'lax'` e não `strict`, e é a
 * diferença que importa aqui: a volta é uma navegação vinda de outro site, e
 * `strict` não manda o cookie nesse caso — o `state` chegaria vazio e a conexão
 * seria recusada sempre. O caminho restrito faz o resto do trabalho.
 */
const ESTADO_DA_META = 'barbearia_meta_state';
const SEGUNDOS_DA_CONEXAO = 15 * 60;

export async function guardarEstadoDaMeta(estado: string): Promise<void> {
  const jar = await cookies();
  jar.set(ESTADO_DA_META, estado, {
    httpOnly: true,
    path: '/admin/whatsapp',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    // Quinze minutos: é quanto leva preencher o fluxo da Meta sem pressa, e
    // curto o bastante para um cookie esquecido não valer nada amanhã.
    maxAge: SEGUNDOS_DA_CONEXAO,
  });
}

/** Lê e **apaga**: um `state` vale uma vez, como o código que ele acompanha. */
export async function tomarEstadoDaMeta(): Promise<string | null> {
  const jar = await cookies();
  const valor = jar.get(ESTADO_DA_META)?.value ?? null;
  jar.set(ESTADO_DA_META, '', { httpOnly: true, path: '/admin/whatsapp', maxAge: 0 });
  return valor;
}
