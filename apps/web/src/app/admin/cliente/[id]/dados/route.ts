import { NextResponse } from 'next/server';
import { exportarDadosDoCliente } from '@/lib/admin-api';
import { lerSessaoGestor } from '@/lib/sessao-gestor';

/**
 * A cópia dos dados do titular, para baixar (bloco 31, SPEC §1.8.4).
 *
 * ## Por que uma rota e não um botão apontando para a API
 *
 * O token do painel é um cookie `httpOnly` de caminho `/admin`: o navegador não
 * o lê e não monta o `Authorization` que a API exige. Um link direto para a API
 * chegaria sem credencial. O servidor de tela faz a ponte — é a primeira rota
 * deste tipo no produto, e existe por esse motivo e não por gosto.
 *
 * ## Por que isto não é um buraco de CSRF
 *
 * O cookie é `sameSite=strict`: nenhuma página de outro site consegue provocar
 * esta requisição com a credencial junto. E o método é `GET` sobre uma leitura
 * — não muda estado além da linha de auditoria que a própria API grava, que é o
 * registro de que a exportação aconteceu.
 *
 * A permissão é conferida onde ela mora, na API (`customers.export`, que exige
 * papel com o direito). Aqui não se decide nada: 403 da API vira 403 aqui.
 */
export async function GET(
  _requisicao: Request,
  contexto: { params: Promise<{ id: string }> },
): Promise<Response> {
  const token = await lerSessaoGestor();
  if (!token) return new NextResponse('Entre no painel.', { status: 401 });

  const { id } = await contexto.params;
  const resultado = await exportarDadosDoCliente(token, id);

  if (!resultado.ok) {
    /**
     * O motivo chega em texto porque um download não tem tela para desviar.
     *
     * A rota exige `finance.view` junto, e o segundo fator é derivado dela —
     * então "confirme o código" é a recusa mais provável de quem tem todas as
     * permissões e passou trinta minutos no balcão. Devolver 403 seco aqui
     * mandaria essa pessoa procurar o dono para liberar algo que ela já pode.
     */
    const explicacao: Record<string, { status: number; texto: string }> = {
      forbidden: {
        status: 403,
        texto: 'Sua conta não exporta os dados de um cliente.',
      },
      mfa_required: {
        status: 403,
        texto:
          'Confirme o código do segundo fator e tente de novo. ' +
          'Ele fica em Segurança, no painel.',
      },
      mfa_setup_required: {
        status: 403,
        texto: 'Ative o segundo fator em Segurança antes de exportar dados de cliente.',
      },
    };
    const saida = explicacao[resultado.code] ?? {
      status: 404,
      texto: 'Não foi possível gerar a cópia dos dados.',
    };
    return new NextResponse(saida.texto, {
      status: saida.status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  /**
   * `Content-Disposition` com nome fixo por cliente.
   *
   * O nome do arquivo **não** leva o nome da pessoa: o arquivo desce para a
   * pasta de downloads de um computador de balcão, que é compartilhado, e um
   * nome com "joao-da-silva" dentro dele espalha o dado antes de alguém abrir.
   */
  return new NextResponse(JSON.stringify(resultado.dados, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="dados-do-cliente-${id}.json"`,
      // Cópia de dado pessoal não fica em cache de disco nem de proxy.
      'cache-control': 'no-store, private',
    },
  });
}
