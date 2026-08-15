import { redirect } from 'next/navigation';
import { conectarWhatsAppNaApi } from '@/lib/admin-api';
import { lerSessaoGestor, tomarEstadoDaMeta } from '@/lib/sessao-gestor';

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
 * ## O que é conferido antes de qualquer coisa
 *
 * O `state` volta como foi, e é comparado com o que a tela guardou num cookie
 * `httpOnly`. Sem essa conferência, um link montado por terceiro faria esta
 * barbearia conectar **uma conta que não é dela**: o token de outra pessoa
 * ficaria cifrado no nosso banco, com a tela dizendo que está tudo certo.
 *
 * O cookie é lido **e apagado** na mesma chamada: um `state` vale uma vez, como
 * o código que ele acompanha — que a própria Meta expira em 30 segundos.
 */
export async function GET(requisicao: Request): Promise<Response> {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const url = new URL(requisicao.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const guardado = await tomarEstadoDaMeta();

  /**
   * Desistência não é erro, e a mensagem diz isso.
   *
   * A Meta devolve `error=access_denied` quando a pessoa fecha o fluxo no meio.
   * Tratar como falha faria a tela acusar defeito de quem só mudou de ideia.
   */
  if (!code) {
    redirect(`/admin/whatsapp?erro=${url.searchParams.get('error') ? 'desistiu' : 'sem_codigo'}`);
  }

  // Comparação simples: os dois lados são nossos e o valor é sorteado, então
  // não há segredo a proteger contra medição de tempo — o que se compara aqui
  // é um número aleatório com ele mesmo.
  if (!guardado || !state || guardado !== state) {
    redirect('/admin/whatsapp?erro=estado_invalido');
  }

  const resultado = await conectarWhatsAppNaApi(token, {
    code,
    // Os ids não vêm no redirecionamento: quem os descobre é o servidor, pelo
    // token, como no bloco 84. É o mesmo caminho que já não dependia do
    // navegador.
    numeroVisivel: null,
  });

  if (!resultado.ok) redirect(`/admin/whatsapp?erro=${resultado.code}`);
  redirect('/admin/whatsapp?feito=conectado');
}
