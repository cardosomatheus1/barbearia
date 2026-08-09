/**
 * Guarda os bytes recebidos em `req.rawBody`.
 *
 * Existe pelas duas rotas de webhook — a do adquirente (bloco 29) e a da Stripe
 * (bloco 35) —, e mora em arquivo próprio por um motivo prático: `main.ts` chama
 * `bootstrap()` ao ser importado, então o teste que precisasse do mesmo parser
 * subiria a API de verdade só para pegar uma função.
 *
 * A assinatura HMAC é sobre os bytes que o provedor assinou. Reserializar o
 * objeto já analisado mudaria espaço em branco e ordem de chave, e a
 * conferência passaria a depender do `JSON.stringify` do Node em vez do que o
 * adquirente mandou — o que **passa** em teste e falha em produção.
 */
export function guardarCorpoCru(
  requisicao: { rawBody?: Buffer },
  _resposta: unknown,
  bytes: Buffer,
): void {
  requisicao.rawBody = bytes;
}
