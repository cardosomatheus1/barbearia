import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  estadoDoPagamento,
  paraEstadoDaCobranca,
  StripePaymentProvider,
  StripePspProvider,
} from './stripe-pagamento.js';
import { StripeCliente, type Rede } from './stripe.js';

/**
 * As duas pontas da Stripe (bloco 34).
 *
 * O que dá para provar sem conta contratada: o que sai na requisição e como a
 * resposta é lida. É o suficiente para pegar a classe de erro que mais dói numa
 * integração de pagamento — mandar o campo errado, ler o campo errado, e tratar
 * "ainda não pagou" como "recusou".
 */

interface Chamada {
  url: string;
  corpo: string | null;
  cabecalhos: Record<string, string>;
}

function stripeDeMentira(respostas: { status: number; json: unknown }[]): {
  cliente: StripeCliente;
  chamadas: Chamada[];
} {
  const chamadas: Chamada[] = [];
  let i = 0;

  const rede: Rede = async (url, init) => {
    chamadas.push({
      url,
      corpo: typeof init.body === 'string' ? init.body : null,
      cabecalhos: (init.headers ?? {}) as Record<string, string>,
    });
    const resposta = respostas[Math.min(i, respostas.length - 1)];
    i += 1;
    return new Response(JSON.stringify(resposta?.json ?? {}), { status: resposta?.status ?? 200 });
  };

  return { cliente: new StripeCliente(rede), chamadas };
}

const PEDIDO = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  orderId: '22222222-2222-2222-2222-222222222222',
  valorCents: 4900,
  descricao: 'Corte + barba',
  idempotencyKey: 'comanda:22222222',
} as const;

describe('a tradução do estado da Stripe', () => {
  it('só `succeeded` é pago', () => {
    expect(estadoDoPagamento('succeeded')).toBe('pago');
  });

  it('estado desconhecido é aguardando, nunca recusado', () => {
    /**
     * A Stripe acrescenta estado. Tratar o que não se conhece como recusa faria
     * uma cobrança boa ser cancelada no dia em que ela publicasse um estado
     * novo — e o sintoma seria "o Pix do cliente sumiu", sem nada nos logs.
     */
    expect(estadoDoPagamento('estado_que_ainda_nao_existe')).toBe('aguardando');
    expect(estadoDoPagamento('processing')).toBe('aguardando');
    expect(estadoDoPagamento('requires_action')).toBe('aguardando');
  });

  it('cancelado é expirado', () => {
    expect(estadoDoPagamento('canceled')).toBe('expirado');
  });

  it('`requires_payment_method` só é recusa depois de uma tentativa', () => {
    /**
     * A Stripe usa o mesmo status para duas coisas opostas: o intent
     * **recém-criado**, que ainda não falhou em nada, e o que tentou e o cartão
     * não passou. O código devolvia `recusado` para os dois — e contra a conta
     * de verdade isso apareceu na primeira chamada: um PaymentIntent de cartão
     * nasce assim, então toda cobrança de cartão nascia recusada, e a
     * conciliação por polling encerraria uma cobrança que está apenas
     * esperando o cliente.
     *
     * `last_payment_error` é o discriminador, e ele vem da própria resposta.
     */
    expect(estadoDoPagamento('requires_payment_method')).toBe('aguardando');
    expect(estadoDoPagamento('requires_payment_method', false)).toBe('aguardando');
    expect(estadoDoPagamento('requires_payment_method', true)).toBe('recusado');
  });

  it('a cobrança da plataforma tem `pendente`, e não só dois estados', () => {
    // O motivo do bloco 29: Pix e boleto respondem depois, e "pendente" não
    // pode gastar degrau da escada de retentativa.
    expect(paraEstadoDaCobranca('processing')).toBe('pendente');
    expect(paraEstadoDaCobranca('succeeded')).toBe('paga');
    expect(paraEstadoDaCobranca('canceled')).toBe('recusada');
  });
});

describe('a barbearia cobrando o cliente', () => {
  const anterior = process.env['STRIPE_SECRET_KEY'];
  beforeEach(() => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_de_mentira';
  });
  afterEach(() => {
    if (anterior === undefined) delete process.env['STRIPE_SECRET_KEY'];
    else process.env['STRIPE_SECRET_KEY'] = anterior;
  });

  it('o Pix sai confirmado e volta com o copia-e-cola', async () => {
    const { cliente, chamadas } = stripeDeMentira([
      {
        status: 200,
        json: {
          id: 'pi_1',
          status: 'requires_action',
          next_action: {
            pix_display_qr_code: { data: '00020126...', expires_at: 1_760_000_000 },
          },
        },
      },
    ]);

    const criada = await new StripePaymentProvider(cliente).criarCobranca({
      ...PEDIDO,
      meio: 'pix',
    });

    expect(criada.estado).toBe('aguardando');
    expect(criada.pagamentoId).toBe('pi_1');
    // O **texto**, não a imagem: quem paga pelo mesmo celular que abriu a tela
    // não consegue fotografar a própria tela.
    expect(criada.pixCopiaECola).toBe('00020126...');
    expect(criada.expiraEm?.getTime()).toBe(1_760_000_000_000);

    const corpo = chamadas[0]?.corpo ?? '';
    expect(corpo).toContain('payment_method_types%5B0%5D=pix');
    // Sem `confirm=true` a Stripe não gera o QR Code — devolve um intent
    // parado, e o balcão fica com a tela vazia esperando um código que nunca
    // vem.
    expect(corpo).toContain('confirm=true');
  });

  it('a comanda e a barbearia viajam como metadado', async () => {
    /**
     * É por eles que o webhook reencontra o que cobrar. O evento da Stripe
     * chega sem tenant, e um webhook que precisasse procurar o pagamento em
     * todas as barbearias teria que rodar sem isolamento — que é exatamente o
     * que a RLS existe para impedir.
     */
    const { cliente, chamadas } = stripeDeMentira([
      { status: 200, json: { id: 'pi_1', status: 'processing' } },
    ]);

    await new StripePaymentProvider(cliente).criarCobranca({ ...PEDIDO, meio: 'cartao' });

    const corpo = chamadas[0]?.corpo ?? '';
    expect(corpo).toContain(`metadata%5Border_id%5D=${PEDIDO.orderId}`);
    expect(corpo).toContain(`metadata%5Btenant_id%5D=${PEDIDO.tenantId}`);
  });

  it('a chave de idempotência da comanda vai no cabeçalho', async () => {
    // O duplo toque no celular do balcão é o caso comum, não a exceção.
    const { cliente, chamadas } = stripeDeMentira([
      { status: 200, json: { id: 'pi_1', status: 'processing' } },
    ]);

    await new StripePaymentProvider(cliente).criarCobranca({ ...PEDIDO, meio: 'pix' });

    expect(chamadas[0]?.cabecalhos['idempotency-key']).toContain('comanda:22222222');
  });

  it('a mesma chave em duas barbearias **não** colide', async () => {
    /**
     * O achado da `/security-review` deste bloco, e ele é pior aqui do que
     * dentro do produto: o espaço de idempotência da Stripe é o da **conta**,
     * que é uma só para todas as barbearias. A chave do balcão é livre, e duas
     * recepcionistas de barbearias diferentes mandando `"1"` fariam a segunda
     * receber de volta o copia-e-cola da primeira — o bastante para o cliente
     * errado pagar a conta errada.
     */
    const uma = stripeDeMentira([{ status: 200, json: { id: 'pi_1', status: 'processing' } }]);
    const outra = stripeDeMentira([{ status: 200, json: { id: 'pi_2', status: 'processing' } }]);

    await new StripePaymentProvider(uma.cliente).criarCobranca({
      ...PEDIDO,
      meio: 'pix',
      idempotencyKey: '1',
    });
    await new StripePaymentProvider(outra.cliente).criarCobranca({
      ...PEDIDO,
      tenantId: '99999999-9999-9999-9999-999999999999',
      orderId: '88888888-8888-8888-8888-888888888888',
      meio: 'pix',
      idempotencyKey: '1',
    });

    expect(uma.chamadas[0]?.cabecalhos['idempotency-key']).not.toBe(
      outra.chamadas[0]?.cabecalhos['idempotency-key'],
    );
  });

  it('o id do pagamento é codificado no caminho', async () => {
    // Ele é opaco hoje, e a partir do bloco 35 vem de um webhook. Uma barra no
    // meio mudaria **qual** recurso a consulta endereça, e um estado lido do
    // recurso errado é pior que um erro: parece resposta.
    const { cliente, chamadas } = stripeDeMentira([
      { status: 200, json: { id: 'pi_1', status: 'succeeded' } },
    ]);

    await new StripePaymentProvider(cliente).consultar('pi_1/../../balance');

    expect(chamadas[0]?.url).toBe(
      'https://api.stripe.com/v1/payment_intents/pi_1%2F..%2F..%2Fbalance',
    );
  });

  it('o link sai por página hospedada, e não por formulário nosso', async () => {
    /**
     * Hospedar a página de cartão significaria receber PAN — o que este produto
     * não faz e não quer fazer. Não existe coluna para PAN nem CVV, e há
     * invariante no banco que reprova se alguém criar uma.
     */
    const { cliente, chamadas } = stripeDeMentira([
      {
        status: 200,
        json: { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', expires_at: 1_760_000_000 },
      },
    ]);

    const criada = await new StripePaymentProvider(cliente).criarCobranca({
      ...PEDIDO,
      meio: 'link',
    });

    expect(chamadas[0]?.url).toContain('/checkout/sessions');
    expect(criada.url).toBe('https://checkout.stripe.com/c/pay/cs_1');
    expect(criada.estado).toBe('aguardando');
    // O preço vai inline: espelhá-lo num catálogo da Stripe criaria uma segunda
    // fonte da verdade para um número que muda a cada venda.
    expect(chamadas[0]?.corpo).toContain('line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=4900');
  });

  it('consultar escolhe o recurso pelo prefixo do id', async () => {
    // `cs_` é sessão, `pi_` é intent. Ler o prefixo evita uma segunda coluna
    // dizendo de que tipo é cada pagamento — coluna que pode divergir.
    const sessao = stripeDeMentira([{ status: 200, json: { id: 'cs_1', payment_status: 'paid' } }]);
    expect(await new StripePaymentProvider(sessao.cliente).consultar('cs_1')).toBe('pago');
    expect(sessao.chamadas[0]?.url).toContain('/checkout/sessions/cs_1');

    const intent = stripeDeMentira([{ status: 200, json: { id: 'pi_1', status: 'succeeded' } }]);
    expect(await new StripePaymentProvider(intent.cliente).consultar('pi_1')).toBe('pago');
    expect(intent.chamadas[0]?.url).toContain('/payment_intents/pi_1');
  });

  it('estorno sem valor é total, e com valor é parcial', async () => {
    const total = stripeDeMentira([{ status: 200, json: { id: 're_1' } }]);
    await new StripePaymentProvider(total.cliente).estornar('pi_1');
    expect(total.chamadas[0]?.corpo).toBe('payment_intent=pi_1');

    const parcial = stripeDeMentira([{ status: 200, json: { id: 're_2' } }]);
    await new StripePaymentProvider(parcial.cliente).estornar('pi_1', 1500);
    expect(parcial.chamadas[0]?.corpo).toContain('amount=1500');
  });

  it('estorno também leva chave de idempotência', async () => {
    /**
     * Ele é POST que move dinheiro, e o CLAUDE.md §2 não abre exceção. A chave é
     * derivada e não sorteada porque a retentativa precisa produzir a **mesma**:
     * a resposta perdida e a requisição que não chegou são indistinguíveis
     * daqui, e sem a chave a segunda tentativa devolve o dinheiro de novo.
     */
    const total = stripeDeMentira([{ status: 200, json: { id: 're_1' } }]);
    await new StripePaymentProvider(total.cliente).estornar('pi_1');

    const parcial = stripeDeMentira([{ status: 200, json: { id: 're_2' } }]);
    await new StripePaymentProvider(parcial.cliente).estornar('pi_1', 1500);

    const chaveTotal = total.chamadas[0]?.cabecalhos['idempotency-key'];
    expect(chaveTotal).toBeTruthy();
    // E o parcial não herda a chave do total: devolver R$ 15 depois de devolver
    // tudo é outra operação, e uma chave só faria a segunda ser engolida.
    expect(parcial.chamadas[0]?.cabecalhos['idempotency-key']).not.toBe(chaveTotal);
  });
});

describe('a plataforma cobrando a barbearia', () => {
  const anterior = process.env['STRIPE_SECRET_KEY'];
  beforeEach(() => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_de_mentira';
  });
  afterEach(() => {
    if (anterior === undefined) delete process.env['STRIPE_SECRET_KEY'];
    else process.env['STRIPE_SECRET_KEY'] = anterior;
  });

  const COBRANCA = {
    tenantId: '11111111-1111-1111-1111-111111111111',
    faturaId: '33333333-3333-3333-3333-333333333333',
    valorCents: 24900,
    pspCustomerId: 'cus_1',
    pspMethodId: 'pm_1',
  };

  it('cobra fora de sessão, porque não há ninguém olhando', async () => {
    const { cliente, chamadas } = stripeDeMentira([
      { status: 200, json: { id: 'pi_9', status: 'succeeded' } },
    ]);

    const resposta = await new StripePspProvider(cliente).cobrar(COBRANCA);

    expect(resposta.estado).toBe('paga');
    const corpo = chamadas[0]?.corpo ?? '';
    // Sem `off_session`, a Stripe pode exigir 3DS — e não há ninguém para
    // confirmar às três da manhã.
    expect(corpo).toContain('off_session=true');
    expect(corpo).toContain('confirm=true');
    // A chave é a fatura: dois workers rodando a régua no mesmo dia não podem
    // emitir a segunda cobrança da mesma fatura.
    expect(chamadas[0]?.cabecalhos['idempotency-key']).toBe(`fatura:${COBRANCA.faturaId}`);
  });

  it('cartão recusado é resposta, não exceção', async () => {
    /**
     * A Stripe devolve 402 quando o cartão não passa. Deixar isso subir como
     * exceção faria a régua tratar "o cartão foi recusado" — que é informação —
     * como "o adquirente está fora do ar", que é outra coisa e não deve gastar
     * degrau da escada de retentativa.
     */
    const { cliente } = stripeDeMentira([
      { status: 402, json: { error: { code: 'card_declined', message: 'declined' } } },
    ]);

    const resposta = await new StripePspProvider(cliente).cobrar(COBRANCA);
    expect(resposta.estado).toBe('recusada');
    expect(resposta.motivo).toBe('card_declined');
  });

  it('falha do adquirente **não** vira recusa silenciosa', async () => {
    // 500 da Stripe é indisponibilidade. Tratá-la como recusa marcaria uma
    // tentativa na escada e aproximaria a barbearia da suspensão por um
    // problema que não é dela.
    const { cliente } = stripeDeMentira([{ status: 500, json: {} }]);

    await expect(new StripePspProvider(cliente).cobrar(COBRANCA)).rejects.toBeInstanceOf(Error);
  });

  it('a recusa volta **sem** id de cobrança', async () => {
    /**
     * O outro achado da `/security-review`. `psp_charge_id` só é escrito
     * enquanto é nulo, e string vazia não é nulo: uma recusa que devolvesse
     * `''` amarraria a fatura a nada **para sempre**, e o webhook da tentativa
     * que desse certo procuraria uma fatura por um id que ninguém guardou. A
     * barbearia seria suspensa por uma fatura que pagou.
     */
    const { cliente } = stripeDeMentira([
      { status: 402, json: { error: { code: 'card_declined' } } },
    ]);

    const resposta = await new StripePspProvider(cliente).cobrar(COBRANCA);
    expect(resposta.chargeId).toBe('');
  });
});

describe('devolver o dinheiro da barbearia', () => {
  const anterior = process.env['STRIPE_SECRET_KEY'];
  beforeEach(() => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_de_mentira';
  });
  afterEach(() => {
    if (anterior === undefined) delete process.env['STRIPE_SECRET_KEY'];
    else process.env['STRIPE_SECRET_KEY'] = anterior;
  });

  const ESTORNO = {
    tenantId: '11111111-1111-1111-1111-111111111111',
    pspCustomerId: 'cus_1',
    pspChargeId: 'pi_9',
    valorCents: 24900,
    estornoId: '44444444-4444-4444-4444-444444444444',
  };

  it('estorna **uma cobrança**, não "a conta"', async () => {
    /**
     * A primeira versão mandava `{ customer, amount }`, que a Stripe recusa:
     * `POST /refunds` precisa saber o que está sendo estornado. O efeito seria
     * pior que um erro — o crédito da barbearia já teria sido debitado quando a
     * chamada falhasse, e o dinheiro sumiria do saldo dela sem chegar a lugar
     * nenhum.
     */
    const { cliente, chamadas } = stripeDeMentira([{ status: 200, json: { id: 're_1' } }]);

    const resposta = await new StripePspProvider(cliente).estornar(ESTORNO);

    expect(resposta.refundId).toBe('re_1');
    expect(chamadas[0]?.corpo).toContain('payment_intent=pi_9');
    expect(chamadas[0]?.cabecalhos['idempotency-key']).toBe(`estorno:${ESTORNO.estornoId}`);
  });

  it('recusa definitiva é `EstornoRecusado`; indisponibilidade não é', async () => {
    /**
     * A diferença decide se o crédito debitado volta. 4xx é a Stripe dizendo
     * que **nada saiu** da conta; 5xx é ambíguo — o estorno pode ter sido feito
     * e a resposta ter se perdido, e devolver o crédito aí pagaria a barbearia
     * duas vezes.
     */
    const recusa = stripeDeMentira([
      { status: 400, json: { error: { code: 'charge_already_refunded' } } },
    ]);
    await expect(new StripePspProvider(recusa.cliente).estornar(ESTORNO)).rejects.toMatchObject({
      name: 'EstornoRecusado',
      code: 'charge_already_refunded',
    });

    const queda = stripeDeMentira([{ status: 503, json: {} }]);
    await expect(new StripePspProvider(queda.cliente).estornar(ESTORNO)).rejects.toMatchObject({
      name: 'StripeError',
    });
  });
});

/**
 * Os três defeitos que só a conta de verdade mostrou.
 *
 * A suíte acima confere **o que sai** na requisição, e é boa nisso. O que ela
 * não consegue ver é o que **não sai**: um campo obrigatório ausente não aparece
 * em nenhuma asserção sobre o corpo, e a rede de mentira responde 200 para
 * qualquer coisa. A primeira chamada contra a API de teste da Stripe devolveu
 * três 400 em cima de código que passava inteiro aqui.
 *
 * Por isso estes testes são escritos pelo avesso: eles cobram a presença do que
 * faltava, e a asserção é sobre o corpo enviado — que é o que a Stripe recusou.
 */
describe('o que a conta de verdade recusou', () => {
  const anterior = process.env['STRIPE_SECRET_KEY'];
  const webAnterior = process.env['WEB_URL'];
  beforeEach(() => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_de_mentira';
    process.env['WEB_URL'] = 'https://barbearia.example';
  });
  afterEach(() => {
    if (anterior === undefined) delete process.env['STRIPE_SECRET_KEY'];
    else process.env['STRIPE_SECRET_KEY'] = anterior;
    if (webAnterior === undefined) delete process.env['WEB_URL'];
    else process.env['WEB_URL'] = webAnterior;
  });

  it('o link leva `success_url`, sem o qual a Stripe recusa a sessão inteira', async () => {
    // 400 `parameter_missing`: o meio "link" nunca funcionou, e nada aqui ficava
    // vermelho porque o teste conferia o que saía e este campo não saía.
    const { cliente, chamadas } = stripeDeMentira([
      { status: 200, json: { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' } },
    ]);

    const criada = await new StripePaymentProvider(cliente).criarCobranca({
      ...PEDIDO,
      meio: 'link',
    });
    expect(criada.url).toContain('checkout.stripe.com');

    const corpo = chamadas[0]?.corpo ?? '';
    expect(corpo).toContain(encodeURIComponent('https://barbearia.example/pagamento?pago=1'));
    // E a volta de quem desiste: opcional na Stripe, obrigatória aqui.
    expect(corpo).toContain('cancel_url');
  });

  it('sem meio salvo, a recusa é daqui e a Stripe nem é chamada', async () => {
    /**
     * String vazia é 400 `parameter_invalid_empty`; omitir o campo é 400
     * `payment_intent_unexpected_state`, porque a Stripe não adivinha o cartão
     * do cliente. Os dois são 400 e nenhum é 402 — a régua leria "esta
     * barbearia não tem cartão salvo" como adquirente fora do ar e gastaria
     * D+1, D+3 e D+7 em chamadas que já sabem a resposta.
     */
    const { cliente, chamadas } = stripeDeMentira([
      { status: 200, json: { id: 'pi_9', status: 'succeeded' } },
    ]);

    const r = await new StripePspProvider(cliente).cobrar({
      tenantId: '11111111-1111-4111-8111-111111111111',
      faturaId: '22222222-2222-4222-8222-222222222222',
      valorCents: 9900,
      pspCustomerId: 'cus_1',
      pspMethodId: null,
    });

    expect(r).toMatchObject({ estado: 'recusada', chargeId: '' });
    expect(chamadas).toHaveLength(0);
  });

  it('com meio salvo, ele vai', async () => {
    // A outra metade: sem esta, o conserto acima passaria removendo o campo
    // sempre — e a régua cobraria no cartão errado.
    const { cliente, chamadas } = stripeDeMentira([
      { status: 200, json: { id: 'pi_10', status: 'succeeded' } },
    ]);

    await new StripePspProvider(cliente).cobrar({
      tenantId: '11111111-1111-4111-8111-111111111111',
      faturaId: '33333333-3333-4333-8333-333333333333',
      valorCents: 9900,
      pspCustomerId: 'cus_1',
      pspMethodId: 'pm_42',
    });

    expect(chamadas[0]?.corpo ?? '').toContain('payment_method=pm_42');
  });

  it('a cobrança de cartão nasce aguardando, não recusada', async () => {
    // O estado inicial de todo PaymentIntent de cartão é
    // `requires_payment_method`. Nascendo `recusado`, a conciliação encerraria
    // a cobrança antes de o cliente abrir o link.
    const { cliente } = stripeDeMentira([
      { status: 200, json: { id: 'pi_11', status: 'requires_payment_method' } },
    ]);

    const criada = await new StripePaymentProvider(cliente).criarCobranca({
      ...PEDIDO,
      meio: 'cartao',
    });
    expect(criada.estado).toBe('aguardando');
  });

  it('e vira recusada quando a tentativa falhou', async () => {
    const { cliente } = stripeDeMentira([
      {
        status: 200,
        json: {
          id: 'pi_12',
          status: 'requires_payment_method',
          last_payment_error: { code: 'card_declined' },
        },
      },
    ]);

    expect(await new StripePaymentProvider(cliente).consultar('pi_12')).toBe('recusado');
  });
});
