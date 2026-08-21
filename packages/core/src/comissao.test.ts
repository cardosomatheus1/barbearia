import { describe, expect, it } from 'vitest';
import {
  aplicarFaixas,
  baseDoItem,
  comissaoDoPeriodo,
  escolherRegra,
  ratearDesconto,
  validarRegra,
  type FaixaDeComissao,
  type ItemComissionavel,
  type LancamentoDeComissao,
  type RegraDeComissao,
  taxaDaVenda,
  ratearTaxa,
  taxaSobreOsItens,
  ratearGorjeta,
} from './comissao.js';

/**
 * Comissão é o número que o barbeiro confere no fim do mês.
 *
 * Errar aqui não produz um bug que alguém abre chamado: produz uma discussão no
 * balcão, uma vez por mês, com o dono tendo que defender de cabeça uma conta
 * que o sistema fez. Por isso cada regra tem um caso que a derruba.
 */

const RUAN = 'pro-ruan';
const GLEIDSON = 'pro-gleidson';

const regra = (p: Partial<RegraDeComissao> & { id: string }): RegraDeComissao => ({
  professionalId: null,
  serviceId: null,
  categoryId: null,
  modo: 'percent',
  valor: 4000,
  faixas: [],
  ...p,
});

const item = (p: Partial<ItemComissionavel> & { id: string }): ItemComissionavel => ({
  professionalId: RUAN,
  serviceId: null,
  categoryId: null,
  totalCents: 5000,
  ...p,
});

const lancamento = (
  p: Partial<LancamentoDeComissao> & { itemId: string },
): LancamentoDeComissao => ({
  professionalId: RUAN,
  regraId: 'r1',
  modo: 'percent',
  valor: 4000,
  faixas: [],
  baseCents: 10_000,
  sinal: 1,
  ...p,
});

describe('rateio do desconto', () => {
  it('divide proporcional ao valor de cada item', () => {
    // Corte 40 do Ruan e barba 60 do Gleidson, com 10 de desconto: 4 e 6.
    const rateio = ratearDesconto({
      itens: [
        item({ id: 'corte', totalCents: 4000 }),
        item({ id: 'barba', totalCents: 6000, professionalId: GLEIDSON }),
      ],
      descontoCents: 1000,
    });

    expect(rateio.get('corte')).toBe(400);
    expect(rateio.get('barba')).toBe(600);
  });

  it('a soma das partes é exatamente o desconto, mesmo sem divisão exata', () => {
    /**
     * A regra que mais importa deste arquivo.
     *
     * Três itens iguais dividindo dez centavos dão 3,33 cada. Arredondando para
     * baixo somam 9 e um centavo some da conta da casa **a cada comanda**.
     * Arredondando para cima somam 12 e a casa devolve dois que não deu.
     */
    const rateio = ratearDesconto({
      itens: [
        item({ id: 'a', totalCents: 1000 }),
        item({ id: 'b', totalCents: 1000 }),
        item({ id: 'c', totalCents: 1000 }),
      ],
      descontoCents: 10,
    });

    const soma = [...rateio.values()].reduce((s, v) => s + v, 0);
    expect(soma).toBe(10);
    expect([...rateio.values()].sort()).toEqual([3, 3, 4]);
  });

  it('a sobra vai para o item de maior valor, não para o primeiro da lista', () => {
    // Determinístico: a mesma comanda tem que dar sempre o mesmo resultado,
    // senão dois relatórios do mesmo mês divergem por um centavo.
    const rateio = ratearDesconto({
      itens: [
        item({ id: 'pequeno', totalCents: 1000 }),
        item({ id: 'grande', totalCents: 2000 }),
      ],
      descontoCents: 1,
    });

    expect(rateio.get('grande')).toBe(1);
    expect(rateio.get('pequeno')).toBe(0);
  });

  it('a ordem dos itens não muda o resultado', () => {
    const itens = [
      item({ id: 'a', totalCents: 3300 }),
      item({ id: 'b', totalCents: 3300 }),
      item({ id: 'c', totalCents: 3400 }),
    ];
    const direto = ratearDesconto({ itens, descontoCents: 777 });
    const invertido = ratearDesconto({ itens: [...itens].reverse(), descontoCents: 777 });

    for (const id of ['a', 'b', 'c']) {
      expect(direto.get(id), id).toBe(invertido.get(id));
    }
  });

  it('desconto zero não tira nada de ninguém', () => {
    const rateio = ratearDesconto({
      itens: [item({ id: 'a' }), item({ id: 'b' })],
      descontoCents: 0,
    });
    expect([...rateio.values()]).toEqual([0, 0]);
  });

  it('desconto maior que a comanda não vira crédito para o barbeiro', () => {
    // Não deveria acontecer — o banco tem CHECK —, mas se acontecer a base
    // zera, e não fica negativa puxando a comissão do resto do mês para baixo.
    const rateio = ratearDesconto({
      itens: [item({ id: 'a', totalCents: 1000 })],
      descontoCents: 999_999,
    });
    expect(rateio.get('a')).toBe(1000);
  });

  it('comanda de valor zero não divide por zero', () => {
    const rateio = ratearDesconto({
      itens: [item({ id: 'cortesia', totalCents: 0 })],
      descontoCents: 500,
    });
    expect(rateio.get('cortesia')).toBe(0);
  });
});

describe('qual regra vale', () => {
  const geral = regra({ id: 'geral', valor: 4000 });
  const daBarba = regra({ id: 'barba', serviceId: 'sv-barba', valor: 5000 });
  const doRuanNaBarba = regra({
    id: 'ruan-barba',
    professionalId: RUAN,
    serviceId: 'sv-barba',
    valor: 4500,
  });

  it('a mais específica ganha da mais geral', () => {
    const escolhida = escolherRegra([geral, daBarba, doRuanNaBarba], {
      professionalId: RUAN,
      serviceId: 'sv-barba',
      categoryId: null,
    });
    expect(escolhida?.id).toBe('ruan-barba');
  });

  it('profissional pesa mais que serviço', () => {
    // "45% para o Ruan em tudo" vence "50% na barba para todos": a regra que
    // nomeia a pessoa é a que foi combinada com ela.
    const doRuan = regra({ id: 'ruan', professionalId: RUAN, valor: 4500 });
    const escolhida = escolherRegra([geral, daBarba, doRuan], {
      professionalId: RUAN,
      serviceId: 'sv-barba',
      categoryId: null,
    });
    expect(escolhida?.id).toBe('ruan');
  });

  it('regra de outro profissional não se aplica', () => {
    const escolhida = escolherRegra([geral, doRuanNaBarba], {
      professionalId: GLEIDSON,
      serviceId: 'sv-barba',
      categoryId: null,
    });
    expect(escolhida?.id).toBe('geral');
  });

  it('sem regra que caiba, devolve nulo em vez de inventar alíquota', () => {
    // Zero por omissão seria pior: o barbeiro receberia nada e o sistema não
    // diria por quê. Quem chama decide o que fazer com a ausência.
    const soDoRuan = regra({ id: 'ruan', professionalId: RUAN });
    expect(
      escolherRegra([soDoRuan], {
        professionalId: GLEIDSON,
        serviceId: null,
        categoryId: null,
      }),
    ).toBeNull();
  });

  it('empate de especificidade é resolvido pelo id, não pela ordem da lista', () => {
    const a = regra({ id: 'aaa', serviceId: 'sv-barba', valor: 4000 });
    const b = regra({ id: 'bbb', serviceId: 'sv-barba', valor: 9000 });
    const alvo = { professionalId: RUAN, serviceId: 'sv-barba', categoryId: null };

    expect(escolherRegra([a, b], alvo)?.id).toBe('aaa');
    expect(escolherRegra([b, a], alvo)?.id).toBe('aaa');
  });
});

describe('a base do item', () => {
  it('líquido desconta o rateio', () => {
    const base = baseDoItem({
      item: item({ id: 'a', totalCents: 5000 }),
      descontoRateadoCents: 500,
      base: 'liquido',
      tratamentoDoDesconto: 'reduz_base',
    });
    expect(base).toBe(4500);
  });

  it('bruto ignora o desconto', () => {
    const base = baseDoItem({
      item: item({ id: 'a', totalCents: 5000 }),
      descontoRateadoCents: 500,
      base: 'bruto',
      tratamentoDoDesconto: 'reduz_base',
    });
    expect(base).toBe(5000);
  });

  it('"desconto é custo da casa" preserva a base do barbeiro', () => {
    // O desconto costuma ser decisão do dono. Fazer o barbeiro pagar por uma
    // cortesia que ele não ofereceu é a segunda maior fonte de discussão.
    const base = baseDoItem({
      item: item({ id: 'a', totalCents: 5000 }),
      descontoRateadoCents: 5000,
      base: 'liquido',
      tratamentoDoDesconto: 'custo_da_casa',
    });
    expect(base).toBe(5000);
  });
});

describe('faixas progressivas', () => {
  const FAIXAS: FaixaDeComissao[] = [
    { ateCents: 500_000, pontosBase: 4000 },
    { ateCents: 800_000, pontosBase: 4500 },
    { ateCents: null, pontosBase: 5000 },
  ];

  it('cada faixa incide só sobre a parte que cai nela', () => {
    // 6.000 = 5.000 a 40% + 1.000 a 45% = 2.000 + 450.
    expect(aplicarFaixas(FAIXAS, 600_000)).toBe(200_000 + 45_000);
  });

  it('nunca chega ao que a alíquota da faixa alcançada daria sobre tudo', () => {
    /**
     * A diferença entre progressiva e degrau, afirmada por propriedade.
     *
     * A primeira versão deste teste dizia `not.toBe(270_000)` — a resposta que
     * a regra do degrau daria com 45%. Quebrei a implementação de propósito e
     * ele passou mesmo assim: a quebra devolveu 300.000, que também é errado e
     * também não é 270.000. Negar **uma** resposta errada não é o mesmo que
     * exigir a certa.
     *
     * Marginal implica que o resultado fica estritamente abaixo de aplicar a
     * alíquota alcançada sobre a base inteira — sempre que mais de uma faixa
     * foi usada.
     */
    for (const base of [600_000, 900_000, 1_500_000]) {
      const alcancada = FAIXAS.find((f) => f.ateCents === null || base <= f.ateCents);
      const degrau = Math.round((base * (alcancada?.pontosBase ?? 0)) / 10_000);
      expect(aplicarFaixas(FAIXAS, base), `base ${base}`).toBeLessThan(degrau);
    }
  });

  it('dentro da primeira faixa é percentual simples', () => {
    expect(aplicarFaixas(FAIXAS, 100_000)).toBe(40_000);
  });

  it('exatamente no teto da faixa ainda é a alíquota dela', () => {
    // Fronteira: 5.000 cravados são 5.000 a 40%, não 4.999 a 40% e 1 a 45%.
    expect(aplicarFaixas(FAIXAS, 500_000)).toBe(200_000);
  });

  it('acima do último teto usa a faixa aberta', () => {
    // 9.000 = 5.000 a 40% + 3.000 a 45% + 1.000 a 50%.
    expect(aplicarFaixas(FAIXAS, 900_000)).toBe(200_000 + 135_000 + 50_000);
  });

  it('um real a mais nunca dá um salto de comissão', () => {
    // A propriedade que define "progressiva": a função é contínua nas duas
    // fronteiras. Com a regra do degrau, cada uma destas diferenças seria de
    // centenas de reais.
    for (const fronteira of [500_000, 800_000]) {
      const antes = aplicarFaixas(FAIXAS, fronteira - 100);
      const depois = aplicarFaixas(FAIXAS, fronteira + 100);
      expect(depois - antes, `fronteira ${fronteira}`).toBeLessThanOrEqual(100);
    }
  });

  it('base zero não gera comissão', () => {
    expect(aplicarFaixas(FAIXAS, 0)).toBe(0);
  });
});

describe('validação da regra', () => {
  it('recusa alíquota acima de 100%', () => {
    // Acima disso a casa paga para atender. É erro de digitação — 400% é "40"
    // com um zero a mais.
    expect(validarRegra({ modo: 'percent', valor: 40_000 })).toBe('aliquota_invalida');
  });

  it('recusa alíquota negativa', () => {
    expect(validarRegra({ modo: 'percent', valor: -1 })).toBe('aliquota_invalida');
  });

  it('aceita 100% — a barbearia que aluga a cadeira existe', () => {
    expect(validarRegra({ modo: 'percent', valor: 10_000 })).toBeNull();
  });

  it('faixas precisam terminar em aberto', () => {
    // Sem a faixa aberta, faturamento acima do último teto ficaria sem
    // alíquota — e o barbeiro deixaria de receber justo no melhor mês.
    expect(
      validarRegra({
        modo: 'tiers',
        valor: 0,
        faixas: [{ ateCents: 500_000, pontosBase: 4000 }],
      }),
    ).toBe('faixas_invalidas');
  });

  it('faixas precisam ser crescentes', () => {
    expect(
      validarRegra({
        modo: 'tiers',
        valor: 0,
        faixas: [
          { ateCents: 800_000, pontosBase: 4000 },
          { ateCents: 500_000, pontosBase: 4500 },
          { ateCents: null, pontosBase: 5000 },
        ],
      }),
    ).toBe('faixas_invalidas');
  });

  it('modo por faixas sem faixa nenhuma é recusado', () => {
    expect(validarRegra({ modo: 'tiers', valor: 0, faixas: [] })).toBe('faixas_ausentes');
  });

  it('valor fixo negativo é recusado', () => {
    expect(validarRegra({ modo: 'fixed', valor: -100 })).toBe('valor_invalido');
  });
});

describe('a conta do período', () => {
  it('soma percentual por lançamento', () => {
    const conta = comissaoDoPeriodo([
      lancamento({ itemId: 'a', baseCents: 10_000, valor: 4000 }),
      lancamento({ itemId: 'b', baseCents: 5_000, valor: 4000 }),
    ]);

    expect(conta).toEqual([{ professionalId: RUAN, baseCents: 15_000, comissaoCents: 6_000 }]);
  });

  it('separa profissionais', () => {
    const conta = comissaoDoPeriodo([
      lancamento({ itemId: 'a', professionalId: RUAN, baseCents: 10_000 }),
      lancamento({ itemId: 'b', professionalId: GLEIDSON, baseCents: 20_000 }),
    ]);

    expect(conta).toHaveLength(2);
    expect(conta.find((c) => c.professionalId === GLEIDSON)?.comissaoCents).toBe(8_000);
  });

  it('valor fixo é por item, não por real faturado', () => {
    const conta = comissaoDoPeriodo([
      lancamento({ itemId: 'a', modo: 'fixed', valor: 500, baseCents: 10_000 }),
      lancamento({ itemId: 'b', modo: 'fixed', valor: 500, baseCents: 90_000 }),
    ]);
    expect(conta[0]?.comissaoCents).toBe(1_000);
  });

  it('a faixa olha o acumulado do período, não o item', () => {
    /**
     * O motivo de o lançamento guardar base e não valor pronto.
     *
     * Dois cortes de 3.000 no mesmo mês somam 6.000: os primeiros 5.000 a 40%
     * e os 1.000 seguintes a 45%. Calculado item a item, cada um cairia na
     * primeira faixa e o barbeiro receberia 2.400 em vez de 2.450.
     */
    const faixas: FaixaDeComissao[] = [
      { ateCents: 500_000, pontosBase: 4000 },
      { ateCents: null, pontosBase: 4500 },
    ];
    const conta = comissaoDoPeriodo([
      lancamento({ itemId: 'a', modo: 'tiers', faixas, baseCents: 300_000 }),
      lancamento({ itemId: 'b', modo: 'tiers', faixas, baseCents: 300_000 }),
    ]);

    expect(conta[0]?.comissaoCents).toBe(200_000 + 45_000);
  });

  it('estorno derruba a faixa do período inteiro', () => {
    // O que só funciona porque o valor é derivado: sem o estorno o barbeiro
    // estava em 6.000 e na segunda faixa; com ele volta para 3.000 e a segunda
    // faixa deixa de existir — sem reescrever lançamento nenhum.
    const faixas: FaixaDeComissao[] = [
      { ateCents: 500_000, pontosBase: 4000 },
      { ateCents: null, pontosBase: 4500 },
    ];
    const conta = comissaoDoPeriodo([
      lancamento({ itemId: 'a', modo: 'tiers', faixas, baseCents: 300_000 }),
      lancamento({ itemId: 'b', modo: 'tiers', faixas, baseCents: 300_000 }),
      lancamento({ itemId: 'b-estorno', modo: 'tiers', faixas, baseCents: 300_000, sinal: -1 }),
    ]);

    expect(conta[0]).toEqual({ professionalId: RUAN, baseCents: 300_000, comissaoCents: 120_000 });
  });

  it('estorno de percentual entra negativo', () => {
    const conta = comissaoDoPeriodo([
      lancamento({ itemId: 'a', baseCents: 10_000 }),
      lancamento({ itemId: 'a-estorno', baseCents: 10_000, sinal: -1 }),
    ]);
    expect(conta[0]).toEqual({ professionalId: RUAN, baseCents: 0, comissaoCents: 0 });
  });

  it('regras de faixa diferentes não somam a base uma da outra', () => {
    // Um barbeiro pode ter a faixa do corte e a do produto no mesmo mês.
    // Misturar as bases faria a faixa do corte subir por causa de shampoo.
    const faixaA: FaixaDeComissao[] = [{ ateCents: null, pontosBase: 4000 }];
    const faixaB: FaixaDeComissao[] = [{ ateCents: null, pontosBase: 1000 }];
    const conta = comissaoDoPeriodo([
      lancamento({ itemId: 'a', regraId: 'corte', modo: 'tiers', faixas: faixaA, baseCents: 10_000 }),
      lancamento({ itemId: 'b', regraId: 'produto', modo: 'tiers', faixas: faixaB, baseCents: 10_000 }),
    ]);
    expect(conta[0]?.comissaoCents).toBe(4_000 + 1_000);
  });

  it('mistura de modalidades no mesmo profissional soma tudo', () => {
    const faixas: FaixaDeComissao[] = [{ ateCents: null, pontosBase: 5000 }];
    const conta = comissaoDoPeriodo([
      lancamento({ itemId: 'a', modo: 'percent', valor: 4000, baseCents: 10_000 }),
      lancamento({ itemId: 'b', modo: 'fixed', valor: 300, baseCents: 2_000 }),
      lancamento({ itemId: 'c', regraId: 'r2', modo: 'tiers', faixas, baseCents: 10_000 }),
    ]);
    expect(conta[0]).toEqual({
      professionalId: RUAN,
      baseCents: 22_000,
      comissaoCents: 4_000 + 300 + 5_000,
    });
  });

  it('período sem lançamento é lista vazia, não erro', () => {
    expect(comissaoDoPeriodo([])).toEqual([]);
  });
});

/**
 * A taxa do adquirente na comissão (bloco 36, SPEC §3.4).
 *
 * A terceira escolha que a SPEC exige que seja explícita, e a que ficou de fora
 * por seis blocos — não por esquecimento, mas porque a alíquota do adquirente
 * não existia em lugar nenhum do produto.
 */
describe('a taxa do adquirente', () => {
  const aliquotas = new Map([
    ['credit', 319],
    ['debit', 199],
    ['pix', 99],
  ]);

  it('cada meio paga a própria alíquota', () => {
    // Crédito parcelado custa múltiplas vezes o que custa débito, e Pix quase
    // nada. Uma alíquota média produziria um número que não bate com extrato
    // nenhum — e o extrato é o documento que o dono abre quando desconfia.
    expect(
      taxaDaVenda({ pagamentos: [{ forma: 'credit', valorCents: 10_000 }], aliquotasBps: aliquotas }),
    ).toBe(319);
    expect(
      taxaDaVenda({ pagamentos: [{ forma: 'debit', valorCents: 10_000 }], aliquotasBps: aliquotas }),
    ).toBe(199);
  });

  it('meio sem alíquota cadastrada não custa nada', () => {
    // A barbearia cadastra só o que paga. Obrigar a declarar `dinheiro = 0`
    // seria pedir o óbvio para poder declarar o que importa.
    expect(
      taxaDaVenda({ pagamentos: [{ forma: 'cash', valorCents: 10_000 }], aliquotasBps: aliquotas }),
    ).toBe(0);
  });

  it('arredonda por transação, não sobre o total', () => {
    /**
     * É assim que o adquirente cobra: uma tarifa por transação. Somar primeiro
     * e aplicar a alíquota depois dá outro número — e a diferença aparece
     * justamente na conciliação com o extrato, que é onde ela custa mais caro
     * de explicar.
     */
    const partido = taxaDaVenda({
      pagamentos: [
        { forma: 'credit', valorCents: 3_333 },
        { forma: 'credit', valorCents: 3_333 },
      ],
      aliquotasBps: aliquotas,
    });
    // 3333 × 3,19% = 106,32 → 106, duas vezes.
    expect(partido).toBe(212);
    // Contra 6666 × 3,19% = 212,64 → 213. Um centavo de diferença, e ele é do
    // jeito que o adquirente faz.
    expect(partido).not.toBe(213);
  });

  it('a conta mista soma cada parte pela alíquota dela', () => {
    // "Cem no Pix e o resto no crédito" é rotina de balcão.
    expect(
      taxaDaVenda({
        pagamentos: [
          { forma: 'pix', valorCents: 10_000 },
          { forma: 'credit', valorCents: 10_000 },
        ],
        aliquotasBps: aliquotas,
      }),
    ).toBe(99 + 319);
  });
});

describe('a taxa na base da comissão', () => {
  const item = { id: 'i1', professionalId: 'p1', serviceId: null, categoryId: null, totalCents: 10_000 };

  it('absorvida não muda nada — é o que o produto sempre fez', () => {
    // Padrão, e de propósito: um padrão `rateada` faria toda barbearia que já
    // usa o sistema ver a comissão de todo mundo cair no dia da migração, sem
    // ninguém ter decidido nada.
    expect(
      baseDoItem({
        item,
        descontoRateadoCents: 0,
        base: 'liquido',
        tratamentoDoDesconto: 'reduz_base',
        taxaRateadaCents: 319,
        tratamentoDaTaxa: 'absorvida',
      }),
    ).toBe(10_000);
  });

  it('rateada desce a taxa da base', () => {
    expect(
      baseDoItem({
        item,
        descontoRateadoCents: 0,
        base: 'liquido',
        tratamentoDoDesconto: 'reduz_base',
        taxaRateadaCents: 319,
        tratamentoDaTaxa: 'rateada',
      }),
    ).toBe(9_681);
  });

  it('desconto e taxa descem juntos, sem um comer o outro', () => {
    // São deduções independentes: quem deu o desconto foi alguém, a taxa não é
    // de ninguém. Tratar as duas como a mesma faria o barbeiro pagar uma vez o
    // que deveria pagar duas — ou o contrário, dependendo da ordem.
    expect(
      baseDoItem({
        item,
        descontoRateadoCents: 1_000,
        base: 'liquido',
        tratamentoDoDesconto: 'reduz_base',
        taxaRateadaCents: 319,
        tratamentoDaTaxa: 'rateada',
      }),
    ).toBe(8_681);
  });

  it('bruto ignora as duas, e é o que a palavra significa', () => {
    /**
     * Deixar a taxa descer sobre a base bruta faria "bruto" querer dizer
     * "bruto, menos uma coisa" — o tipo de definição que ninguém consegue
     * explicar para o barbeiro no dia do acerto.
     */
    expect(
      baseDoItem({
        item,
        descontoRateadoCents: 1_000,
        base: 'bruto',
        tratamentoDoDesconto: 'reduz_base',
        taxaRateadaCents: 319,
        tratamentoDaTaxa: 'rateada',
      }),
    ).toBe(10_000);
  });

  it('a base nunca fica negativa', () => {
    // Taxa maior que o item é caso de erro de cadastro, e o resultado não pode
    // ser comissão negativa aparecendo como desconto no acerto do barbeiro.
    expect(
      baseDoItem({
        item: { ...item, totalCents: 100 },
        descontoRateadoCents: 0,
        base: 'liquido',
        tratamentoDoDesconto: 'reduz_base',
        taxaRateadaCents: 500,
        tratamentoDaTaxa: 'rateada',
      }),
    ).toBe(0);
  });

  it('a taxa é rateada proporcionalmente, e a sobra não some', () => {
    // Mesmo critério do desconto: a taxa é da venda inteira e a comissão é por
    // item. Sem ratear, quem cortou o cabelo pagaria sozinho a maquininha da
    // conta toda.
    const itens = [
      { id: 'a', professionalId: 'p1', serviceId: null, categoryId: null, totalCents: 3_333 },
      { id: 'b', professionalId: 'p2', serviceId: null, categoryId: null, totalCents: 3_333 },
      { id: 'c', professionalId: 'p3', serviceId: null, categoryId: null, totalCents: 3_334 },
    ];
    const rateio = ratearTaxa({ itens, taxaCents: 319 });

    const soma = [...rateio.values()].reduce((s, v) => s + v, 0);
    expect(soma).toBe(319);
  });
});

/**
 * A gorjeta e o troco fora da base da taxa (achados da revisão do bloco 36).
 *
 * Os dois pela mesma causa: a taxa era calculada sobre o que o balcão digitou,
 * e não sobre o dinheiro que ficou com a barbearia.
 */
describe('a taxa não cobra o que não é receita', () => {
  const aliquotas = new Map([
    ['cash', 100],
    ['credit', 319],
  ]);

  it('o troco sai da base — ele voltou para o bolso do cliente', () => {
    // Conta de R$ 60, cliente entrega R$ 100. Cobrar tarifa sobre os R$ 40 de
    // troco é cobrar de dinheiro que nunca ficou com a barbearia.
    expect(
      taxaDaVenda({
        pagamentos: [{ forma: 'cash', valorCents: 10_000 }],
        aliquotasBps: aliquotas,
        trocoCents: 4_000,
      }),
    ).toBe(60);
  });

  it('sem troco, nada muda', () => {
    expect(
      taxaDaVenda({
        pagamentos: [{ forma: 'cash', valorCents: 6_000 }],
        aliquotasBps: aliquotas,
      }),
    ).toBe(60);
  });

  it('o troco sai só do dinheiro vivo, nunca do cartão', () => {
    // Ele sempre sai da gaveta — é a mesma regra de `entraNaGaveta`. Abater do
    // crédito faria a taxa do cartão encolher por um troco que não é dele.
    expect(
      taxaDaVenda({
        pagamentos: [
          { forma: 'credit', valorCents: 10_000 },
          { forma: 'cash', valorCents: 5_000 },
        ],
        aliquotasBps: aliquotas,
        trocoCents: 2_000,
      }),
    ).toBe(319 + 30);
  });

  it('a gorjeta não desce da base do barbeiro', () => {
    /**
     * O aparelho cobra sobre tudo que passa nele, gorjeta inclusive — mas a
     * taxa é rateada só sobre os itens. Ratear o valor cheio faria o barbeiro
     * pagar tarifa sobre a própria gorjeta, que "nunca entra na base".
     */
    // R$ 100 de item + R$ 20 de gorjeta, crédito: a taxa cheia é 383.
    const cheia = taxaDaVenda({
      pagamentos: [{ forma: 'credit', valorCents: 12_000 }],
      aliquotasBps: aliquotas,
    });
    expect(cheia).toBe(383);

    // O que desce da base é a parte dos R$ 100 vendidos.
    expect(taxaSobreOsItens({ taxaCents: cheia, receitaCents: 10_000, cobradoCents: 12_000 })).toBe(
      319,
    );
  });

  it('sem gorjeta, a taxa inteira desce', () => {
    expect(taxaSobreOsItens({ taxaCents: 319, receitaCents: 10_000, cobradoCents: 10_000 })).toBe(
      319,
    );
  });

  it('venda que é só gorjeta não desce nada da base', () => {
    // Caso de borda real: cortesia com gorjeta. Sem receita não há o que ratear.
    expect(taxaSobreOsItens({ taxaCents: 60, receitaCents: 0, cobradoCents: 2_000 })).toBe(0);
  });
});

describe('a gorjeta tem dono', () => {
  const item = (id: string, professionalId: string | null, totalCents: number) => ({
    id,
    professionalId,
    serviceId: null,
    categoryId: null,
    totalCents,
  });

  it('o dono declarado leva tudo', () => {
    // "Os dez são do João": o cliente disse, e não há o que ratear.
    const rateio = ratearGorjeta({
      itens: [item('a', 'joao', 5000), item('b', 'ruan', 5000)],
      gorjetaCents: 1000,
      professionalId: 'joao',
    });
    expect(rateio.get('joao')).toBe(1000);
    expect(rateio.get('ruan')).toBeUndefined();
  });

  it('sem dono declarado, segue o peso da receita', () => {
    /**
     * Corte de R$ 60 com o João e barba de R$ 40 com o Ruan: a gorjeta de R$ 10
     * sai 6 e 4. Atribuir ao primeiro item faria o corte carregar a gorjeta da
     * barba — é a mesma razão do rateio da taxa e do insumo.
     */
    const rateio = ratearGorjeta({
      itens: [item('a', 'joao', 6000), item('b', 'ruan', 4000)],
      gorjetaCents: 1000,
    });
    expect(rateio.get('joao')).toBe(600);
    expect(rateio.get('ruan')).toBe(400);
  });

  it('a mesma pessoa em dois itens recebe a soma, não duas linhas', () => {
    const rateio = ratearGorjeta({
      itens: [item('a', 'joao', 5000), item('b', 'joao', 5000)],
      gorjetaCents: 1000,
    });
    expect([...rateio.entries()]).toEqual([['joao', 1000]]);
  });

  it('o produto vendido no balcão não conta no peso', () => {
    /**
     * A pomada não atendeu ninguém. Contando-a, a gorjeta de quem cortou
     * encolheria porque o cliente levou um produto junto.
     */
    const rateio = ratearGorjeta({
      itens: [item('corte', 'joao', 5000), item('pomada', null, 5000)],
      gorjetaCents: 1000,
    });
    expect(rateio.get('joao')).toBe(1000);
  });

  it('comanda só de produto não tem a quem repassar', () => {
    const rateio = ratearGorjeta({
      itens: [item('pomada', null, 5000)],
      gorjetaCents: 1000,
    });
    expect(rateio.size).toBe(0);
  });

  it('a soma das partes é a gorjeta, ao centavo', () => {
    // Três pessoas e R$ 10,00: 333 + 333 + 334. A sobra vai no último, como em
    // todo rateio deste produto.
    const rateio = ratearGorjeta({
      itens: [item('a', 'x', 100), item('b', 'y', 100), item('c', 'z', 100)],
      gorjetaCents: 1000,
    });
    expect([...rateio.values()].reduce((s, v) => s + v, 0)).toBe(1000);
  });
});
