import { NextResponse, type NextRequest } from 'next/server';

/**
 * A política de conteúdo, com nonce por requisição.
 *
 * ## Por que ela não cabe no `next.config.mjs`
 *
 * Todo o resto cabe — `nosniff`, `X-Frame-Options`, HSTS e referrer são fixos e
 * moram lá, onde valem inclusive para `_next/static`. A CSP não: o Next injeta
 * `<script>` embutido para carregar a árvore do servidor, e uma política que
 * aceite isso precisa de `'unsafe-inline'` — que é o mesmo que não ter política
 * contra XSS. O nonce muda a cada resposta, então precisa de código por
 * requisição, e este é o único lugar do produto que roda assim.
 *
 * O Next lê o nonce **do cabeçalho da requisição** e o repete nos scripts que
 * ele mesmo escreve. Por isso a política é escrita nos dois lados: na
 * requisição, para ele encontrar; e na resposta, para o navegador cobrar.
 *
 * ## Não é componente de cliente
 *
 * Middleware é servidor, como as server actions e as páginas. A regra de zero
 * componente de cliente continua valendo, e é ela que torna esta política
 * possível: sem JavaScript nosso no navegador, não há o que liberar além do
 * que o próprio Next escreve.
 */

/**
 * Uma política, escrita uma vez, com o porquê de cada diretiva.
 *
 * `img-src` é a única larga, e é decisão de produto: a foto do corte, do
 * ambiente e do barbeiro é endereço `https://` que a barbearia digita no
 * cadastro (bloco 11). Fechar em `'self'` apagaria a página que a §5 do
 * `CLAUDE.md` diz que carrega o peso do layout.
 */
/**
 * A janela da Meta, e por que ela é **uma rota só** (bloco 83).
 *
 * O Embedded Signup roda o SDK da Meta no navegador: o script vem de
 * `connect.facebook.net`, ele conversa com `graph.facebook.com` e desenha um
 * `iframe` de `www.facebook.com` para conversar com a janela que abriu. Nada
 * disso passa por uma política de `'self'`.
 *
 * Abrir as três diretivas **globalmente** por causa de uma tela seria pagar em
 * toda página — inclusive na pública, que é anônima e indexada — por algo que
 * só existe atrás de login, e que a maior parte das barbearias usa uma vez.
 * Então a licença é por caminho, e é o único caminho do produto que a tem.
 */
const TELA_DO_SIGNUP = '/admin/whatsapp';
const META = ['https://connect.facebook.net', 'https://www.facebook.com', 'https://graph.facebook.com'];

function politica(nonce: string, comMeta: boolean): string {
  const daMeta = comMeta ? ` ${META.join(' ')}` : '';
  return [
    "default-src 'self'",
    // `strict-dynamic` para o carregador do Next puxar os próprios pedaços sem
    // que cada um precise de nonce. Navegador que não o entende cai em 'self',
    // que continua recusando script de terceiro.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${daMeta}`,
    // O produto tem seis `style={{...}}` que desenham barra de progresso a
    // partir de um número calculado no servidor. Atributo de estilo não executa
    // nada; fechá-lo custaria seis classes geradas e não fecharia buraco algum.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    // A página fala com a API **pelo servidor**. Nada sai do navegador — a
    // exceção é a tela de conexão do WhatsApp, e ela é uma só.
    `connect-src 'self'${daMeta}`,
    "font-src 'self'",
    "object-src 'none'",
    // Sem isto, uma injeção de `<base>` reescreve para onde todo link relativo
    // aponta — inclusive o `action` dos formulários do painel.
    "base-uri 'self'",
    // O formulário do painel posta para o próprio servidor de tela, sempre.
    "form-action 'self'",
    // Sem `frame-src` declarado, o padrão é `default-src 'self'` — e o SDK da
    // Meta desenha um iframe para falar com a janela que abriu.
    `frame-src 'self'${daMeta}`,
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export function middleware(requisicao: NextRequest): NextResponse {
  // `crypto` é global no runtime do middleware. O hífen sai porque o valor do
  // nonce é comparado literalmente e precisa ser do alfabeto base64.
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const csp = politica(nonce, requisicao.nextUrl.pathname === TELA_DO_SIGNUP);

  const cabecalhos = new Headers(requisicao.headers);
  cabecalhos.set('x-nonce', nonce);
  cabecalhos.set('content-security-policy', csp);

  const resposta = NextResponse.next({ request: { headers: cabecalhos } });
  resposta.headers.set('content-security-policy', csp);
  return resposta;
}

export const config = {
  /**
   * Tudo que é página, e nada do que é arquivo.
   *
   * `_next/static` sai porque aquilo é CSS e JavaScript já construído, sem
   * documento para proteger — e os cabeçalhos fixos do `next.config.mjs`
   * alcançam aquelas respostas de qualquer forma.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
