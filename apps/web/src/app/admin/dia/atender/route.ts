import { NextResponse, type NextRequest } from 'next/server';
import { ehAcaoDeAtendimento } from '@barbearia/core';
import { moverAtendimento } from '@/lib/admin-api';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { destinoDoBalcao } from '@/lib/destino';
import { COOKIE_DA_VAGA, daEspera } from '@/lib/vaga';

/** Dois minutos: passou disso, o horário já pode ter sido marcado pelo site. */
const SEGUNDOS = 120;

/**
 * Mover um atendimento — por route handler, para os **nomes** atravessarem.
 *
 * ## O que isto conserta
 *
 * Cancelar abre uma vaga, e `applyAttendance` devolve, na mesma transação, quem
 * o motor casou com ela: nome, telefone e a janela que a pessoa pediu. A ação de
 * servidor não tinha como levar isso adiante — nome de cliente não vai para a
 * URL, e cookie gravado dentro de uma server action **não emite `Set-Cookie`**
 * neste app (verificado com `curl -D` no bloco 106). Então só a contagem
 * viajava, e o aviso "3 pessoas esperavam por um horário assim · ver quem é"
 * levava à lista de espera inteira da unidade — seis pessoas, duas das quais nem
 * cabiam no horário que abriu.
 *
 * A recepcionista com o telefone na mão refazia na cabeça o cruzamento que o
 * produto já tinha feito. Era a §6 pergunta 6 e a convenção de que a contagem
 * que a tela promete sai do mesmo filtro que o botão abre.
 *
 * ## Por que o cookie, e por que curto
 *
 * O que atravessa é dado pessoal — nome e telefone de quem espera. Ele vai por
 * cookie `httpOnly`, `sameSite=strict`, dois minutos, exatamente como a senha de
 * primeiro acesso e a resposta do agente: fora do histórico do navegador, fora
 * do log do servidor, e some sozinho. Dois minutos é o tempo em que a informação
 * ainda serve — passou disso, o horário já pode ter sido marcado pelo site, que
 * é a razão de o aviso existir.
 *
 * O caminho é `/admin` porque o destino varia — o balcão volta para o painel do
 * dia e o barbeiro para o dele. É o mesmo caminho da sessão do gestor, que já
 * carrega o token; um caminho mais estreito exigiria um cookie por destino.
 */
export async function POST(requisicao: NextRequest): Promise<NextResponse> {
  const form = await requisicao.formData();
  const voltar = destinoDoBalcao(String(form.get('voltar') ?? ''));
  const id = String(form.get('id') ?? '');
  const acao = String(form.get('action') ?? '');

  const separador = voltar.includes('?') ? '&' : '?';
  const desvio = (para: string) =>
    new NextResponse(null, { status: 303, headers: { location: para } });

  const token = await lerSessaoGestor();
  if (!token) return desvio('/admin/entrar');

  if (!ehAcaoDeAtendimento(acao)) {
    return desvio(`${voltar}${separador}erro=request_failed`);
  }

  const resultado = await moverAtendimento(token, id, acao);
  if (!resultado.ok) {
    return desvio(`${voltar}${separador}erro=${encodeURIComponent(resultado.code)}`);
  }

  const resposta = desvio(voltar);
  const esperando = resultado.dados.esperando;

  /**
   * O cookie é escrito **sempre**, inclusive vazio.
   *
   * Só gravar quando há candidato deixaria o cookie do cancelamento anterior de
   * pé por dois minutos: o toque seguinte — concluir, confirmar, marcar falta —
   * voltaria para a tela com o aviso de uma vaga que não é dele. Aviso que
   * aparece sobre o gesto errado é aviso que se aprende a ignorar.
   */
  resposta.cookies.set({
    name: COOKIE_DA_VAGA,
    value: esperando.length > 0 ? JSON.stringify(daEspera(esperando)) : '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/admin',
    maxAge: esperando.length > 0 ? SEGUNDOS : 0,
  });
  return resposta;
}
