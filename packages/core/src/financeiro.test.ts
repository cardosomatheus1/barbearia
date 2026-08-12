import { describe, expect, it } from 'vitest';
import {
  LIMITE_MAXIMO_DE_FIADO_CENTS,
  contaVencida,
  diasAteVencer,
  fraseDoPrazo,
  podeQuitar,
  resumoDoFinanceiro,
  validarConta,
  validarLimiteDeFiado,
} from './financeiro.js';

/**
 * Financeiro (bloco 51, SPEC §3.10).
 *
 * O dia é sempre o **da unidade** e entra por parâmetro. Nada aqui olha o
 * relógio do processo — é o que faz a suíte dar o mesmo resultado em `TZ=UTC` e
 * em `TZ=Asia/Tokyo`.
 */

const HOJE = '2026-08-12';

const conta = (
  vencimentoEm: string,
  extra: Partial<{
    estado: 'aberta' | 'paga' | 'cancelada';
    direcao: 'pagar' | 'receber';
    valorCents: number;
  }> = {},
) => ({
  estado: 'aberta' as const,
  direcao: 'pagar' as const,
  valorCents: 10_000,
  vencimentoEm,
  ...extra,
});

describe('vencido é derivado do dia da unidade, nunca de uma coluna', () => {
  it('a conta que vence hoje ainda não está vencida', () => {
    /**
     * O fornecedor que vence hoje é pago hoje. Ler `<=` colocaria toda a conta
     * do dia na lista vermelha às 8h da manhã, e quem abre a tela aprenderia
     * que o vermelho não quer dizer nada.
     */
    expect(contaVencida(conta(HOJE), HOJE)).toBe(false);
    expect(contaVencida(conta('2026-08-11'), HOJE)).toBe(true);
  });

  it('conta paga ou cancelada nunca está vencida, por mais antiga que seja', () => {
    expect(contaVencida(conta('2020-01-01', { estado: 'paga' }), HOJE)).toBe(false);
    expect(contaVencida(conta('2020-01-01', { estado: 'cancelada' }), HOJE)).toBe(false);
  });

  it('o dia é o da unidade, e é por isso que ele entra por parâmetro', () => {
    /**
     * Às 22h de Salvador o UTC já virou. Se o "hoje" saísse do processo, a conta
     * que vence amanhã apareceria vencida para quem ainda está trabalhando —
     * e o balcão pagaria de novo o que já pagou.
     */
    const naUnidade = contaVencida(conta('2026-08-12'), '2026-08-12');
    const jaVirouEmUtc = contaVencida(conta('2026-08-12'), '2026-08-13');
    expect(naUnidade).toBe(false);
    expect(jaVirouEmUtc).toBe(true);
  });
});

describe('a frase do prazo é a mesma em toda tela', () => {
  it('cada distância tem uma frase, e ela não muda de lugar para lugar', () => {
    expect(fraseDoPrazo('2026-08-12', HOJE)).toBe('Vence hoje');
    expect(fraseDoPrazo('2026-08-13', HOJE)).toBe('Vence amanhã');
    expect(fraseDoPrazo('2026-08-19', HOJE)).toBe('Vence em 7 dias');
    expect(fraseDoPrazo('2026-08-11', HOJE)).toBe('Venceu ontem');
    expect(fraseDoPrazo('2026-08-02', HOJE)).toBe('Venceu há 10 dias');
  });

  it('a contagem atravessa a virada do mês e a do ano', () => {
    // Uma subtração de dia do mês daria 1 aqui, e a conta atrasada há um mês
    // apareceria como "venceu ontem".
    expect(diasAteVencer('2026-09-01', '2026-08-31')).toBe(1);
    expect(diasAteVencer('2027-01-01', '2026-12-31')).toBe(1);
    expect(diasAteVencer('2026-08-01', '2026-09-01')).toBe(-31);
  });
});

describe('quitar uma conta', () => {
  it('o valor pago pode ser diferente do valor da conta', () => {
    /**
     * É o caso comum, não a exceção: desconto por antecipação e juros por atraso
     * são o que o fornecedor faz. Travar no valor da conta obrigaria o balcão a
     * mentir num dos dois campos.
     */
    expect(podeQuitar({ estado: 'aberta', valorPagoCents: 9500 })).toBeNull();
    expect(podeQuitar({ estado: 'aberta', valorPagoCents: 10_400 })).toBeNull();
  });

  it('quitar duas vezes não acontece', () => {
    expect(podeQuitar({ estado: 'paga', valorPagoCents: 100 })).toBe('conta_nao_aberta');
    expect(podeQuitar({ estado: 'cancelada', valorPagoCents: 100 })).toBe('conta_nao_aberta');
  });

  it('pagamento de zero ou negativo não é pagamento', () => {
    expect(podeQuitar({ estado: 'aberta', valorPagoCents: 0 })).toBe('valor_pago_invalido');
    expect(podeQuitar({ estado: 'aberta', valorPagoCents: -1 })).toBe('valor_pago_invalido');
    expect(podeQuitar({ estado: 'aberta', valorPagoCents: 10.5 })).toBe('valor_pago_invalido');
  });
});

describe('a conta nasce válida', () => {
  it('descrição, valor e vencimento são obrigatórios', () => {
    const boa = { descricao: 'Aluguel', valorCents: 250_000, vencimentoEm: '2026-09-05' };
    expect(validarConta(boa)).toBeNull();
    expect(validarConta({ ...boa, descricao: ' ' })).toBe('descricao_obrigatoria');
    expect(validarConta({ ...boa, valorCents: 0 })).toBe('valor_invalido');
    expect(validarConta({ ...boa, valorCents: 1.5 })).toBe('valor_invalido');
    expect(validarConta({ ...boa, vencimentoEm: '05/09/2026' })).toBe('vencimento_invalido');
  });
});

describe('o resumo que abre a tela', () => {
  const contas = [
    conta('2026-08-05', { direcao: 'pagar', valorCents: 30_000 }),
    conta('2026-08-20', { direcao: 'pagar', valorCents: 20_000 }),
    conta('2026-08-01', { direcao: 'receber', valorCents: 15_000 }),
    conta('2026-08-30', { direcao: 'receber', valorCents: 60_000 }),
    conta('2026-01-01', { direcao: 'pagar', valorCents: 99_999, estado: 'paga' }),
    conta('2026-01-01', { direcao: 'receber', valorCents: 88_888, estado: 'cancelada' }),
  ];

  it('só o que está em aberto entra na conta', () => {
    /**
     * A paga já saiu do bolso e a cancelada nunca vai sair. Somá-las faria o
     * total crescer para sempre — e um número que só sobe é um número que
     * ninguém olha.
     */
    const r = resumoDoFinanceiro(contas, HOJE);
    expect(r.aPagarCents).toBe(50_000);
    expect(r.aReceberCents).toBe(75_000);
  });

  it('o vencido é um recorte do aberto, não outra lista', () => {
    const r = resumoDoFinanceiro(contas, HOJE);
    expect(r.vencidoAPagarCents).toBe(30_000);
    expect(r.vencidoAReceberCents).toBe(15_000);
  });

  it('o saldo projetado responde a pergunta que o dono faz', () => {
    // "Se eu pagar tudo que devo e receber tudo que me devem, sobra quanto?"
    expect(resumoDoFinanceiro(contas, HOJE).saldoProjetadoCents).toBe(25_000);
  });

  it('sem conta nenhuma, tudo é zero e nada é `NaN`', () => {
    const r = resumoDoFinanceiro([], HOJE);
    expect(r.aPagarCents).toBe(0);
    expect(r.aReceberCents).toBe(0);
    expect(r.saldoProjetadoCents).toBe(0);
  });

  it('devendo mais do que tem a receber, o saldo é negativo — e é para ser', () => {
    // Arredondar para zero esconderia justamente o mês em que a tela precisa
    // gritar.
    const r = resumoDoFinanceiro(
      [conta('2026-08-20', { direcao: 'pagar', valorCents: 80_000 })],
      HOJE,
    );
    expect(r.saldoProjetadoCents).toBe(-80_000);
  });
});

describe('o limite de fiado', () => {
  it('zero é limite válido, e significa "não vende fiado para esta pessoa"', () => {
    /**
     * É o padrão da coluna desde o bloco 18, e continua sendo: fiado é decisão
     * caso a caso, não benefício de cadastro.
     */
    expect(validarLimiteDeFiado(0)).toBeNull();
  });

  it('negativo e fracionário são recusados', () => {
    expect(validarLimiteDeFiado(-1)).toBe('valor_invalido');
    expect(validarLimiteDeFiado(150.5)).toBe('valor_invalido');
  });

  it('acima do teto é erro de digitação, não generosidade', () => {
    // R$ 50.000 de fiado numa barbearia é um zero a mais em R$ 5.000.
    expect(validarLimiteDeFiado(LIMITE_MAXIMO_DE_FIADO_CENTS)).toBeNull();
    expect(validarLimiteDeFiado(LIMITE_MAXIMO_DE_FIADO_CENTS + 1)).toBe('valor_invalido');
  });
});
