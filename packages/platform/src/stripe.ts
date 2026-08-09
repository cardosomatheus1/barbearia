/**
 * O cliente Stripe, compartilhado pelas duas direções de dinheiro (bloco 34).
 *
 * ## As duas direções, e por que um cliente só
 *
 * O produto cobra em dois sentidos: a **plataforma cobra a barbearia** (a
 * mensalidade, bloco 28) e a **barbearia cobra o cliente dela** (a comanda,
 * blocos 35 e 36). São contratos diferentes — `PspProvider` e `PaymentProvider`
 * — e seria natural cada um trazer o seu cliente HTTP. Seria errado: a versão
 * da API, o cabeçalho de idempotência, o tratamento de erro e a codificação do
 * corpo são os mesmos, e duas cópias divergem no primeiro ajuste, sempre no
 * lado que ninguém está olhando.
 *
 * ## Por que `fetch` e não a biblioteca oficial
 *
 * O `CLAUDE.md` §2 diz que dependência nova entra com motivo declarado, e aqui
 * o motivo não aparece. A API da Stripe é REST com corpo `form-urlencoded`, e o
 * que este produto precisa dela cabe em três verbos. A biblioteca oficial traz
 * um cliente HTTP próprio, política de retentativa própria e tipos gerados para
 * uma superfície cem vezes maior que a usada.
 *
 * Há precedente e ele é o mesmo raciocínio: o segundo fator é TOTP escrito
 * sobre `node:crypto` (bloco 24), a senha é scrypt do próprio Node (bloco 12), e
 * a assinatura do webhook é HMAC feito à mão (bloco 29) — que, por sinal, é
 * **exatamente** o esquema que a Stripe usa (`t=…,v1=…` sobre
 * `${instante}.${corpo cru}`). A verificação que já existe serve à Stripe sem
 * uma linha nova.
 *
 * ## O que este arquivo não faz
 *
 * Não tem retentativa. A rede de segurança do produto é a conciliação por
 * polling (bloco 29), que já existe e cobre a falha de entrega inteira — desde
 * "a requisição não chegou" até "o webhook se perdeu". Uma segunda política de
 * retentativa aqui dentro competiria com ela e tornaria mais difícil responder
 * "quantas vezes nós tentamos cobrar esta pessoa?".
 */

/** Versão fixada. A Stripe muda o formato de resposta entre versões. */
export const VERSAO_DA_API_STRIPE = '2024-06-20';

const BASE = 'https://api.stripe.com/v1';

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = 'StripeError';
  }
}

/**
 * A função de rede, injetável.
 *
 * O teste passa a sua e observa o que foi enviado. Sem isto, provar que o
 * cabeçalho de idempotência sai, que o corpo é `form-urlencoded` e que o erro
 * vira `StripeError` exigiria um servidor de mentira no ar — e o que se quer
 * provar é o que o cliente **manda**, não que HTTP funciona.
 */
export type Rede = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A chave secreta, que falha alto quando ausente.
 *
 * Nunca cai num padrão. Uma chave vazia produziria 401 da Stripe no primeiro
 * pagamento de um cliente de verdade, e o erro apareceria como "não deu para
 * cobrar" — sem dizer que a configuração nunca existiu.
 */
function chave(): string {
  const secreta = process.env['STRIPE_SECRET_KEY'];
  if (!secreta) {
    throw new Error('STRIPE_SECRET_KEY é obrigatória para falar com a Stripe');
  }
  return secreta;
}

/**
 * Achata o objeto no formato que a Stripe entende.
 *
 * Ela não aceita JSON: o corpo é `form-urlencoded` com colchetes para aninhar
 * (`payment_method_data[type]=pix`). Escrever isso à mão em cada chamada é como
 * se erra uma vez e não se descobre até o pagamento não sair.
 *
 * Valor `undefined` é omitido; `null` vira string vazia, que é como a Stripe lê
 * "apague este campo".
 */
export function comoFormulario(
  dados: Record<string, unknown>,
  prefixo = '',
): [string, string][] {
  const pares: [string, string][] = [];

  for (const [chaveDoCampo, valor] of Object.entries(dados)) {
    if (valor === undefined) continue;
    const nome = prefixo ? `${prefixo}[${chaveDoCampo}]` : chaveDoCampo;

    if (valor === null) {
      pares.push([nome, '']);
    } else if (Array.isArray(valor)) {
      // A Stripe indexa arrays por posição: `expand[0]=charge`.
      valor.forEach((item, i) => {
        if (item !== null && typeof item === 'object') {
          pares.push(...comoFormulario(item as Record<string, unknown>, `${nome}[${i}]`));
        } else {
          pares.push([`${nome}[${i}]`, String(item)]);
        }
      });
    } else if (typeof valor === 'object') {
      pares.push(...comoFormulario(valor as Record<string, unknown>, nome));
    } else {
      pares.push([nome, String(valor)]);
    }
  }

  return pares;
}

export interface OpcoesDaChamada {
  /**
   * A chave de idempotência da Stripe.
   *
   * Obrigatória em tudo que cria cobrança, e o motivo é o mesmo do
   * `Idempotency-Key` do produto (CLAUDE.md §2): a requisição que não chegou e a
   * que chegou e cuja resposta se perdeu são indistinguíveis daqui. Sem a
   * chave, a retentativa que a rede provoca sozinha cobra a pessoa duas vezes.
   */
  readonly idempotencyKey?: string;
  /** Cobrança feita **em nome** de uma conta conectada (blocos 49 e 50). */
  readonly contaConectada?: string;
}

export class StripeCliente {
  constructor(private readonly rede: Rede = fetch) {}

  async post<T>(
    caminho: string,
    dados: Record<string, unknown>,
    opcoes: OpcoesDaChamada = {},
  ): Promise<T> {
    const corpo = new URLSearchParams(comoFormulario(dados)).toString();
    return this.chamar<T>('POST', caminho, corpo, opcoes);
  }

  async get<T>(caminho: string, opcoes: OpcoesDaChamada = {}): Promise<T> {
    return this.chamar<T>('GET', caminho, null, opcoes);
  }

  private async chamar<T>(
    metodo: 'GET' | 'POST',
    caminho: string,
    corpo: string | null,
    opcoes: OpcoesDaChamada,
  ): Promise<T> {
    const resposta = await this.rede(`${BASE}${caminho}`, {
      method: metodo,
      headers: {
        authorization: `Bearer ${chave()}`,
        'stripe-version': VERSAO_DA_API_STRIPE,
        ...(corpo === null ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
        ...(opcoes.idempotencyKey ? { 'idempotency-key': opcoes.idempotencyKey } : {}),
        ...(opcoes.contaConectada ? { 'stripe-account': opcoes.contaConectada } : {}),
      },
      ...(corpo === null ? {} : { body: corpo }),
    });

    const texto = await resposta.text();
    const json = texto ? (JSON.parse(texto) as Record<string, unknown>) : {};

    if (!resposta.ok) {
      /**
       * O erro da Stripe vira `StripeError`, e o detalhe **não** sobe para o
       * cliente final.
       *
       * `message` da Stripe é escrito para quem integra, não para quem está no
       * balcão: "No such payment_intent: pi_3Abc" numa tela de barbearia é
       * confissão de detalhe interno. Quem traduz é a borda; aqui o texto vai
       * inteiro para o log e para a trilha.
       */
      const erro = (json['error'] ?? {}) as { code?: string; message?: string; type?: string };
      throw new StripeError(
        resposta.status,
        erro.code ?? erro.type ?? 'stripe_error',
        erro.message ?? `Stripe respondeu ${resposta.status}`,
      );
    }

    return json as T;
  }
}
