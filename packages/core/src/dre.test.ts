import { describe, expect, it } from 'vitest';
import {
  compararDre,
  compararLinha,
  montarDre,
  periodoAnterior,
  type FatosDoDre,
} from './dre.js';

/**
 * DRE gerencial (bloco 52, SPEC §3.10).
 *
 * O relatório é aritmética pura sobre fatos que já estão gravados. O que os
 * testes prendem é o **sentido** de cada número — que despesa subindo é ruim,
 * que mês sem receita não tem margem infinita, e que o comparativo é contra uma
 * janela do mesmo tamanho.
 */

const MES: FatosDoDre = {
  receitaServicosCents: 4_200_000,
  receitaProdutosCents: 380_000,
  receitaAssinaturasCents: 149_000,
  comissoesCents: 1_800_000,
  cmvCents: 152_000,
  taxasCents: 138_000,
  fidelidadeCents: 42_000,
  despesasCents: 890_000,
};

describe('o DRE soma o que a SPEC lista, e nada mais', () => {
  it('receita bruta é a soma das três receitas', () => {
    const dre = montarDre(MES);
    expect(dre.receitaBrutaCents).toBe(4_729_000);
  });

  it('o resultado desconta as cinco linhas de custo', () => {
    const dre = montarDre(MES);
    expect(dre.custoTotalCents).toBe(3_022_000);
    expect(dre.resultadoCents).toBe(1_707_000);
  });

  it('a margem sai em pontos-base, como toda alíquota deste produto', () => {
    // 1.707.000 / 4.729.000 = 36,10%
    expect(montarDre(MES).margemBps).toBe(3610);
  });

  it('mês sem receita não tem margem infinita', () => {
    /**
     * A divisão por zero produziria `Infinity`, e "margem de ∞%" é o que
     * apareceria em toda barbearia no primeiro mês — justamente quando o dono
     * abre o relatório pela primeira vez.
     */
    const vazio = montarDre({
      receitaServicosCents: 0,
      receitaProdutosCents: 0,
      receitaAssinaturasCents: 0,
      comissoesCents: 0,
      cmvCents: 0,
      taxasCents: 0,
      fidelidadeCents: 0,
      despesasCents: 120_000,
    });
    expect(vazio.margemBps).toBeNull();
    expect(vazio.resultadoCents).toBe(-120_000);
  });

  it('o custo da fidelidade entra no resultado', () => {
    /**
     * Era a lacuna: quando o cliente paga R$ 5 com crédito, a receita continua
     * sendo o preço do serviço e o dinheiro que entrou é R$ 5 menor. Sem esta
     * linha o resultado do mês superestimava a margem pelo valor resgatado.
     */
    const sem = montarDre({ ...MES, fidelidadeCents: 0 });
    expect(sem.resultadoCents - montarDre(MES).resultadoCents).toBe(42_000);
  });
});

describe('o comparativo diz se melhorou, não só se subiu', () => {
  it('receita que sobe melhorou; custo que sobe piorou', () => {
    /**
     * O sentido não é o sinal do delta. Uma seta verde para cima em "Comissões"
     * seria a tela dizendo o contrário do que o número significa — e é a única
     * coisa que quem abre o relatório olha antes de ler o valor.
     */
    expect(compararLinha(120, 100, 'receita').sentido).toBe('melhorou');
    expect(compararLinha(120, 100, 'custo').sentido).toBe('piorou');
    expect(compararLinha(80, 100, 'receita').sentido).toBe('piorou');
    expect(compararLinha(80, 100, 'custo').sentido).toBe('melhorou');
    expect(compararLinha(100, 100, 'custo').sentido).toBe('igual');
  });

  it('crescer sobre zero não é "subiu infinito"', () => {
    // É o segundo mês de toda barbearia nova, e o primeiro relatório que ela lê.
    expect(compararLinha(5000, 0, 'receita').variacaoBps).toBeNull();
    expect(compararLinha(5000, 0, 'receita').deltaCents).toBe(5000);
  });

  it('a variação sai em pontos-base', () => {
    expect(compararLinha(150, 100, 'receita').variacaoBps).toBe(5000);
    expect(compararLinha(50, 100, 'receita').variacaoBps).toBe(-5000);
  });

  it('resultado negativo que melhora aparece como melhora', () => {
    /**
     * De −R$ 2.000 para −R$ 500 o negócio melhorou, e a divisão pelo módulo é o
     * que faz a porcentagem dizer isso: dividir pelo valor com sinal daria
     * −75%, que a tela leria como piora de 75%.
     */
    const linha = compararLinha(-50_000, -200_000, 'receita');
    expect(linha.sentido).toBe('melhorou');
    expect(linha.variacaoBps).toBe(7500);
  });

  it('o DRE comparado traz as oito linhas da SPEC, em ordem', () => {
    const comparado = compararDre(montarDre(MES), montarDre({ ...MES, despesasCents: 500_000 }));
    expect(comparado.linhas.map((l) => l.campo)).toEqual([
      'receitaServicosCents',
      'receitaProdutosCents',
      'receitaAssinaturasCents',
      'comissoesCents',
      'cmvCents',
      'taxasCents',
      'fidelidadeCents',
      'despesasCents',
    ]);
    // Gastou R$ 3.900 a mais que no período anterior: piorou.
    expect(comparado.linhas.at(-1)?.sentido).toBe('piorou');
    expect(comparado.resultado.sentido).toBe('piorou');
  });
});

describe('o período anterior tem o mesmo tamanho', () => {
  it('um mês compara com o mês anterior', () => {
    expect(periodoAnterior('2026-08-01', '2026-08-31')).toEqual({
      de: '2026-07-01',
      ate: '2026-07-31',
    });
  });

  it('sete dias comparam com os sete anteriores, não com o mês', () => {
    /**
     * "Mês anterior" seria errado para um recorte de sete dias e para um de
     * quarenta: a queda que a tela mostrasse seria só a diferença de duração.
     */
    expect(periodoAnterior('2026-08-10', '2026-08-16')).toEqual({
      de: '2026-08-03',
      ate: '2026-08-09',
    });
  });

  it('um único dia compara com a véspera, e a contagem atravessa o ano', () => {
    expect(periodoAnterior('2026-01-01', '2026-01-01')).toEqual({
      de: '2025-12-31',
      ate: '2025-12-31',
    });
  });

  it('fevereiro curto não vira janela de 31 dias', () => {
    // 28 dias em fevereiro comparam com os 28 dias imediatamente anteriores,
    // que caem no meio de janeiro. É o que "mesmo tamanho" significa.
    expect(periodoAnterior('2026-02-01', '2026-02-28')).toEqual({
      de: '2026-01-04',
      ate: '2026-01-31',
    });
  });
});
