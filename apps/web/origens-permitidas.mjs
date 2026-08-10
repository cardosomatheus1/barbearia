/**
 * Os endereços públicos por onde este processo é acessado através de um proxy.
 *
 * É a lista que `src/middleware.ts` usa para decidir de quem ele alinha o host
 * encaminhado — o porquê disso ser necessário está lá, junto do mecanismo. Aqui
 * mora só o critério de **quem entra na lista**, que é o que decide a segurança
 * do ajuste, e por isso é uma função pura com teste ao lado em vez de uma linha
 * dentro do `next.config.mjs`.
 *
 * Duas origens, nenhuma delas um curinga:
 *
 * - o endereço deste Codespaces, **derivado** das variáveis que o próprio
 *   ambiente exporta. Um `*.app.github.dev` cobriria o Codespaces de qualquer
 *   pessoa; o endereço derivado cobre este e mais nada;
 * - `WEB_ORIGENS_PERMITIDAS`, para qualquer outro proxy — um túnel, um domínio
 *   próprio, um Nginx na frente. Explícita e por ambiente.
 *
 * Fora de um proxy a lista sai vazia, e aí o middleware não faz nada: o
 * comportamento do Next fica idêntico ao de antes deste arquivo existir.
 */

/** A porta em que o web escuta, e que compõe o endereço encaminhado. */
const PORTA_PADRAO = '3001';

/**
 * Reduz o que a pessoa colou ao que se compara: o host.
 *
 * `WEB_ORIGENS_PERMITIDAS` aceita a URL inteira porque é o que a pessoa tem na
 * mão — copiada da barra do navegador. O esquema e o caminho são descartados
 * aqui em vez de virarem um item que nunca casa com nada.
 */
function apenasOHost(valor) {
  return valor.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]} hosts, sem esquema e sem repetição
 */
export function origensPermitidas(env) {
  const encontradas = [];

  // O Codespaces exporta as duas variáveis em todo terminal do ambiente; o
  // endereço encaminhado é a junção delas com a porta.
  const codespace = env['CODESPACE_NAME'];
  const dominio = env['GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN'];
  if (codespace && dominio) {
    // `PORTA_WEB` e não `PORT`: quem sobe o sistema local exporta `PORT` com a
    // porta da **API**, e usá-la aqui liberaria um endereço que não existe
    // enquanto o de verdade continuaria recusado.
    const porta = env['PORTA_WEB']?.trim() || PORTA_PADRAO;
    encontradas.push(`${codespace}-${porta}.${dominio}`);
  }

  for (const bruto of (env['WEB_ORIGENS_PERMITIDAS'] ?? '').split(',')) {
    const host = apenasOHost(bruto);
    // Vírgula sobrando não vira item vazio: string vazia na lista casaria com
    // requisição **sem** `origin`, que é justamente o que a conferência do Next
    // existe para recusar.
    if (host !== '') encontradas.push(host);
  }

  return [...new Set(encontradas)];
}
