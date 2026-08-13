import { NextResponse } from 'next/server';
import { COOKIE_DA_ORIGEM, VALIDADE_DA_ORIGEM_DIAS } from '@barbearia/core';

/**
 * A porta do marketplace para a página da barbearia (bloco 72, SPEC §5.2).
 *
 * ## Por que existe uma porta, em vez de um link direto
 *
 * A comissão do marketplace incide **só sobre cliente novo trazido pela
 * plataforma**, e isso exige que o agendamento nasça com
 * `source = 'marketplace'`. Sem um lugar que registre a passagem, essa origem
 * seria um campo que ninguém preenche — o defeito que este repositório já
 * cometeu com `blocks` e com o quarto termo do sinal — e a promessa comercial
 * inteira do bloco viraria uma tabela vazia.
 *
 * Um parâmetro na URL (`/{slug}?de=vitrine`) não serve: ele some no primeiro
 * clique dentro da página, e a pessoa escolhe serviço, profissional, dia e hora
 * antes de chegar ao formulário. O carimbo precisa sobreviver a esse caminho.
 *
 * ## A porta confere de onde a navegação veio, e essa checagem não é enfeite
 *
 * Sem ela, qualquer terceiro publicava este endereço num anúncio, num QR ou
 * dentro de um `<img>` e carimbava o navegador de quem nunca viu a busca: a
 * pessoa agendava depois pela página da própria barbearia, e a casa recebia
 * fatura de comissão por um cliente que ela mesma trouxe. Achado da
 * `/security-review` deste bloco, e é o ataque mais barato que ele tinha.
 *
 * `Sec-Fetch-Site` e `Sec-Fetch-Dest` são o que separam "a pessoa clicou no
 * card" de "alguém embutiu isto numa página": navegação de documento, da mesma
 * origem. O `Referer` entra como segunda condição para os navegadores que não
 * mandam `Sec-Fetch-*`, e quem não passa não recebe erro — vai para a busca,
 * porque quem chegou aqui é um visitante e não um invasor a ser instruído.
 *
 * ## Esta camada não assina nada
 *
 * O carimbo é um HMAC emitido pela **API**, que sai junto de cada card da
 * busca, e conferido por ela na borda do agendamento. Aqui ele só é guardado —
 * a seta vai de `web` para `api`, e trazer um pacote com acesso a banco para
 * dentro do servidor de páginas seria abri-la ao contrário por dez linhas.
 *
 * ## Cookie `httpOnly`, por barbearia no nome **e** no caminho
 *
 * É o desenho da sessão do cliente desde o bloco 5. Um cookie único faria a
 * visita ao marketplace carimbar como "trazido pela plataforma" o agendamento
 * que a pessoa fez noutra barbearia, pelo link que ela já tinha — e a segunda
 * casa pagaria comissão por um cliente que era dela. O slug entra também na
 * assinatura, pelo mesmo motivo.
 */

const SLUG_VALIDO = /^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/;

/** Se a navegação veio de dentro da própria busca. */
function veioDaBusca(pedido: Request): boolean {
  const site = pedido.headers.get('sec-fetch-site');
  const destino = pedido.headers.get('sec-fetch-dest');

  if (site !== null) {
    // Navegador moderno: a resposta é definitiva nos dois sentidos.
    if (site !== 'same-origin') return false;
    if (destino !== null && destino !== 'document') return false;
  }

  const referer = pedido.headers.get('referer');
  if (!referer) return false;
  try {
    const origem = new URL(referer);
    const aqui = new URL(pedido.url);
    return origem.origin === aqui.origin && origem.pathname.startsWith('/buscar');
  } catch {
    return false;
  }
}

export async function GET(
  pedido: Request,
  contexto: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await contexto.params;

  /**
   * O slug entra no caminho de um cookie e num `redirect`, então ele é validado
   * aqui e não confiado: o formato é o mesmo que `tenant_slugs` aceita desde o
   * bloco 1.
   */
  if (!SLUG_VALIDO.test(slug)) {
    return NextResponse.redirect(new URL('/buscar', pedido.url));
  }

  // Sem o carimbo: a pessoa chega na barbearia do mesmo jeito, e o agendamento
  // dela nasce como o de qualquer visitante da página pública.
  if (!veioDaBusca(pedido)) {
    return NextResponse.redirect(new URL(`/${slug}`, pedido.url));
  }

  // Sem carimbo no link não há o que guardar. Teto de tamanho porque o valor
  // vai para um cookie, e cookie sem teto é armazenamento gratuito.
  const carimbo = new URL(pedido.url).searchParams.get('c') ?? '';
  if (!carimbo || carimbo.length > 200) {
    return NextResponse.redirect(new URL(`/${slug}`, pedido.url));
  }

  const resposta = NextResponse.redirect(new URL(`/${slug}`, pedido.url));
  resposta.cookies.set({
    name: `${COOKIE_DA_ORIGEM}_${slug}`,
    value: carimbo,
    httpOnly: true,
    // A convenção de `sessao.ts`: em produção o cookie não sai por http.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: `/${slug}`,
    maxAge: VALIDADE_DA_ORIGEM_DIAS * 24 * 3600,
  });
  return resposta;
}
