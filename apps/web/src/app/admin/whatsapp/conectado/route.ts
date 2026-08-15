import { redirect } from 'next/navigation';
import { conectarWhatsAppNaApi } from '@/lib/admin-api';
import { VOLTA_DA_META } from '@/lib/meta';
import {
  guardarCodigoDaMeta,
  lerSessaoGestor,
  tomarCodigoDaMeta,
  tomarEstadoDaMeta,
} from '@/lib/sessao-gestor';

/**
 * A volta da Meta, no fluxo de redirecionamento (bloco 86).
 *
 * ## Por que uma rota, e não JavaScript
 *
 * O SDK da Meta não funciona no celular: a janela vira uma aba, o callback
 * nunca dispara, e a nossa tela fica igual enquanto a Meta diz que conectou.
 * O redirecionamento é navegação comum — a pessoa volta para cá com
 * `?code=&state=`, e o servidor faz o resto.
 *
 * ## Por que ela roda duas vezes
 *
 * A sessão do gestor é `sameSite: 'strict'`, e por isso **não acompanha a volta
 * da Meta**: quem iniciou aquela navegação foi `facebook.com`. Redirecionar do
 * servidor não conserta, porque o navegador julga a cadeia inteira pela origem
 * que a começou — em produção isso apareceu como o produto deslogando sozinho,
 * com a tela de login sendo mostrada a quem estava logado.
 *
 * Então a primeira passada não pede sessão: ela confere o `state`, guarda o
 * código num cookie de dois minutos e devolve uma página nossa. A navegação
 * seguinte parte **daqui**, é de mesma origem, e aí o cookie `strict` viaja.
 *
 * A alternativa era afrouxar a sessão do painel para `lax`, o que trocaria uma
 * conexão de WhatsApp por CSRF em catálogo, equipe e preço.
 *
 * ## O que é conferido antes de qualquer coisa
 *
 * O `state` volta como foi, e é comparado com o que a tela guardou num cookie
 * `httpOnly`. Sem essa conferência, um link montado por terceiro faria esta
 * barbearia conectar **uma conta que não é dela**: o token de outra pessoa
 * ficaria cifrado no nosso banco, com a tela dizendo que está tudo certo.
 *
 * Os dois cookies são lidos **e apagados** na mesma chamada: `state` e código
 * valem uma vez cada.
 */

const AQUI = '/admin/whatsapp/conectado';
const TELA = '/admin/whatsapp';

/**
 * A página de passagem, que existe só para a navegação seguinte partir daqui.
 *
 * Ela é escrita à mão, fora do design system, porque não é uma tela: é o
 * documento mínimo que devolve o site de origem para nós. O fundo é o do tema
 * para não haver piscada branca, e o link existe porque `meta refresh` é do
 * navegador — se ele estiver desligado, a pessoa continua tendo como seguir,
 * com alvo de toque de 44px como qualquer outro do produto.
 *
 * Os dois argumentos são **literais deste arquivo** em todas as chamadas, e
 * precisam continuar sendo: nada aqui escapa HTML, e o dia em que alguém passar
 * um pedaço da query string adiante é o dia em que esta função vira XSS
 * refletido — numa rota que a Meta manda o navegador abrir.
 */
function passagem(destino: string, aviso: string): Response {
  const html = [
    '<!doctype html>',
    '<html lang="pt-BR"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    '<meta http-equiv="refresh" content="0; url=' + destino + '">',
    '<title>Voltando ao painel</title>',
    '<style>',
    'body{margin:0;min-height:100vh;display:flex;align-items:center;',
    'justify-content:center;background:#071018;color:#F7F4EE;',
    'font-family:system-ui,sans-serif;padding:24px;text-align:center}',
    'p{margin:0 0 16px;color:#A6B0B6;font-size:15px;line-height:1.5}',
    'a{display:inline-flex;align-items:center;justify-content:center;',
    'min-height:44px;padding:0 20px;border-radius:8px;background:#E1C39D;',
    'color:#0A1620;font-weight:600;text-decoration:none}',
    '</style></head><body><main>',
    '<p>' + aviso + '</p>',
    '<a href="' + destino + '">Continuar</a>',
    '</main></body></html>',
  ].join('');

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function GET(requisicao: Request): Promise<Response> {
  const url = new URL(requisicao.url);
  const code = url.searchParams.get('code');

  // --- Segunda passada: a navegação veio da nossa própria página -------------
  if (!code) {
    const guardado = await tomarCodigoDaMeta();

    /**
     * Desistência não é erro, e a mensagem diz isso.
     *
     * A Meta devolve `error=access_denied` quando a pessoa fecha o fluxo no
     * meio. Tratar como falha faria a tela acusar defeito de quem só mudou de
     * ideia.
     */
    if (!guardado) {
      const motivo = url.searchParams.get('error') ? 'desistiu' : 'sem_codigo';
      return passagem(TELA + '?erro=' + motivo, 'Voltando ao painel…');
    }

    const token = await lerSessaoGestor();
    if (!token) redirect('/admin/entrar');

    const resultado = await conectarWhatsAppNaApi(token, {
      code: guardado,
      // O mesmo endereço da ida, da mesma constante, porque a Meta compara os
      // dois byte a byte — e a divergência só falharia aqui, depois de a pessoa
      // já ter autorizado do outro lado.
      redirectUri: VOLTA_DA_META,
      // Os ids não vêm no redirecionamento: quem os descobre é o servidor, pelo
      // token, como no bloco 84. É o mesmo caminho que já não dependia do
      // navegador.
      numeroVisivel: null,
    });

    if (!resultado.ok) redirect(TELA + '?erro=' + resultado.code);
    redirect(TELA + '?feito=conectado');
  }

  // --- Primeira passada: chegou da Meta, e ainda sem sessão ------------------
  const state = url.searchParams.get('state');
  const guardado = await tomarEstadoDaMeta();

  // Comparação simples: os dois lados são nossos e o valor é sorteado, então
  // não há segredo a proteger contra medição de tempo — o que se compara aqui
  // é um número aleatório com ele mesmo.
  if (!guardado || !state || guardado !== state) {
    return passagem(TELA + '?erro=estado_invalido', 'Voltando ao painel…');
  }

  await guardarCodigoDaMeta(code);
  return passagem(AQUI, 'Conectando o WhatsApp…');
}
