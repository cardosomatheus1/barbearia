/**
 * Os cabeçalhos de segurança da API.
 *
 * ## Por que middleware, e não interceptor
 *
 * O interceptor global do Nest só roda em rota que existe. Um `GET /naoexiste`
 * cai no 404 do Express sem passar por nenhum, e uma recusa de guarda sobe pelo
 * filtro de exceção — as duas respostas sairiam sem cabeçalho nenhum, que é
 * justamente onde um atacante procura. Middleware roda antes do roteamento e
 * cobre as três saídas: resposta, recusa e rota inexistente. Há teste que
 * confere as três.
 *
 * ## Por que aqui e não no `main.ts`
 *
 * Pelo mesmo motivo que o parser de corpo cru saiu de lá: **os testes montam a
 * aplicação sem passar por aquele arquivo**. Configuração que só vale em
 * produção é configuração que ninguém testa — e cabeçalho de segurança some sem
 * nada quebrar, que é o pior formato possível.
 *
 * ## Por que escrito à mão e não `helmet`
 *
 * São seis linhas de `setHeader` e um conjunto que precisa ser lido e
 * defendido um a um. É o precedente do `scrypt` do `node:crypto`: dependência
 * nova entra com motivo, e "põe cabeçalho" não é motivo.
 */

/** O mínimo do que um `res` do Express precisa oferecer aqui. */
interface Resposta {
  setHeader(nome: string, valor: string): void;
}

/**
 * O conjunto, com o porquê de cada um.
 *
 * Exportado para o teste comparar contra a resposta de verdade em vez de
 * repetir a lista ao lado — lista repetida é a que passa a divergir.
 */
export const CABECALHOS_DA_API: Readonly<Record<string, string>> = {
  /**
   * A API devolve **só JSON**, então a política pode ser a mais fechada que
   * existe: nada carrega, nada embute, nada executa. Uma resposta de erro que
   * ecoasse HTML deixaria de ser explorável aqui.
   */
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  /** Resposta de API não é documento; ninguém a põe num quadro. */
  'x-frame-options': 'DENY',
  /** Sem adivinhação de tipo: `application/json` é o que é. */
  'x-content-type-options': 'nosniff',
  /**
   * Nenhum referrer, nunca.
   *
   * As URLs desta API carregam id de cliente, de comanda e de barbearia. É a
   * mesma razão pela qual o código de recusa por score não nomeia o mecanismo
   * na URL: o que vai no referrer sai da nossa mão.
   */
  'referrer-policy': 'no-referrer',
  /**
   * HSTS sem condição de ambiente.
   *
   * O navegador **ignora** este cabeçalho quando a resposta não veio por TLS
   * (RFC 6797 §8.1), então mandá-lo sempre não quebra desenvolvimento em
   * `http://` — e não depende de uma variável estar certa no dia do deploy, que
   * é como um cabeçalho de segurança some sem ninguém notar. Um ano, com
   * subdomínios: o primeiro acesso é justamente o que o `secure` do cookie não
   * cobre.
   */
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  /**
   * Resposta de API não é recurso para outra origem embutir.
   *
   * O painel e a página pública falam com a API **do servidor**, não do
   * navegador — não há componente de cliente neste produto —, então fechar isto
   * não tira nada de ninguém.
   */
  'cross-origin-resource-policy': 'same-origin',
};

export function cabecalhosDeSeguranca(
  _requisicao: unknown,
  resposta: Resposta,
  seguir: () => void,
): void {
  for (const [nome, valor] of Object.entries(CABECALHOS_DA_API)) {
    resposta.setHeader(nome, valor);
  }
  seguir();
}
