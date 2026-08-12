import { describe, expect, it } from 'vitest';
import {
  ALERTAS_DE_ESTOQUE,
  DIAS_QUE_AVISAM_VENCIMENTO,
  ROTULO_DO_ALERTA,
  ROTULO_DO_MOVIMENTO_DE_ESTOQUE,
  ROTULO_DO_TIPO_DE_PRODUTO,
  TIPOS_DE_MOVIMENTO_DE_ESTOQUE,
  TIPOS_DE_PRODUTO,
  alertasDoProduto,
  custoDaFicha,
  efeitoNoSaldo,
  frasePorcentagem,
  margemDeContribuicao,
  ordenarPorMargem,
  saldoDoProduto,
  sugestaoDeCompra,
  validarMovimento,
  type ProdutoEmEstoque,
} from './estoque.js';

const AGORA = new Date('2026-11-01T12:00:00Z');

const produto = (extra: Partial<ProdutoEmEstoque> = {}): ProdutoEmEstoque => ({
  id: 'p1',
  nome: 'Pomada modeladora',
  tipo: 'resale',
  saldo: 10,
  minimo: 3,
  venceEm: null,
  custoCents: 1200,
  precoCents: 3500,
  ...extra,
});

const dias = (n: number) => new Date(AGORA.getTime() + n * 86_400_000);

describe('o saldo é derivado do movimento, nunca guardado', () => {
  it('entrada soma, venda e consumo subtraem', () => {
    expect(
      saldoDoProduto([
        { tipo: 'entrada', quantidade: 20 },
        { tipo: 'venda', quantidade: 3 },
        { tipo: 'consumo', quantidade: 2 },
      ]),
    ).toBe(15);
  });

  it('perda subtrai, e uma perda negativa não existe', () => {
    // Uma "perda de −3" seria uma perda que aumenta o estoque, e a única
    // leitura possível disso é erro de digitação.
    expect(efeitoNoSaldo({ tipo: 'perda', quantidade: 3 })).toBe(-3);
    expect(efeitoNoSaldo({ tipo: 'perda', quantidade: -3 })).toBe(-3);
  });

  it('ajuste anda nos dois sentidos', () => {
    // É a operação escrita para "achei três a mais na gaveta" — e para o
    // contrário.
    expect(efeitoNoSaldo({ tipo: 'ajuste', quantidade: 3 })).toBe(3);
    expect(efeitoNoSaldo({ tipo: 'ajuste', quantidade: -3 })).toBe(-3);
  });

  it('sem movimento nenhum o saldo é zero', () => {
    expect(saldoDoProduto([])).toBe(0);
  });

  it('todo tipo e todo movimento têm rótulo', () => {
    for (const t of TIPOS_DE_PRODUTO) expect(ROTULO_DO_TIPO_DE_PRODUTO[t]).toBeTruthy();
    for (const m of TIPOS_DE_MOVIMENTO_DE_ESTOQUE) expect(ROTULO_DO_MOVIMENTO_DE_ESTOQUE[m]).toBeTruthy();
    for (const a of ALERTAS_DE_ESTOQUE) expect(ROTULO_DO_ALERTA[a]).toBeTruthy();
  });
});

describe('o que o movimento recusa', () => {
  it('saldo negativo não acontece', () => {
    /**
     * Um estoque em −3 significa que alguém vendeu o que não existe, e o número
     * que sai dali contamina o CMV do mês inteiro.
     */
    expect(validarMovimento({ tipo: 'venda', quantidade: 5, saldoAtual: 3 })).toBe(
      'saldo_insuficiente',
    );
    expect(validarMovimento({ tipo: 'venda', quantidade: 3, saldoAtual: 3 })).toBeNull();
  });

  it('quantidade zero não é movimento', () => {
    expect(validarMovimento({ tipo: 'entrada', quantidade: 0, saldoAtual: 0 })).toBe(
      'quantidade_invalida',
    );
  });

  it('quantidade fracionada é recusada', () => {
    // Meia lâmina não existe. A ficha técnica usa mililitro como unidade
    // inteira quando precisa de fração.
    expect(validarMovimento({ tipo: 'entrada', quantidade: 1.5, saldoAtual: 0 })).toBe(
      'quantidade_invalida',
    );
  });

  it('só ajuste e transferência aceitam sinal negativo', () => {
    expect(validarMovimento({ tipo: 'entrada', quantidade: -5, saldoAtual: 10 })).toBe(
      'sinal_invalido',
    );
    expect(
      validarMovimento({ tipo: 'ajuste', quantidade: -5, saldoAtual: 10, motivo: 'contagem' }),
    ).toBeNull();
  });

  it('perda e ajuste exigem motivo escrito', () => {
    /**
     * São as duas em que o número muda sem nota fiscal nem venda, e "sumiu" não
     * é registro de nada. Mesmo raciocínio do override de confiabilidade.
     */
    expect(validarMovimento({ tipo: 'perda', quantidade: 2, saldoAtual: 10 })).toBe(
      'motivo_obrigatorio',
    );
    expect(validarMovimento({ tipo: 'ajuste', quantidade: 2, saldoAtual: 10, motivo: '  ' })).toBe(
      'motivo_obrigatorio',
    );
    expect(
      validarMovimento({ tipo: 'perda', quantidade: 2, saldoAtual: 10, motivo: 'vidro quebrou' }),
    ).toBeNull();
  });

  it('venda e entrada não exigem motivo — a nota e a comanda são o registro', () => {
    expect(validarMovimento({ tipo: 'entrada', quantidade: 20, saldoAtual: 0 })).toBeNull();
    expect(validarMovimento({ tipo: 'venda', quantidade: 1, saldoAtual: 5 })).toBeNull();
  });
});

describe('os alertas', () => {
  it('abaixo do mínimo avisa', () => {
    expect(alertasDoProduto(produto({ saldo: 3, minimo: 3 }), AGORA)).toContain('abaixo_do_minimo');
    expect(alertasDoProduto(produto({ saldo: 4, minimo: 3 }), AGORA)).toEqual([]);
  });

  it('sem estoque e abaixo do mínimo não aparecem juntos', () => {
    // São a mesma notícia, e mostrar as duas dobra a lista sem dizer nada a mais.
    expect(alertasDoProduto(produto({ saldo: 0, minimo: 3 }), AGORA)).toEqual(['sem_estoque']);
  });

  it('o que vence em menos de trinta dias avisa', () => {
    expect(alertasDoProduto(produto({ venceEm: dias(DIAS_QUE_AVISAM_VENCIMENTO - 1) }), AGORA))
      .toContain('vencendo');
    expect(alertasDoProduto(produto({ venceEm: dias(DIAS_QUE_AVISAM_VENCIMENTO + 1) }), AGORA))
      .toEqual([]);
  });

  it('vencido vem antes de acabou', () => {
    /**
     * Um vidro vencido na prateleira é problema **agora** e vai para o lixo;
     * "acabou" só atrapalha na próxima venda.
     */
    expect(alertasDoProduto(produto({ saldo: 1, venceEm: dias(-1) }), AGORA)[0]).toBe('vencido');
  });

  it('produto sem estoque não avisa vencimento', () => {
    // Não há vidro na prateleira para vencer, e o alerta mandaria a recepção
    // procurar o que não existe.
    expect(alertasDoProduto(produto({ saldo: 0, venceEm: dias(-1) }), AGORA)).toEqual([
      'sem_estoque',
    ]);
  });

  it('sem mínimo cadastrado, não há o que avisar', () => {
    expect(alertasDoProduto(produto({ saldo: 1, minimo: 0 }), AGORA)).toEqual([]);
  });

  it('a sugestão de compra recompõe o dobro do mínimo', () => {
    expect(sugestaoDeCompra(produto({ saldo: 1, minimo: 5 }))).toBe(9);
    expect(sugestaoDeCompra(produto({ saldo: 20, minimo: 5 }))).toBe(0);
    expect(sugestaoDeCompra(produto({ minimo: 0 }))).toBe(0);
  });
});

describe('a ficha técnica', () => {
  it('soma o custo dos insumos do serviço', () => {
    expect(
      custoDaFicha([
        { produtoId: 'a', nome: 'Óleo pré-barba', quantidade: 5, custoUnitarioCents: 20 },
        { produtoId: 'b', nome: 'Pós-barba', quantidade: 2, custoUnitarioCents: 30 },
        { produtoId: 'c', nome: 'Lâmina', quantidade: 1, custoUnitarioCents: 140 },
      ]),
    ).toBe(300);
  });

  it('arredonda para cima, item a item', () => {
    /**
     * Meio centavo por atendimento some no relatório do dia e reaparece como
     * diferença na conciliação do ano. Errar para mais no custo é errar para
     * menos na margem — o lado seguro de errar quando o número decide preço.
     */
    expect(custoDaFicha([{ produtoId: 'a', nome: 'x', quantidade: 1, custoUnitarioCents: 0.5 }]))
      .toBe(1);
  });

  it('serviço sem ficha custa zero em insumo', () => {
    expect(custoDaFicha([])).toBe(0);
  });
});

describe('a margem de contribuição', () => {
  it('é o exemplo da SPEC §3.8', () => {
    const m = margemDeContribuicao({
      precoCents: 6000,
      comissaoCents: 2400,
      insumosCents: 300,
      taxaCents: 200,
    });
    expect(m.custoVariavelCents).toBe(2900);
    expect(m.margemCents).toBe(3100);
    expect(m.margemBps).toBe(5167);
    expect(frasePorcentagem(m.margemBps)).toBe('51,7%');
  });

  it('serviço de cortesia não devolve margem infinita', () => {
    // Dividir por zero mostraria "∞%" no serviço que a casa deu de graça.
    const m = margemDeContribuicao({
      precoCents: 0,
      comissaoCents: 0,
      insumosCents: 300,
      taxaCents: 0,
    });
    expect(m.margemCents).toBe(-300);
    expect(m.margemBps).toBe(0);
  });

  it('margem negativa é possível, e é a informação', () => {
    const m = margemDeContribuicao({
      precoCents: 2000,
      comissaoCents: 1600,
      insumosCents: 600,
      taxaCents: 100,
    });
    expect(m.margemCents).toBe(-300);
    expect(m.margemBps).toBe(-1500);
  });

  it('o serviço caro pode render menos que o barato', () => {
    /**
     * É o insight que a SPEC §3.8 nomeia: *"Barboterapia parece o serviço mais
     * caro, mas depois de comissão e insumo rende menos que o Corte simples."*
     * A ordem é por margem **em reais** — é o dinheiro que sobra que paga a
     * conta de luz.
     */
    const barboterapia = margemDeContribuicao({
      precoCents: 5500, comissaoCents: 2200, insumosCents: 1500, taxaCents: 180,
    });
    const corte = margemDeContribuicao({
      precoCents: 6000, comissaoCents: 2400, insumosCents: 300, taxaCents: 200,
    });

    expect(barboterapia.margemCents).toBeLessThan(corte.margemCents);
    expect(ordenarPorMargem([barboterapia, corte])[0]).toBe(corte);
  });
});
