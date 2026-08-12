import { describe, expect, it } from 'vitest';
import {
  acertoDoProfissional,
  disponivelParaAdiantar,
  podeAdiantar,
  podeEstornar,
  validarMotivoDoVale,
} from './vale.js';

/**
 * Vale e estorno de venda (bloco 52, SPEC §3.10 e §3.4).
 */

describe('o vale não passa do que o profissional já fez', () => {
  const base = { comissaoAcumuladaCents: 120_000, jaAdiantadoCents: 0 };

  it('adiantar dentro do que ele acumulou é permitido', () => {
    expect(podeAdiantar({ ...base, valorCents: 100_000 })).toBeNull();
    expect(podeAdiantar({ ...base, valorCents: 120_000 })).toBeNull();
  });

  it('adiantar mais do que ele fez é recusado', () => {
    /**
     * O vale ou é descontado inteiro no fechamento ou não é — não existe consumo
     * parcial. Adiantar acima da comissão acumulada produziria um fechamento que
     * paga zero e deixa a diferença sem mecanismo nenhum de cobrança.
     */
    expect(podeAdiantar({ ...base, valorCents: 120_001 })).toBe('vale_maior_que_a_comissao');
  });

  it('o que ele já pegou entra na conta do teto', () => {
    // Senão dois vales de R$ 800 num mês de R$ 1.000 de comissão passariam os
    // dois, cada um olhando o teto sozinho.
    const comAdiantado = { comissaoAcumuladaCents: 120_000, jaAdiantadoCents: 90_000 };
    expect(disponivelParaAdiantar(comAdiantado)).toBe(30_000);
    expect(podeAdiantar({ ...comAdiantado, valorCents: 30_001 }))
      .toBe('vale_maior_que_a_comissao');
    expect(podeAdiantar({ ...comAdiantado, valorCents: 30_000 })).toBeNull();
  });

  it('quem ainda não fez nada não leva vale', () => {
    expect(disponivelParaAdiantar({ comissaoAcumuladaCents: 0, jaAdiantadoCents: 0 })).toBe(0);
    expect(podeAdiantar({ comissaoAcumuladaCents: 0, jaAdiantadoCents: 0, valorCents: 1 }))
      .toBe('vale_maior_que_a_comissao');
  });

  it('estorno que derruba a comissão abaixo do adiantado não vira teto negativo', () => {
    // O disponível é zero, nunca −R$ 200: um número negativo aqui viraria
    // "pode adiantar menos que nada" na tela.
    expect(disponivelParaAdiantar({ comissaoAcumuladaCents: 50_000, jaAdiantadoCents: 70_000 }))
      .toBe(0);
  });

  it('valor zero, negativo e quebrado são recusados', () => {
    for (const valor of [0, -100, 10.5]) {
      expect(podeAdiantar({ ...base, valorCents: valor })).toBe('valor_invalido');
    }
  });
});

describe('o acerto do profissional', () => {
  it('a comissão menos o vale é o que ele recebe', () => {
    expect(acertoDoProfissional({ comissaoCents: 120_000, valeCents: 40_000 }))
      .toEqual({ liquidoCents: 80_000, aindaDeveCents: 0 });
  });

  it('vale maior que a comissão paga zero e registra a diferença', () => {
    /**
     * Acontece quando um estorno é lançado **depois** do vale: o teto valia na
     * hora de conceder e a comissão caiu no dia 28. O acerto é zero e a
     * diferença fica visível — é ela que o dono vai conversar.
     */
    expect(acertoDoProfissional({ comissaoCents: 30_000, valeCents: 50_000 }))
      .toEqual({ liquidoCents: 0, aindaDeveCents: 20_000 });
  });

  it('sem vale, o líquido é a comissão inteira', () => {
    expect(acertoDoProfissional({ comissaoCents: 120_000, valeCents: 0 }).liquidoCents)
      .toBe(120_000);
  });
});

describe('o motivo do vale', () => {
  it('vazio e ausente são aceitos: "vale" já diz o que é', () => {
    expect(validarMotivoDoVale(null)).toBeNull();
    expect(validarMotivoDoVale('')).toBeNull();
  });

  it('escrito pela metade não é motivo', () => {
    expect(validarMotivoDoVale('x')).toBe('motivo_obrigatorio');
  });
});

describe('o estorno de uma venda', () => {
  it('só a venda paga se estorna', () => {
    /**
     * A aberta se cancela; a cancelada nunca cobrou ninguém. Estornar a segunda
     * seria devolver dinheiro que não entrou.
     */
    expect(podeEstornar({ estado: 'paid', motivo: 'Cliente devolveu o produto' })).toBeNull();
    expect(podeEstornar({ estado: 'open', motivo: 'qualquer' })).toBe('venda_nao_paga');
    expect(podeEstornar({ estado: 'cancelled', motivo: 'qualquer' })).toBe('venda_nao_paga');
  });

  it('estornar duas vezes não acontece', () => {
    expect(podeEstornar({ estado: 'refunded', motivo: 'de novo' })).toBe('ja_estornada');
  });

  it('sem motivo escrito, o estorno é recusado', () => {
    // "Por que devolveram os R$ 90 do sábado?" é a pergunta da segunda-feira, e
    // a venda estornada é imutável depois — o campo vazio fica vazio para sempre.
    expect(podeEstornar({ estado: 'paid', motivo: '  ' })).toBe('motivo_obrigatorio');
    expect(podeEstornar({ estado: 'paid', motivo: 'x' })).toBe('motivo_obrigatorio');
  });
});
