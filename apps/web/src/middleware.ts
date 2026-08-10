import { NextResponse, type NextRequest } from 'next/server';

/**
 * Faz o produto funcionar atrás de encaminhamento de porta.
 *
 * ## O defeito
 *
 * Todo formulário deste produto é uma Server Action. Antes de executar
 * qualquer uma, o Next compara o `origin` — o endereço que o navegador está
 * visitando — com o `x-forwarded-host`/`host` que chegou na requisição, e
 * aborta quando os dois diferem, porque é assim que ele barra CSRF.
 *
 * Atrás do encaminhamento de porta do Codespaces os dois **sempre** diferem: o
 * navegador está em `nome-3001.app.github.dev` e o processo recebe
 * `127.0.0.1:3001`. As páginas abrem, porque são leitura; o produto inteiro
 * para no primeiro botão. Na tela isso vira "Application error: a server-side
 * exception has occurred", com digest terminado em `@E80` — o código que o
 * Next dá a `Invalid Server Actions request.`
 *
 * ## Por que não `serverActions.allowedOrigins`
 *
 * Porque essa opção, que é a documentada para exatamente este caso, **não faz
 * nada** no `next start`: o valor é lido de `renderOpts.serverActions`, e o
 * servidor de produção nunca preenche esse campo — confira em
 * `dist/compiled/next-server/server.runtime.prod.js`, onde a palavra não
 * aparece. Configurar por lá deixaria um ajuste com cara de conserto e sem
 * efeito nenhum, que é pior do que não ter ajuste.
 *
 * Conferido na 15.5.23, e relatado desde a 14.2 (vercel/next.js#65050). Se um
 * dia a opção passar a funcionar, este arquivo pode virar duas linhas de
 * configuração — o teste ao lado é que diz se ainda faz falta.
 *
 * ## Por que isto continua barrando CSRF
 *
 * O cabeçalho só é reescrito quando o `origin` da requisição está na lista
 * resolvida na construção — o endereço deste Codespaces, ou o que
 * `WEB_ORIGENS_PERMITIDAS` declarar. Origem de fora da lista passa intacta e o
 * Next recusa como antes. Sem lista, este arquivo é um `if` que devolve na
 * primeira linha: em produção normal nada muda.
 */

/** Resolvida na construção por `next.config.mjs`; a sandbox não lê o ambiente. */
const DE_CONFIANCA = (process.env.WEB_ORIGENS_DE_CONFIANCA ?? '')
  .split(',')
  .filter((host) => host !== '');

function hostDaOrigem(origem: string | null): string | null {
  if (!origem) return null;
  try {
    return new URL(origem).host;
  } catch {
    // `origin` malformado não derruba a requisição — ele só não é de confiança.
    return null;
  }
}

export function middleware(request: NextRequest): NextResponse {
  if (DE_CONFIANCA.length === 0) return NextResponse.next();

  const host = hostDaOrigem(request.headers.get('origin'));
  if (host === null || !DE_CONFIANCA.includes(host)) return NextResponse.next();

  const cabecalhos = new Headers(request.headers);
  cabecalhos.set('x-forwarded-host', host);
  return NextResponse.next({ request: { headers: cabecalhos } });
}

export const config = {
  // Estático não tem `origin` a conferir e é o que mais chega: deixá-lo de fora
  // é o que mantém o custo disto perto de zero.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
