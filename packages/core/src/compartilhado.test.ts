import { describe, expect, it } from 'vitest';
import {
  contaParaAUnidade,
  dividirResgate,
  escopoDoLancamento,
  planoCobreNaUnidade,
  saldoDoFiadoNaUnidade,
  separarPorBolso,
} from './compartilhado.js';

const MATRIZ = 'matriz';
const FILIAL = 'filial';

describe('os dois bolsos do saldo', () => {
  it('o que foi ganho sob empresa vale em qualquer loja', () => {
    expect(contaParaAUnidade({ escopo: 'empresa', unidadeId: MATRIZ }, FILIAL)).toBe(true);
    expect(contaParaAUnidade({ escopo: 'empresa', unidadeId: null }, FILIAL)).toBe(true);
  });

  it('o que foi ganho sob unidade vale só na loja em que foi ganho', () => {
    expect(contaParaAUnidade({ escopo: 'unidade', unidadeId: MATRIZ }, MATRIZ)).toBe(true);
    expect(contaParaAUnidade({ escopo: 'unidade', unidadeId: MATRIZ }, FILIAL)).toBe(false);
  });

  it('separa o razão em compartilhado e da loja, e o FIFO roda dentro de cada um', () => {
    /**
     * Devolver os dois em vez de uma lista só é o que permite consumir a entrada
     * mais antiga **dentro do bolso**: uma saída da loja não pode comer um lote
     * compartilhado sem que a linha diga que comeu.
     */
    const linhas = [
      { escopo: 'empresa' as const, unidadeId: null, nome: 'abril' },
      { escopo: 'unidade' as const, unidadeId: MATRIZ, nome: 'maio na matriz' },
      { escopo: 'unidade' as const, unidadeId: FILIAL, nome: 'maio na filial' },
    ];

    const bolsos = separarPorBolso(linhas, MATRIZ);
    expect(bolsos.compartilhado.map((l) => l.nome)).toEqual(['abril']);
    expect(bolsos.daUnidade.map((l) => l.nome)).toEqual(['maio na matriz']);
  });
});

describe('de onde sai o resgate', () => {
  it('o compartilhado sai primeiro, e é o que impede gastar o mesmo ponto duas vezes', () => {
    /**
     * Se o resgate saísse do bolso da loja, um saldo compartilhado de 300 seria
     * gasto na matriz — deixando o bolso da matriz em −300 — e continuaria
     * inteiro para gastar na filial.
     */
    expect(
      dividirResgate({ quantidade: 100, saldoCompartilhado: 300, saldoDaUnidade: 50 }),
    ).toEqual({ doCompartilhado: 100, daUnidade: 0 });
  });

  it('o que não couber no compartilhado sai do bolso da loja', () => {
    expect(
      dividirResgate({ quantidade: 120, saldoCompartilhado: 100, saldoDaUnidade: 50 }),
    ).toEqual({ doCompartilhado: 100, daUnidade: 20 });
  });

  it('pedido que não cabe nos dois é recusado inteiro, nunca dividido pela metade', () => {
    // Resgatar menos do que se pediu é decidir pelo cliente que ele aceita o
    // troco em nada. A tela precisa dizer quanto falta.
    expect(dividirResgate({ quantidade: 200, saldoCompartilhado: 100, saldoDaUnidade: 50 })).toBeNull();
  });

  it('quantidade não positiva é recusada', () => {
    expect(dividirResgate({ quantidade: 0, saldoCompartilhado: 100, saldoDaUnidade: 50 })).toBeNull();
    expect(dividirResgate({ quantidade: -5, saldoCompartilhado: 100, saldoDaUnidade: 50 })).toBeNull();
  });

  it('sem bolso da loja, tudo sai do compartilhado — que é a barbearia de uma loja só', () => {
    expect(
      dividirResgate({ quantidade: 40, saldoCompartilhado: 40, saldoDaUnidade: 0 }),
    ).toEqual({ doCompartilhado: 40, daUnidade: 0 });
  });
});

describe('o escopo com que um lançamento nasce', () => {
  it('sai do cadastro no momento da gravação', () => {
    expect(escopoDoLancamento('unidade', MATRIZ)).toBe('unidade');
    expect(escopoDoLancamento('empresa', MATRIZ)).toBe('empresa');
  });

  it('sem unidade conhecida nasce compartilhado, mesmo com o interruptor em unidade', () => {
    /**
     * A alternativa seria recusar o acúmulo, e aí o cliente perderia os pontos
     * de uma venda por causa de uma coluna que ninguém preencheu. É também o que
     * o `CHECK` do banco impõe: escopo `unidade` sem unidade é linha sem bolso.
     */
    expect(escopoDoLancamento('unidade', null)).toBe('empresa');
  });
});

describe('onde o plano do clube cobre', () => {
  it('plano de empresa cobre em qualquer loja', () => {
    expect(
      planoCobreNaUnidade({
        escopoDoPlano: 'empresa',
        unidadeDaAdesao: MATRIZ,
        unidadeDoAtendimento: FILIAL,
      }),
    ).toBe(true);
  });

  it('plano de unidade cobre só onde a pessoa assinou', () => {
    expect(
      planoCobreNaUnidade({
        escopoDoPlano: 'unidade',
        unidadeDaAdesao: MATRIZ,
        unidadeDoAtendimento: FILIAL,
      }),
    ).toBe(false);
    expect(
      planoCobreNaUnidade({
        escopoDoPlano: 'unidade',
        unidadeDaAdesao: MATRIZ,
        unidadeDoAtendimento: MATRIZ,
      }),
    ).toBe(true);
  });

  it('assinatura sem unidade é coberta em toda parte, mesmo num plano de unidade', () => {
    // Ela foi vendida quando loja não fazia parte da promessa; recortá-la agora
    // seria tirar do assinante algo que ele já pagou.
    expect(
      planoCobreNaUnidade({
        escopoDoPlano: 'unidade',
        unidadeDaAdesao: null,
        unidadeDoAtendimento: FILIAL,
      }),
    ).toBe(true);
  });
});

describe('quanto a pessoa deve nesta loja', () => {
  const linhas = [
    { valorCents: -5000, unidadeId: MATRIZ },
    { valorCents: -3000, unidadeId: FILIAL },
    { valorCents: -2000, unidadeId: null },
  ];

  it('por empresa, a dívida é uma só', () => {
    expect(saldoDoFiadoNaUnidade({ escopo: 'empresa', linhas, unidadeId: MATRIZ })).toBe(-10_000);
  });

  it('por unidade, cada loja vê a sua — mais o que não tem loja', () => {
    /**
     * O lançamento sem unidade é anterior a este bloco, e ele conta em todas as
     * leituras: a dívida é com a barbearia. A escolha é a favor da casa — o
     * limite fica mais apertado, nunca mais frouxo.
     */
    expect(saldoDoFiadoNaUnidade({ escopo: 'unidade', linhas, unidadeId: MATRIZ })).toBe(-7000);
    expect(saldoDoFiadoNaUnidade({ escopo: 'unidade', linhas, unidadeId: FILIAL })).toBe(-5000);
  });

  it('pagamento abate na loja em que foi feito', () => {
    const comPagamento = [...linhas, { valorCents: 5000, unidadeId: MATRIZ }];
    expect(
      saldoDoFiadoNaUnidade({ escopo: 'unidade', linhas: comPagamento, unidadeId: MATRIZ }),
    ).toBe(-2000);
    expect(
      saldoDoFiadoNaUnidade({ escopo: 'unidade', linhas: comPagamento, unidadeId: FILIAL }),
    ).toBe(-5000);
  });
});
