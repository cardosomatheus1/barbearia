import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  comoFormulario,
  StripeCliente,
  StripeError,
  VERSAO_DA_API_STRIPE,
  type Rede,
} from './stripe.js';

/**
 * O cliente Stripe, provado pelo que ele **manda** (bloco 34).
 *
 * ## O que estes testes provam, e o que não dá para provar aqui
 *
 * Não há conta contratada nem rede para a Stripe neste ambiente, então o que se
 * pode provar é o contrato do lado de cá: que o corpo sai `form-urlencoded` com
 * o aninhamento que ela exige, que a chave de idempotência sai no cabeçalho,
 * que a versão vai fixada e que a falha vira erro tipado em vez de resposta
 * malformada seguindo adiante.
 *
 * O que **não** é provado aqui está declarado no ROADMAP: que a Stripe aceita
 * estas chamadas. Isso depende de conta contratada, e nenhum teste local
 * substitui — é por isso que o `FakePaymentProvider` continua sendo o provedor
 * de desenvolvimento e a conciliação por polling continua sendo a rede de
 * segurança.
 */

interface Chamada {
  url: string;
  metodo: string;
  cabecalhos: Record<string, string>;
  corpo: string | null;
  // REPARO DA VALIDAÇÃO: `RequestRedirect` é tipo de `lib.dom`, que este
  // pacote não carrega. A união literal é a mesma coisa e não depende da lib.
  redirect: 'follow' | 'error' | 'manual' | undefined;
  signal?: AbortSignal | null;
}

function espiao(resposta: { status: number; json: unknown }): {
  rede: Rede;
  chamadas: Chamada[];
} {
  const chamadas: Chamada[] = [];
  const rede: Rede = async (url, init) => {
    chamadas.push({
      url,
      metodo: init.method ?? 'GET',
      cabecalhos: (init.headers ?? {}) as Record<string, string>,
      corpo: typeof init.body === 'string' ? init.body : null,
      redirect: init.redirect,
      signal: init.signal ?? null,
    });
    return new Response(JSON.stringify(resposta.json), {
      status: resposta.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { rede, chamadas };
}

describe('o corpo no formato que a Stripe entende', () => {
  it('achata objeto aninhado com colchetes', () => {
    // Ela não aceita JSON. Escrever `payment_method_data[type]` à mão em cada
    // chamada é como se erra uma vez e não se descobre até o pagamento não sair.
    expect(comoFormulario({ amount: 4900, payment_method_data: { type: 'pix' } })).toEqual([
      ['amount', '4900'],
      ['payment_method_data[type]', 'pix'],
    ]);
  });

  it('indexa array por posição', () => {
    expect(comoFormulario({ expand: ['charge', 'customer'] })).toEqual([
      ['expand[0]', 'charge'],
      ['expand[1]', 'customer'],
    ]);
  });

  it('omite indefinido e manda vazio para nulo', () => {
    /**
     * A distinção é da Stripe: campo ausente é "não mexa", campo vazio é
     * "apague". Tratar os dois igual faria "remover o cartão salvo" virar
     * "mantenha o cartão salvo", em silêncio.
     */
    expect(comoFormulario({ a: undefined, b: null, c: 0 })).toEqual([
      ['b', ''],
      ['c', '0'],
    ]);
  });

  it('não engole `false` nem zero', () => {
    // O erro clássico de quem filtra por valor-verdade: `capture: false` some e
    // a cobrança é capturada na hora, que é o oposto do pedido.
    expect(comoFormulario({ capture: false, amount: 0 })).toEqual([
      ['capture', 'false'],
      ['amount', '0'],
    ]);
  });
});

describe('a chamada à Stripe', () => {
  const anterior = process.env['STRIPE_SECRET_KEY'];

  beforeEach(() => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_de_mentira';
  });

  afterEach(() => {
    if (anterior === undefined) delete process.env['STRIPE_SECRET_KEY'];
    else process.env['STRIPE_SECRET_KEY'] = anterior;
  });

  it('manda a chave, a versão fixada e o corpo codificado', async () => {
    const { rede, chamadas } = espiao({ status: 200, json: { id: 'pi_1' } });

    const resposta = await new StripeCliente(rede).post<{ id: string }>('/payment_intents', {
      amount: 4900,
      currency: 'brl',
    });

    expect(resposta.id).toBe('pi_1');
    const chamada = chamadas[0];
    expect(chamada?.url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(chamada?.cabecalhos['authorization']).toBe('Bearer sk_test_de_mentira');
    // A versão vai fixada: a Stripe muda o formato da resposta entre versões, e
    // "usar a mais nova" é receber uma quebra no dia em que ela publicar.
    expect(chamada?.cabecalhos['stripe-version']).toBe(VERSAO_DA_API_STRIPE);
    expect(chamada?.corpo).toBe('amount=4900&currency=brl');
    expect(chamada?.redirect).toBe('manual');
    expect(chamada?.signal).toBeInstanceOf(AbortSignal);
  });

  it('manda a chave de idempotência quando ela existe', async () => {
    /**
     * Obrigatória em tudo que cria cobrança. A requisição que não chegou e a
     * que chegou e cuja resposta se perdeu são indistinguíveis daqui — sem a
     * chave, a retentativa que a própria rede provoca cobra a pessoa duas
     * vezes.
     */
    const { rede, chamadas } = espiao({ status: 200, json: { id: 'pi_1' } });

    await new StripeCliente(rede).post('/payment_intents', { amount: 100 }, {
      idempotencyKey: 'comanda-abc',
    });

    expect(chamadas[0]?.cabecalhos['idempotency-key']).toBe('comanda-abc');
  });

  it('manda a conta conectada quando a cobrança é em nome de outra', async () => {
    // O que os blocos 49 e 50 vão precisar. Entra agora porque é um cabeçalho e
    // porque tê-lo no cliente evita a segunda cópia do cliente depois.
    const { rede, chamadas } = espiao({ status: 200, json: {} });

    await new StripeCliente(rede).get('/balance', { contaConectada: 'acct_1' });

    expect(chamadas[0]?.cabecalhos['stripe-account']).toBe('acct_1');
  });

  it('o GET não manda corpo nem content-type', async () => {
    const { rede, chamadas } = espiao({ status: 200, json: {} });
    await new StripeCliente(rede).get('/payment_intents/pi_1');

    expect(chamadas[0]?.corpo).toBeNull();
    expect(chamadas[0]?.cabecalhos['content-type']).toBeUndefined();
  });

  it('a falha vira erro tipado, com código e status', async () => {
    const { rede } = espiao({
      status: 402,
      json: { error: { code: 'card_declined', message: 'Your card was declined.' } },
    });

    await expect(new StripeCliente(rede).post('/payment_intents', {})).rejects.toMatchObject({
      name: 'StripeError',
      status: 402,
      code: 'card_declined',
    });
  });

  it('falha sem código conhecido ainda vira erro, não resposta vazia', async () => {
    // O caminho que derruba integração: 500 com corpo vazio seguindo adiante
    // como se fosse sucesso, e o pagamento marcado como pago sem ter sido.
    const { rede } = espiao({ status: 500, json: {} });

    await expect(new StripeCliente(rede).get('/payment_intents/pi_1')).rejects.toBeInstanceOf(
      StripeError,
    );
  });

  it('falha de rede vira erro de transporte sem repetir detalhe potencialmente sensível', async () => {
    const rede: Rede = async () => {
      throw new Error('proxy https://interno/?secret=vaza');
    };
    await expect(new StripeCliente(rede).get('/balance')).rejects.toMatchObject({
      name: 'StripeTransportError',
      message: 'falha de transporte ao falar com a Stripe',
    });
  });

  it('2xx/5xx com corpo que não é JSON falha como resposta inválida', async () => {
    const rede: Rede = async () => new Response('<html>proxy</html>', { status: 502 });
    await expect(new StripeCliente(rede).get('/balance')).rejects.toMatchObject({
      name: 'StripeError',
      code: 'stripe_invalid_response',
      status: 502,
    });
  });

  it('sem a chave secreta, falha alto em vez de tentar', async () => {
    /**
     * Variável que protege dinheiro nunca cai num padrão (CLAUDE.md §2). Uma
     * chave vazia produziria 401 da Stripe no primeiro pagamento de verdade, e
     * o erro apareceria como "não deu para cobrar" — sem dizer que a
     * configuração nunca existiu.
     */
    delete process.env['STRIPE_SECRET_KEY'];
    const { rede, chamadas } = espiao({ status: 200, json: {} });

    await expect(new StripeCliente(rede).get('/balance')).rejects.toThrow(/STRIPE_SECRET_KEY/);
    // E nem chegou a bater na rede.
    expect(chamadas).toHaveLength(0);
  });
});
