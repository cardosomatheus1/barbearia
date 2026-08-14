/**
 * A conexão ociosa vive mais que a do proxy — e não menos.
 *
 * ## O defeito clássico, e como ele apareceu aqui
 *
 * O Node fecha conexão HTTP ociosa em **5 segundos** (`server.keepAliveTimeout`
 * padrão). Um balanceador ou proxy reverso costuma segurar a dele por 60. Nessa
 * diferença mora uma corrida: o cliente escolhe uma conexão que ele acha viva,
 * o servidor já a fechou, e o pedido morre com `ECONNRESET` — que o proxy
 * traduz em **502 para o usuário**. É esporádico, some ao reproduzir e não
 * aparece em teste nenhum, porque teste não deixa conexão parada.
 *
 * Apareceu na semeadura da demonstração: o script conversa com a API, passa
 * nove segundos escrevendo o histórico direto no banco, e a chamada seguinte
 * falha com "other side closed". O `fetch` do Node não retenta, e nem deveria
 * precisar.
 *
 * ## Por que 65 e 66
 *
 * O que resolve é o servidor de origem fechar **depois** de quem está na
 * frente. 65s cobre com folga o padrão de 60s de ALB, nginx e Cloudflare.
 * `headersTimeout` precisa ser maior que `keepAliveTimeout`, senão ele é quem
 * derruba a conexão e o problema volta com outro nome — é a ordem que a
 * documentação do Node pede, e a que se esquece.
 *
 * ## Por que aqui e não no `main.ts`
 *
 * Pela mesma razão do parser de corpo cru e dos cabeçalhos de segurança: **os
 * testes montam a aplicação sem passar por aquele arquivo**. Uma configuração
 * que só existe em produção é uma configuração que ninguém testa, e esta é
 * invisível quando some — o sintoma é um 502 a cada tantas requisições, em
 * outro processo, num log que não é o nosso.
 */

/** O que este ajuste precisa de um servidor HTTP, e nada mais. */
export interface ServidorAjustavel {
  keepAliveTimeout: number;
  headersTimeout: number;
}

/** Acima dos 60s que ALB, nginx e Cloudflare usam por padrão. */
export const KEEP_ALIVE_MS = 65_000;
/** Sempre maior que o de cima, senão é ele quem fecha primeiro. */
export const HEADERS_TIMEOUT_MS = 66_000;

export function ajustarKeepAlive(servidor: ServidorAjustavel): void {
  servidor.keepAliveTimeout = KEEP_ALIVE_MS;
  servidor.headersTimeout = HEADERS_TIMEOUT_MS;
}
