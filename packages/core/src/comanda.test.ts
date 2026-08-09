import { describe, expect, it } from 'vitest';
import {
  conferirPagamento,
  entraNaGaveta,
  esperadoNaGaveta,
  fecharCaixa,
  fiadoDisponivel,
  podeFiar,
  resultadoDoPagamento,
  somarComanda,
  tetoDoDesconto,
  validarDesconto,
  validarItem,
  type ItemDaComanda,
} from './comanda.js';

const item = (parcial: Partial<ItemDaComanda> = {}): ItemDaComanda => ({
  id: 'i1',
  tipo: 'service',
  descricao: 'Corte',
  quantidade: 1,
  precoUnitarioCents: 4900,
  professionalId: 'ruan',
  ...parcial,
});

describe('soma da comanda', () => {
  it('soma serviços, produtos e consumação em centavos', () => {
    const totais = somarComanda({
      itens: [
        item({ id: 'a', precoUnitarioCents: 4900 }),
        item({ id: 'b', tipo: 'product', descricao: 'Pomada', precoUnitarioCents: 4500 }),
        item({ id: 'c', tipo: 'consumable', descricao: 'Cerveja', precoUnitarioCents: 800 }),
      ],
    });

    expect(totais.subtotalCents).toBe(10200);
    expect(totais.totalCents).toBe(10200);
  });

  it('quantidade multiplica o preço', () => {
    const totais = somarComanda({
      itens: [item({ tipo: 'consumable', descricao: 'Cerveja', quantidade: 3, precoUnitarioCents: 800 })],
    });
    expect(totais.subtotalCents).toBe(2400);
  });

  it('desconto em valor sai do subtotal', () => {
    const totais = somarComanda({
      itens: [item({ precoUnitarioCents: 7400 })],
      desconto: { tipo: 'amount', valor: 1000 },
    });

    expect(totais.descontoCents).toBe(1000);
    expect(totais.totalCents).toBe(6400);
  });

  it('desconto percentual arredonda para baixo', () => {
    // 10% de R$ 74,05 é R$ 7,405. Meio centavo não existe, e arredondar para
    // cima daria ao cliente um centavo que a casa não decidiu dar.
    const totais = somarComanda({
      itens: [item({ precoUnitarioCents: 7405 })],
      desconto: { tipo: 'percent', valor: 10 },
    });

    expect(totais.descontoCents).toBe(740);
    expect(totais.totalCents).toBe(6665);
  });

  it('desconto nunca passa do subtotal — total negativo é crédito não autorizado', () => {
    const totais = somarComanda({
      itens: [item({ precoUnitarioCents: 7000 })],
      desconto: { tipo: 'amount', valor: 10000 },
    });

    expect(totais.descontoCents).toBe(7000);
    expect(totais.totalCents).toBe(0);
  });

  it('a gorjeta entra por fora, não é reduzida pelo desconto da casa', () => {
    // Aplicar a gorjeta depois do desconto faria o barbeiro receber menos
    // porque a casa deu desconto. A gorjeta não é da casa.
    const totais = somarComanda({
      itens: [item({ precoUnitarioCents: 10000 })],
      desconto: { tipo: 'percent', valor: 50 },
      gorjetaCents: 1000,
    });

    expect(totais.descontoCents).toBe(5000);
    expect(totais.gorjetaCents).toBe(1000);
    expect(totais.totalCents).toBe(6000);
  });

  it('comanda vazia soma zero, não estoura', () => {
    expect(somarComanda({ itens: [] })).toMatchObject({ subtotalCents: 0, totalCents: 0 });
  });

  it('nenhuma soma passa por ponto flutuante', () => {
    // 0.1 + 0.2 !== 0.3. Em centavos inteiros o problema não existe, e este
    // teste fica vermelho no dia em que alguém trocar por reais.
    const totais = somarComanda({
      itens: [
        item({ id: 'a', precoUnitarioCents: 10 }),
        item({ id: 'b', precoUnitarioCents: 20 }),
      ],
    });
    expect(totais.subtotalCents).toBe(30);
    expect(Number.isInteger(totais.totalCents)).toBe(true);
  });
});

describe('validação de item', () => {
  it('aceita item de cortesia com preço zero', () => {
    expect(validarItem({ tipo: 'product', descricao: 'Brinde', quantidade: 1, precoUnitarioCents: 0 }))
      .toBeNull();
  });

  it('recusa preço negativo — desconto tem campo próprio', () => {
    // Preço negativo esconderia o desconto do relatório que separa receita de
    // desconto, e é assim que a margem some sem ninguém ver.
    expect(
      validarItem({ tipo: 'product', descricao: 'x', quantidade: 1, precoUnitarioCents: -100 }),
    ).toBe('preco_invalido');
  });

  it('recusa quantidade zero, negativa e fracionada', () => {
    for (const quantidade of [0, -1, 1.5]) {
      expect(
        validarItem({ tipo: 'service', descricao: 'x', quantidade, precoUnitarioCents: 100 }),
      ).toBe('quantidade_invalida');
    }
  });

  it('recusa centavo fracionado', () => {
    expect(
      validarItem({ tipo: 'service', descricao: 'x', quantidade: 1, precoUnitarioCents: 49.9 }),
    ).toBe('preco_invalido');
  });

  it('recusa tipo inventado e descrição vazia', () => {
    expect(validarItem({ tipo: 'vale', descricao: 'x', quantidade: 1, precoUnitarioCents: 1 }))
      .toBe('item_invalido');
    expect(validarItem({ tipo: 'service', descricao: '   ', quantidade: 1, precoUnitarioCents: 1 }))
      .toBe('item_invalido');
  });

  it('recusa percentual acima de cem', () => {
    expect(validarDesconto({ tipo: 'percent', valor: 120 })).toBe('desconto_invalido');
    expect(validarDesconto({ tipo: 'amount', valor: -1 })).toBe('desconto_invalido');
  });
});

describe('pagamento', () => {
  it('aceita divisão entre formas', () => {
    const conferido = conferirPagamento({
      totalCents: 12000,
      pagamentos: [
        { forma: 'pix', valorCents: 5000 },
        { forma: 'credit', valorCents: 7000 },
      ],
    });

    expect(conferido).toEqual({ falha: null, trocoCents: 0 });
  });

  it('faltando, a comanda não fecha', () => {
    const conferido = conferirPagamento({
      totalCents: 12000,
      pagamentos: [{ forma: 'pix', valorCents: 5000 }],
    });
    expect(conferido.falha).toBe('falta_pagar');
  });

  it('dinheiro a mais vira troco', () => {
    const conferido = conferirPagamento({
      totalCents: 7000,
      pagamentos: [{ forma: 'cash', valorCents: 10000 }],
    });
    expect(conferido).toEqual({ falha: null, trocoCents: 3000 });
  });

  it('cartão a mais é erro de digitação, não troco', () => {
    // Ninguém devolve troco de cartão. Aceitar isso produziria receita que
    // nunca entrou, e a conciliação com o adquirente nunca fecharia.
    const conferido = conferirPagamento({
      totalCents: 7000,
      pagamentos: [{ forma: 'credit', valorCents: 10000 }],
    });
    expect(conferido.falha).toBe('pagou_demais');
  });

  it('troco sai só da parte em dinheiro numa divisão', () => {
    const conferido = conferirPagamento({
      totalCents: 7000,
      pagamentos: [
        { forma: 'credit', valorCents: 5000 },
        { forma: 'cash', valorCents: 5000 },
      ],
    });
    expect(conferido).toEqual({ falha: null, trocoCents: 3000 });
  });

  it('recusa valor zero, negativo e forma inventada', () => {
    expect(
      conferirPagamento({ totalCents: 100, pagamentos: [{ forma: 'cash', valorCents: 0 }] }).falha,
    ).toBe('valor_invalido');
    // `fiado` era o exemplo de forma inventada aqui até ele virar forma de
    // verdade, quando subiu para o MVP. Trocado por uma que continua não
    // existindo — o teste é sobre a lista fechada, não sobre esta palavra.
    expect(
      conferirPagamento({
        totalCents: 100,
        pagamentos: [{ forma: 'cheque' as never, valorCents: 100 }],
      }).falha,
    ).toBe('forma_invalida');
  });

  it('comanda de cortesia fecha sem pagamento', () => {
    expect(conferirPagamento({ totalCents: 0, pagamentos: [] })).toEqual({
      falha: null,
      trocoCents: 0,
    });
  });
});

describe('gaveta', () => {
  it('só dinheiro entra, e já sem o troco', () => {
    // Somar o recebido sem tirar o troco faz o fechamento acusar sobra que não
    // existe — e sobra inexplicada vira desconfiança do operador.
    expect(
      entraNaGaveta({
        pagamentos: [
          { forma: 'cash', valorCents: 10000 },
          { forma: 'pix', valorCents: 2000 },
        ],
        trocoCents: 3000,
      }),
    ).toBe(7000);
  });

  it('comanda paga só no cartão não move a gaveta', () => {
    expect(
      entraNaGaveta({ pagamentos: [{ forma: 'credit', valorCents: 9000 }], trocoCents: 0 }),
    ).toBe(0);
  });
});

describe('fechamento de caixa', () => {
  const abertura = { tipo: 'opening' as const, valorCents: 20000 };

  it('o esperado é a soma dos movimentos', () => {
    expect(
      esperadoNaGaveta([
        abertura,
        { tipo: 'sale', valorCents: 7000 },
        { tipo: 'withdrawal', valorCents: -10000 },
      ]),
    ).toBe(17000);
  });

  it('bater é divergência zero, e zero também é registrado', () => {
    // Guardar só quando diferente tornaria impossível distinguir "conferiu e
    // bateu" de "ninguém conferiu".
    const fechado = fecharCaixa({ movimentos: [abertura], contadoCents: 20000 });
    expect(fechado).toEqual({ esperadoCents: 20000, contadoCents: 20000, divergenciaCents: 0 });
  });

  it('falta na gaveta é divergência negativa', () => {
    const fechado = fecharCaixa({ movimentos: [abertura], contadoCents: 19500 });
    expect(fechado.divergenciaCents).toBe(-500);
  });

  it('sobra na gaveta é divergência positiva', () => {
    const fechado = fecharCaixa({ movimentos: [abertura], contadoCents: 20500 });
    expect(fechado.divergenciaCents).toBe(500);
  });

  it('sangria reduz o esperado; suprimento aumenta', () => {
    const fechado = fecharCaixa({
      movimentos: [
        abertura,
        { tipo: 'withdrawal', valorCents: -15000 },
        { tipo: 'supply', valorCents: 5000 },
      ],
      contadoCents: 10000,
    });
    expect(fechado.esperadoCents).toBe(10000);
    expect(fechado.divergenciaCents).toBe(0);
  });
});

describe('fiado', () => {
  const conta = { saldoCents: 0, limiteCents: 10000 };

  it('fia dentro do limite', () => {
    expect(podeFiar({ conta, valorCents: 7000 })).toBe(true);
  });

  it('o limite é sobre a dívida depois, não sobre o valor pedido', () => {
    // Quem já deve R$ 80 com limite de R$ 100 fia R$ 20, não R$ 100.
    const devendo = { saldoCents: -8000, limiteCents: 10000 };
    expect(podeFiar({ conta: devendo, valorCents: 2000 })).toBe(true);
    expect(podeFiar({ conta: devendo, valorCents: 2100 })).toBe(false);
    expect(fiadoDisponivel(devendo)).toBe(2000);
  });

  it('crédito na conta aumenta o que cabe de fiado', () => {
    const comCredito = { saldoCents: 3000, limiteCents: 10000 };
    expect(fiadoDisponivel(comCredito)).toBe(13000);
  });

  it('limite zero significa não fia', () => {
    expect(podeFiar({ conta: { saldoCents: 0, limiteCents: 0 }, valorCents: 100 })).toBe(false);
    expect(fiadoDisponivel({ saldoCents: 0, limiteCents: 0 })).toBe(0);
  });

  it('fiado sem cliente identificado não fecha a comanda', () => {
    // Dívida sem dono é dívida que a barbearia descobre no fim do mês e não
    // consegue cobrar de ninguém.
    const conferido = conferirPagamento({
      totalCents: 7000,
      pagamentos: [{ forma: 'fiado', valorCents: 7000 }],
    });
    expect(conferido.falha).toBe('fiado_sem_cliente');
  });

  it('fiado acima do limite é recusado', () => {
    const conferido = conferirPagamento({
      totalCents: 15000,
      pagamentos: [{ forma: 'fiado', valorCents: 15000 }],
      conta,
    });
    expect(conferido.falha).toBe('fiado_acima_do_limite');
  });

  it('parte no dinheiro e parte fiado é caso real e passa', () => {
    const conferido = conferirPagamento({
      totalCents: 10000,
      pagamentos: [
        { forma: 'cash', valorCents: 4000 },
        { forma: 'fiado', valorCents: 6000 },
      ],
      conta,
    });
    expect(conferido).toEqual({ falha: null, trocoCents: 0 });
  });

  it('ninguém fia e leva troco', () => {
    // Sobrou com fiado na conta é digitação errada, e o desfecho seria a
    // barbearia dar dinheiro a quem ficou devendo.
    const conferido = conferirPagamento({
      totalCents: 7000,
      pagamentos: [
        { forma: 'cash', valorCents: 10000 },
        { forma: 'fiado', valorCents: 2000 },
      ],
      conta,
    });
    expect(conferido.falha).toBe('pagou_demais');
  });

  it('fiado não entra na gaveta nem no faturamento do dia', () => {
    // Somar fiado à receita é como a barbearia comemora um mês que não
    // aconteceu. Não registrá-lo em lugar nenhum é como ela esquece de cobrar.
    const resultado = resultadoDoPagamento({
      pagamentos: [
        { forma: 'cash', valorCents: 4000 },
        { forma: 'credit', valorCents: 3000 },
        { forma: 'fiado', valorCents: 6000 },
      ],
      trocoCents: 0,
    });

    expect(resultado).toEqual({
      naGavetaCents: 4000,
      receitaAgoraCents: 7000,
      aReceberCents: 6000,
      trocoCents: 0,
    });
  });

  it('o troco sai da gaveta e da receita, nunca do a receber', () => {
    const resultado = resultadoDoPagamento({
      pagamentos: [{ forma: 'cash', valorCents: 10000 }],
      trocoCents: 3000,
    });
    expect(resultado.naGavetaCents).toBe(7000);
    expect(resultado.receitaAgoraCents).toBe(7000);
    expect(resultado.aReceberCents).toBe(0);
  });
});

describe('teto de desconto da barbearia', () => {
  it('vinte por cento de R$ 100,00 são R$ 20,00', () => {
    expect(tetoDoDesconto(10_000, 2000)).toBe(2000);
  });

  /**
   * O arredondamento tem lado, como o do rateio do bloco 28.
   *
   * 20% de R$ 33,33 são 666,6 centavos. Para baixo: quem escreveu "vinte por
   * cento" não autorizou o centavo que passa.
   */
  it('arredonda para baixo, nunca a favor de quem dá o desconto', () => {
    expect(tetoDoDesconto(3333, 2000)).toBe(666);
  });

  it('zero desliga o desconto e cem por cento libera tudo', () => {
    expect(tetoDoDesconto(10_000, 0)).toBe(0);
    expect(tetoDoDesconto(10_000, 10_000)).toBe(10_000);
  });

  it('pontos-base fora da faixa são grampeados, não explodem', () => {
    expect(tetoDoDesconto(10_000, -500)).toBe(0);
    expect(tetoDoDesconto(10_000, 99_999)).toBe(10_000);
  });

  it('o teto é sobre o subtotal, então comanda vazia não libera nada', () => {
    expect(tetoDoDesconto(0, 10_000)).toBe(0);
  });
});
