import { describe, expect, it } from 'vitest';
import {
  crescimentoDaJanela,
  diasEntre,
  razaoBps,
  ROTULO_DO_CRESCIMENTO,
  serieParaTela,
  SUBIR_E_BOM,
  type EntradaDeCrescimento,
} from './crescimento.js';

const base: EntradaDeCrescimento = {
  voltaramNaJanela: 62,
  jaVinhamAntes: 100,
  perdidos: 8,
  comRitmo: 80,
  receitaCents: 1_200_000,
  clientesQuePagaram: 150,
  cadeiras: 4,
  horasAbertas: 300,
  dias: 30,
};

describe('as métricas de série longa', () => {
  it('retenção e abandono saem em pontos-base inteiros', () => {
    const c = crescimentoDaJanela(base);
    expect(c.retencaoBps).toBe(6200);
    expect(c.churnBps).toBe(1000);
  });

  it('nenhuma divisão devolve infinito', () => {
    /**
     * A regra do bloco 55: `null`, nunca `Infinity`. Uma barbearia no primeiro
     * mês não tem quem "já vinha antes", não tem cadeira com histórico e não tem
     * hora aberta apurada — e é justamente aí que o dono abre o relatório pela
     * primeira vez.
     */
    const vazio = crescimentoDaJanela({
      ...base,
      jaVinhamAntes: 0,
      comRitmo: 0,
      clientesQuePagaram: 0,
      cadeiras: 0,
      horasAbertas: 0,
    });
    expect(vazio.retencaoBps).toBeNull();
    expect(vazio.churnBps).toBeNull();
    expect(vazio.valorPorClienteCents).toBeNull();
    expect(vazio.receitaPorCadeiraCents).toBeNull();
    expect(vazio.receitaPorHoraCents).toBeNull();
    expect(razaoBps(5, 0)).toBeNull();
  });

  it('subir é bom em tudo, menos no abandono', () => {
    /**
     * O bloco 55 já aprendeu isto no comparativo do DRE: uma seta verde para
     * cima em "Comissões" é a tela dizendo o contrário do número. Churn é o caso
     * aqui — e é o único.
     */
    expect(SUBIR_E_BOM.churnBps).toBe(false);
    const outros = Object.entries(SUBIR_E_BOM).filter(([k]) => k !== 'churnBps');
    expect(outros.every(([, bom]) => bom)).toBe(true);
  });

  it('todo indicador tem nome, e nenhum promete o que não entrega', () => {
    /**
     * "Valor por cliente" e não "LTV": o número é o gasto de uma janela, e o LTV
     * clássico projeta a vida inteira a partir de uma taxa de churn estimada.
     * Nome de indicador é o que o número **é**, não o que soa melhor — é a regra
     * que o bloco 55 escreveu depois de "margem de caixa" virar "margem líquida".
     */
    for (const rotulo of Object.values(ROTULO_DO_CRESCIMENTO)) {
      expect(rotulo).toBeTruthy();
      expect(rotulo).not.toContain('LTV');
    }
  });
});

describe('a série diária', () => {
  it('o dia sem venda entra com zero, e não some', () => {
    /**
     * Uma linha que pula o domingo desenha a semana com seis pontos igualmente
     * espaçados, e o gráfico passa a mentir sobre o ritmo do movimento: o vale
     * de segunda aparece como continuação natural do sábado.
     */
    const serie = serieParaTela(
      [
        { dia: '2026-03-02', valorCents: 50000 },
        { dia: '2026-03-05', valorCents: 30000 },
      ],
      '2026-03-01',
      '2026-03-05',
    );
    expect(serie.pontos).toHaveLength(5);
    expect(serie.pontos.map((p) => p.valorCents)).toEqual([0, 50000, 0, 0, 30000]);
    expect(serie.totalCents).toBe(80000);
    expect(serie.maximoCents).toBe(50000);
    expect(serie.mediaCents).toBe(16000);
  });

  it('a janela vazia não vira laço infinito nem NaN', () => {
    expect(diasEntre('2026-03-05', '2026-03-01')).toEqual([]);
    expect(diasEntre('bagunça', '2026-03-01')).toEqual([]);
    const vazia = serieParaTela([], '2026-03-05', '2026-03-01');
    expect(vazia.pontos).toEqual([]);
    expect(vazia.mediaCents).toBeNull();
  });

  it('a virada do mês e a do ano são contadas certo', () => {
    // Somar vinte e quatro horas em fuso local pularia ou repetiria um dia no
    // horário de verão. A aritmética é em UTC porque a data já é o dia da unidade.
    expect(diasEntre('2026-02-27', '2026-03-02')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    expect(diasEntre('2026-12-31', '2027-01-01')).toEqual(['2026-12-31', '2027-01-01']);
  });
});
