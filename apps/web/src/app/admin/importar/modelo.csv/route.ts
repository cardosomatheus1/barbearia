import { csvDoModelo } from '@barbearia/core';

/**
 * A planilha modelo da importação (bloco 83).
 *
 * ## Por que uma rota, e não um link `data:`
 *
 * A política de conteúdo deste produto é `default-src 'self'`, e navegador
 * moderno recusa navegação de topo para `data:` de qualquer forma. Uma rota que
 * responde com `Content-Disposition: attachment` funciona em todo navegador,
 * não pede JavaScript nenhum e não abre exceção na política.
 *
 * ## Por que o conteúdo é derivado
 *
 * `csvDoModelo` monta o cabeçalho a partir do **mesmo** mapa de aliases que a
 * detecção usa. Um modelo escrito à mão poderia divergir do parser — e aí o
 * produto entregaria à barbearia um arquivo que ele próprio recusa, que é o
 * pior desfecho possível para uma tela que existe para tirar dúvida.
 *
 * Sem sessão de propósito: o arquivo não tem dado de ninguém — é cabeçalho e
 * duas linhas inventadas. Exigir login aqui só faria o link falhar para quem
 * abriu numa aba nova.
 */
export function GET(): Response {
  return new Response(csvDoModelo(), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="modelo-clientes.csv"',
      // O modelo muda quando o parser ganha alias novo, e é barato de refazer.
      'cache-control': 'no-store',
    },
  });
}
