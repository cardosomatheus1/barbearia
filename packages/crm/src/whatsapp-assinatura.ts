import { createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// A assinatura do webhook da Meta
// ---------------------------------------------------------------------------

/**
 * A conta da Meta é **outra** que a do adquirente, e não dá para reaproveitar.
 *
 * Mora aqui e não em `packages/core` por duas razões, e as duas são regra
 * escrita: `core` não depende de nada — nem de `node:crypto` —, e o precedente
 * do adquirente põe `conferirAssinaturaDoWebhook` em `packages/platform`, ao
 * lado de quem consome o webhook.
 *
 * A Stripe assina `${instante}.${corpo}` e manda o instante no cabeçalho, o que
 * permite recusar reenvio antigo por janela de tempo. A Meta assina **só o
 * corpo cru**, em `X-Hub-Signature-256: sha256=<hex>`, com o *app secret* — não
 * há instante, então não há janela.
 *
 * O que substitui a janela é a idempotência por id de mensagem: reenviar um
 * evento capturado grava o mesmo `wamid`, esbarra na unicidade e não faz nada.
 * É por isso que aquela constraint existe no banco e não só no código.
 *
 * O segredo vem do ambiente e **falha alto quando ausente**: cair num padrão
 * vazio faria toda assinatura conferir, e o endereço é público.
 */
export type FalhaDaAssinatura =
  | 'segredo_ausente'
  | 'assinatura_ausente'
  | 'assinatura_malformada'
  | 'assinatura_invalida';

export class AssinaturaDoWhatsAppInvalida extends Error {
  readonly code: FalhaDaAssinatura;

  constructor(code: FalhaDaAssinatura) {
    super(code);
    this.code = code;
    this.name = 'AssinaturaDoWhatsAppInvalida';
  }
}

export function assinarWebhookDaMeta(entrada: {
  readonly corpoCru: string;
  readonly segredo: string;
}): string {
  return createHmac('sha256', entrada.segredo).update(entrada.corpoCru, 'utf8').digest('hex');
}

export function conferirAssinaturaDaMeta(entrada: {
  readonly corpoCru: string;
  readonly cabecalho: string | undefined;
  readonly segredo: string;
}): void {
  if (!entrada.segredo) throw new AssinaturaDoWhatsAppInvalida('segredo_ausente');
  if (!entrada.cabecalho) throw new AssinaturaDoWhatsAppInvalida('assinatura_ausente');

  const prefixo = 'sha256=';
  if (!entrada.cabecalho.startsWith(prefixo)) {
    throw new AssinaturaDoWhatsAppInvalida('assinatura_malformada');
  }
  const recebida = entrada.cabecalho.slice(prefixo.length);
  if (!/^[0-9a-f]+$/i.test(recebida)) {
    throw new AssinaturaDoWhatsAppInvalida('assinatura_malformada');
  }

  const esperada = assinarWebhookDaMeta(entrada);
  const a = Buffer.from(esperada, 'utf8');
  const b = Buffer.from(recebida, 'utf8');
  // Comprimento diferente já é recusa, e `timingSafeEqual` lança nesse caso —
  // conferir antes é o que transforma a exceção em recusa. E é `timingSafeEqual`
  // e nunca `===`: a comparação de string sai no primeiro byte diferente, e
  // isso basta para reconstruir a assinatura byte a byte.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AssinaturaDoWhatsAppInvalida('assinatura_invalida');
  }
}
