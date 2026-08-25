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
 * ## Middleware continua sendo servidor
 *
 * O admin possui ilhas client-side pequenas (R5/V11/R9), todas servidas pelo
 * próprio domínio. A CSP continua fechada para script de terceiro: o nonce
 * cobre o bootstrap inline do Next e `script-src 'self'` cobre os chunks dessas
 * ilhas, sem abrir `unsafe-inline` para JavaScript.
 */

/**
 * Uma política, escrita uma vez, com o porquê de cada diretiva.
 *
 * `img-src` ainda aceita `https:` apenas para imagens legadas cadastradas antes
 * do R9 e para conteúdo externo já existente. Novas fotos públicas entram pelo
 * armazenamento `/media/...` do próprio Barberdock; quando as legadas forem
 * migradas, essa exceção pode ser reavaliada.
 */
/**
 * A licença da Meta saiu no bloco 86, e o motivo vale registrar.
 *
 * Ela existia porque a conexão do WhatsApp rodava o SDK da Meta no navegador —
 * script de terceiro, chamada a `graph.facebook.com` e um `iframe`. Era uma
 * exceção de política numa rota só, com teste que impedia alguém de abri-la
 * globalmente.
 *
 * O SDK **não funcionava no celular**: a janela virava uma aba, o callback
 * nunca disparava, e a tela ficava igual. Trocado por redirecionamento — que é
 * navegação comum —, a licença da Meta deixou de ter razão de existir.
 *
 * A única exceção atual é o Turnstile na criação de conta anônima. Ela é
 * deliberadamente limitada a essa rota; as superfícies públicas de agenda
 * continuam server-only e sem script de terceiro.
 */
function politica(nonce: string, pathname: string): string {
  const turnstile = pathname === '/admin/criar-conta';
  return [
    "default-src 'self'",
    // `strict-dynamic` permite que o script do Turnstile, autenticado pelo mesmo
    // nonce do Next, carregue os pedaços próprios sem abrir terceiros no resto do site.
    turnstile
      ? `script-src 'self' https://challenges.cloudflare.com 'nonce-${nonce}' 'strict-dynamic'`
      : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // O produto tem seis `style={{...}}` que desenham barra de progresso a
    // partir de um número calculado no servidor. Atributo de estilo não executa
    // nada; fechá-lo custaria seis classes geradas e não fecharia buraco algum.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    // A página fala com a API **pelo servidor**. Nada sai do navegador, e desde
    // o bloco 86 não há exceção: a conexão do WhatsApp virou redirecionamento.
    turnstile ? "connect-src 'self' https://challenges.cloudflare.com" : "connect-src 'self'",
    "font-src 'self'",
    turnstile ? "frame-src https://challenges.cloudflare.com" : "frame-src 'self'",
    "object-src 'none'",
    // Sem isto, uma injeção de `<base>` reescreve para onde todo link relativo
    // aponta — inclusive o `action` dos formulários do painel.
    "base-uri 'self'",
    // O formulário do painel posta para o próprio servidor de tela, sempre.
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export function middleware(requisicao: NextRequest): NextResponse {
  // `crypto` é global no runtime do middleware. O hífen sai porque o valor do
  // nonce é comparado literalmente e precisa ser do alfabeto base64.
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const csp = politica(nonce, requisicao.nextUrl.pathname);

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
