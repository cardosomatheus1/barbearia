import { NextResponse, type NextRequest } from 'next/server';
import { conversarComOAgente } from '@/lib/api';

/**
 * A pergunta do cliente vai por `POST`, e a resposta volta por cookie curto.
 *
 * ## Por que a pergunta não pode ir para a URL
 *
 * O assistente do gestor põe a pergunta em `?p=`, e ali está certo: aquela tela
 * é `noindex`, fica atrás de sessão, e o texto é uma métrica ("faturamento de
 * agosto"). Aqui é outra coisa. Quem escreve é o cliente final, numa página
 * pública, e nada impede a frase de ser *"meu nome é Ana, meu telefone é tal,
 * consigo cortar amanhã?"* — é o mesmo texto livre por que `reception_gaps`
 * ganhou prazo de guarda.
 *
 * Na URL essa frase fica no histórico do navegador — que num celular emprestado
 * é de outra pessoa — e no autocompletar da barra. É o precedente de `?erro=`
 * não nomear o mecanismo do score, levado até o fim.
 *
 * ## Por que um route handler, e não uma server action
 *
 * Foi tentado com action, e **não funciona**: o cookie é gravado no `jar` do
 * servidor, a ação roda até o fim, e nenhum `Set-Cookie` sai na resposta —
 * verificado com `curl -D` contra o `next start` deste repositório. Um route
 * handler devolve uma `NextResponse` de verdade, e ali o cookie é HTTP comum.
 *
 * O formulário é `method="post"` puro: funciona sem JavaScript, como o resto do
 * produto, e a CSP já permite `form-action 'self'`.
 *
 * ## POST-redirect-GET
 *
 * O `303` é o que faz o F5 não reenviar a pergunta — e o que devolve a pessoa
 * ao endereço limpo, sem nada do que ela escreveu na barra.
 */

/** O mesmo teto da borda da API: cortar aqui evita um erro sem explicação. */
const MAXIMO = 500;

/** Dois minutos, como o cookie da senha de primeiro acesso. */
const SEGUNDOS = 120;

export async function POST(
  requisicao: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;

  /**
   * `Location` **relativo**, e o motivo custou uma depuração inteira.
   *
   * `NextResponse.redirect` exige endereço absoluto, e o que ele monta a partir
   * de `requisicao.url` é a origem **interna** do servidor: aqui saiu
   * `http://localhost:3011` enquanto o navegador estava em `http://127.0.0.1:3011`.
   * São hosts diferentes, e cookie é por host — o `Set-Cookie` ia para um pote e
   * o `GET` seguinte lia outro. A tela mostrava o estado vazio depois de uma
   * resposta que existia.
   *
   * Em produção isso seria pior que um teste vermelho: atrás do Caddy, a origem
   * interna é um endereço que o cliente não alcança, e o redirecionamento
   * levaria a pessoa para fora do site.
   *
   * `Location` relativo é HTTP válido desde a RFC 7231 e resolve os dois casos:
   * o navegador o resolve contra a origem em que **ele** está.
   */
  const destino = `/${slug}/conversar`;

  const form = await requisicao.formData();
  const texto = String(form.get('texto') ?? '').trim().slice(0, MAXIMO);

  const resposta = new NextResponse(null, {
    status: 303,
    headers: { location: destino },
  });
  if (!texto) return resposta;

  const dita = await conversarComOAgente(slug, texto);

  /**
   * A pergunta volta junto da resposta, e pelo mesmo cookie.
   *
   * Sem ela a tela mostra três horários sem dizer a que pergunta eles respondem
   * — e quem escreveu já não lembra do que digitou, porque a caixa foi limpa
   * pela navegação.
   */
  resposta.cookies.set({
    name: 'conversa',
    value: JSON.stringify({ texto, resposta: dita ?? { entendi: false, escalar: true } }),
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    // Só esta tela: o cookie não acompanha a navegação pelo resto do site.
    path: destino,
    maxAge: SEGUNDOS,
  });
  return resposta;
}
