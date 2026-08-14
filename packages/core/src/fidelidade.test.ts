import { describe, expect, it } from 'vitest';
import {
  MODOS_DE_FIDELIDADE,
  PROGRAMA_DESLIGADO,
  ROTULO_DO_MODO,
  acumuloDaVenda,
  podeResgatar,
  quantidadeAExpirar,
  resgateSugerido,
  saldoDisponivel,
  saldoPorExtenso,
  valorDoResgate,
  vencimentoDoAcumulo,
  type LancamentoDeFidelidade,
  type ProgramaDeFidelidade,
  type TipoDeLancamento,
} from './fidelidade.js';

const AGORA = new Date('2026-10-01T12:00:00Z');

const programa = (extra: Partial<ProgramaDeFidelidade> = {}): ProgramaDeFidelidade => ({
  ...PROGRAMA_DESLIGADO,
  ...extra,
});

let contador = 0;
const lancamento = (
  tipo: TipoDeLancamento,
  quantidade: number,
  diasAtras: number,
  venceEmDias: number | null = null,
): LancamentoDeFidelidade => {
  contador += 1;
  const criadoEm = new Date(AGORA.getTime() - diasAtras * 86_400_000);
  return {
    id: `l${contador}`,
    tipo,
    quantidade,
    criadoEm,
    venceEm: venceEmDias === null ? null : new Date(criadoEm.getTime() + venceEmDias * 86_400_000),
  };
};

describe('o acúmulo de cada modelo', () => {
  it('sem programa, nenhuma venda gera nada', () => {
    expect(acumuloDaVenda({ programa: programa(), totalCents: 5000, resgatadoCents: 0 })).toBeNull();
  });

  it('pontos: um real, um ponto', () => {
    // A regra literal da SPEC §4.8.
    expect(
      acumuloDaVenda({
        programa: programa({ modo: 'pontos', pontosPorReal: 1 }),
        totalCents: 4900,
        resgatadoCents: 0,
      }),
    ).toEqual({ quantidade: 49, baseCents: 4900 });
  });

  it('cashback: cinco por cento voltam em centavos inteiros', () => {
    expect(
      acumuloDaVenda({
        programa: programa({ modo: 'cashback', cashbackBps: 500 }),
        totalCents: 4900,
        resgatadoCents: 0,
      }),
    ).toEqual({ quantidade: 245, baseCents: 4900 });
  });

  it('cashback arredonda para baixo, e nunca inventa centavo', () => {
    // 5% de R$ 1,90 é 9,5 centavos. Nove, não dez: o cliente nunca vê crédito
    // que não existe.
    expect(
      acumuloDaVenda({
        programa: programa({ modo: 'cashback', cashbackBps: 500 }),
        totalCents: 190,
        resgatadoCents: 0,
      }),
    ).toMatchObject({ quantidade: 9 });
  });

  it('visitas: cada venda é uma visita, independente do valor', () => {
    expect(
      acumuloDaVenda({
        programa: programa({ modo: 'visitas' }),
        totalCents: 4900,
        resgatadoCents: 0,
      }),
    ).toMatchObject({ quantidade: 1 });
  });
});

describe('o bloqueio anti-laço', () => {
  it('pontos acumulam só sobre o que a pessoa pagou de verdade', () => {
    /**
     * Sem isto o crédito gera crédito, e o programa vira uma máquina de
     * fabricar dinheiro a partir de nada. Resgatar R$ 20 numa conta de R$ 50
     * deixa R$ 30 de compra — e são eles que contam.
     */
    expect(
      acumuloDaVenda({
        programa: programa({ modo: 'pontos', pontosPorReal: 1 }),
        totalCents: 5000,
        resgatadoCents: 2000,
      }),
    ).toEqual({ quantidade: 30, baseCents: 3000 });
  });

  it('cashback não devolve percentual sobre o próprio cashback', () => {
    expect(
      acumuloDaVenda({
        programa: programa({ modo: 'cashback', cashbackBps: 500 }),
        totalCents: 5000,
        resgatadoCents: 5000,
      }),
    ).toBeNull();
  });

  it('o corte grátis não empurra o contador para o próximo corte grátis', () => {
    // É o laço que a SPEC nomeia. A conta inteira paga com crédito **não** é
    // uma visita.
    expect(
      acumuloDaVenda({
        programa: programa({ modo: 'visitas' }),
        totalCents: 4900,
        resgatadoCents: 4900,
      }),
    ).toBeNull();
  });

  it('mas o corte com desconto parcial continua sendo uma visita', () => {
    // A pessoa veio, sentou e pagou. Tirar a visita dela seria punir quem usou
    // o programa — que é o contrário do que ele existe para fazer.
    expect(
      acumuloDaVenda({
        programa: programa({ modo: 'visitas' }),
        totalCents: 4900,
        resgatadoCents: 200,
      }),
    ).toMatchObject({ quantidade: 1 });
  });
});

describe('o saldo sai do extrato, e sai por FIFO', () => {
  it('soma entradas e subtrai saídas', () => {
    const extrato = [
      lancamento('acumulo', 100, 30),
      lancamento('resgate', -40, 10),
    ];
    expect(saldoDisponivel(extrato, AGORA)).toBe(60);
  });

  it('o que venceu some do saldo antes de a varredura rodar', () => {
    /**
     * Mesma decisão do convite de vaga do bloco 39: mostrar o valor gravado
     * faria a tela oferecer um resgate que a gravação vai recusar.
     */
    const extrato = [lancamento('acumulo', 100, 400, 365)];
    expect(saldoDisponivel(extrato, AGORA)).toBe(0);
  });

  it('o resgate consome primeiro o que vence antes', () => {
    /**
     * FIFO e não LIFO. Consumir o lote novo primeiro deixaria vencer um saldo
     * que a pessoa acabou de usar — e ela veria o número cair duas vezes pelo
     * mesmo gasto.
     */
    const antigo = lancamento('acumulo', 100, 300, 365);
    const novo = lancamento('acumulo', 100, 10, 365);
    const gasto = lancamento('resgate', -100, 5);

    // O antigo foi inteiramente consumido, então nada vence: sobram os 100 do
    // lote novo.
    expect(saldoDisponivel([antigo, novo, gasto], AGORA)).toBe(100);
  });

  it('sem FIFO o saldo ficaria errado, e é isso que este número prova', () => {
    // Se o resgate saísse do lote **novo**, o antigo venceria e o saldo cairia
    // para zero em vez de cem.
    const antigo = lancamento('acumulo', 100, 300, 365);
    const novo = lancamento('acumulo', 100, 10, 365);
    const gasto = lancamento('resgate', -100, 5);
    expect(saldoDisponivel([antigo, novo, gasto], AGORA)).not.toBe(0);
  });

  it('a ordem em que os lançamentos chegam não muda o saldo', () => {
    const extrato = [
      lancamento('resgate', -30, 5),
      lancamento('acumulo', 100, 30),
      lancamento('ajuste', 10, 1),
    ];
    const invertido = [...extrato].reverse();
    expect(saldoDisponivel(extrato, AGORA)).toBe(saldoDisponivel(invertido, AGORA));
  });

  it('saldo nunca fica negativo por um resgate maior que o disponível', () => {
    const extrato = [lancamento('acumulo', 10, 30), lancamento('resgate', -50, 1)];
    expect(saldoDisponivel(extrato, AGORA)).toBe(0);
  });
});

describe('a expiração que a varredura grava', () => {
  it('devolve o que venceu e ainda não foi registrado', () => {
    const extrato = [lancamento('acumulo', 100, 400, 365)];
    expect(quantidadeAExpirar(extrato, AGORA)).toBe(100);
  });

  it('não expira duas vezes o mesmo saldo', () => {
    // A varredura roda todo dia. Sem descontar o que já foi gravado, ela
    // enterraria o extrato em linhas de expiração e o saldo iria a menos-mil.
    const acumulo = lancamento('acumulo', 100, 400, 365);
    const expirado = lancamento('expiracao', -100, 1);
    expect(quantidadeAExpirar([acumulo, expirado], AGORA)).toBe(0);
  });

  it('o que foi gasto antes de vencer não expira', () => {
    const extrato = [
      lancamento('acumulo', 100, 400, 365),
      lancamento('resgate', -100, 200),
    ];
    expect(quantidadeAExpirar(extrato, AGORA)).toBe(0);
  });

  it('saldo sem validade nunca aparece para expirar', () => {
    const extrato = [lancamento('acumulo', 100, 4000, null)];
    expect(quantidadeAExpirar(extrato, AGORA)).toBe(0);
  });

  it('o vencimento é contado a partir de quando o saldo entrou', () => {
    const venceEm = vencimentoDoAcumulo(programa({ modo: 'pontos', validadeDias: 180 }), AGORA);
    expect(venceEm?.toISOString()).toBe('2027-03-30T12:00:00.000Z');
    expect(vencimentoDoAcumulo(programa({ modo: 'pontos' }), AGORA)).toBeNull();
  });
});

describe('o resgate', () => {
  it('cashback vale centavo por centavo, limitado ao que falta pagar', () => {
    const p = programa({ modo: 'cashback' });
    expect(valorDoResgate({ programa: p, quantidade: 1200, tetoCents: 5000 })).toBe(1200);
    expect(valorDoResgate({ programa: p, quantidade: 9000, tetoCents: 5000 })).toBe(5000);
  });

  it('um ponto vale o que a barbearia disse que vale', () => {
    // Sem esta conversão, "R$ 1 = 1 ponto" na entrada devolveria cem por cento
    // do que a pessoa gastou.
    const p = programa({ modo: 'pontos', valorDoPontoCents: 1 });
    expect(valorDoResgate({ programa: p, quantidade: 300, tetoCents: 5000 })).toBe(300);
  });

  it('visitas: o prêmio é a conta, e só com o cartão cheio', () => {
    const p = programa({ modo: 'visitas', visitasParaPremio: 10 });
    expect(valorDoResgate({ programa: p, quantidade: 10, tetoCents: 4900 })).toBe(4900);
    expect(valorDoResgate({ programa: p, quantidade: 9, tetoCents: 4900 })).toBe(0);
  });

  it('resgate parcial é permitido em pontos e em cashback', () => {
    // Requisito escrito da SPEC §4.8. Quem tem 40 pontos usa os 40.
    const p = programa({ modo: 'pontos', valorDoPontoCents: 1 });
    expect(podeResgatar({ programa: p, saldo: 40, quantidade: 40, tetoCents: 5000 })).toEqual({
      aceito: true,
    });
  });

  it('meio corte grátis não existe', () => {
    const p = programa({ modo: 'visitas', visitasParaPremio: 10 });
    expect(podeResgatar({ programa: p, saldo: 12, quantidade: 5, tetoCents: 4900 })).toMatchObject({
      recusa: 'premio_incompleto',
    });
  });

  it('não dá para resgatar mais do que se tem', () => {
    const p = programa({ modo: 'cashback' });
    expect(podeResgatar({ programa: p, saldo: 100, quantidade: 500, tetoCents: 5000 })).toMatchObject(
      { recusa: 'saldo_insuficiente' },
    );
  });

  it('sem programa não há resgate, mesmo com saldo antigo na conta', () => {
    // A barbearia desligou o programa. O saldo continua no extrato — apagá-lo
    // seria reescrever o passado —, mas ninguém resgata o que não existe mais.
    expect(
      podeResgatar({ programa: programa(), saldo: 900, quantidade: 100, tetoCents: 5000 }),
    ).toMatchObject({ recusa: 'sem_programa' });
  });

  it('comanda já paga não aceita resgate', () => {
    const p = programa({ modo: 'cashback' });
    expect(podeResgatar({ programa: p, saldo: 900, quantidade: 100, tetoCents: 0 })).toMatchObject({
      recusa: 'nada_a_pagar',
    });
  });

  it('quantidade fracionada é recusada', () => {
    const p = programa({ modo: 'pontos' });
    expect(podeResgatar({ programa: p, saldo: 900, quantidade: 1.5, tetoCents: 5000 })).toMatchObject(
      { recusa: 'quantidade_invalida' },
    );
  });
});

describe('o que a tela sugere', () => {
  it('pontos: o máximo que cabe no que falta pagar', () => {
    // Fazer a recepção calcular de cabeça quantos pontos cabem em R$ 37 é como
    // o programa deixa de ser usado.
    const p = programa({ modo: 'pontos', valorDoPontoCents: 1 });
    expect(resgateSugerido({ programa: p, saldo: 9000, tetoCents: 3700 })).toBe(3700);
    expect(resgateSugerido({ programa: p, saldo: 500, tetoCents: 3700 })).toBe(500);
  });

  it('visitas: sugere o prêmio só quando o cartão está cheio', () => {
    const p = programa({ modo: 'visitas', visitasParaPremio: 10 });
    expect(resgateSugerido({ programa: p, saldo: 9, tetoCents: 4900 })).toBe(0);
    expect(resgateSugerido({ programa: p, saldo: 10, tetoCents: 4900 })).toBe(10);
  });

  it('o que a tela sugere é sempre aceito pela regra', () => {
    // Sugerir o que a gravação recusa é o defeito clássico de tela: o botão
    // aparece e só produz erro.
    for (const modo of ['pontos', 'cashback', 'visitas'] as const) {
      const p = programa({ modo, valorDoPontoCents: 1, visitasParaPremio: 10 });
      const sugerido = resgateSugerido({ programa: p, saldo: 500, tetoCents: 4900 });
      if (sugerido === 0) continue;
      expect(
        podeResgatar({ programa: p, saldo: 500, quantidade: sugerido, tetoCents: 4900 }),
        modo,
      ).toEqual({ aceito: true });
    }
  });
});

describe('o vocabulário do saldo', () => {
  it('todo modo tem rótulo', () => {
    for (const modo of MODOS_DE_FIDELIDADE) expect(ROTULO_DO_MODO[modo]).toBeTruthy();
  });

  it('cashback é dito em reais, e o resto na própria unidade', () => {
    expect(saldoPorExtenso('cashback', 1250)).toBe('R$ 12,50');
    expect(saldoPorExtenso('visitas', 1)).toBe('1 visita');
    expect(saldoPorExtenso('visitas', 3)).toBe('3 visitas');
    expect(saldoPorExtenso('pontos', 1)).toBe('1 ponto');
    expect(saldoPorExtenso('pontos', 340)).toBe('340 pontos');
  });

  it('não se queima mais saldo do que a conta consome', () => {
    /**
     * O defeito: `valorDoResgate` apara no teto e quem grava debitava a
     * quantidade **pedida**. Cinco mil pontos numa comanda de R$ 10 pagavam os
     * R$ 10 e apagavam R$ 50 de crédito — os R$ 40 sumiam para sempre, porque a
     * única volta é um ajuste manual com outra permissão.
     *
     * O que segurava era `resgateSugerido`, e ele mora na tela: qualquer cliente
     * HTTP que não a use passava direto.
     */
    const emPontos: ProgramaDeFidelidade = {
      modo: 'pontos',
      pontosPorReal: 1,
      valorDoPontoCents: 1,
      visitasParaPremio: 0,
      cashbackBps: 0,
      validadeDias: null,
      escopo: 'empresa',
    };

    expect(
      podeResgatar({ programa: emPontos, saldo: 5000, quantidade: 5000, tetoCents: 1000 }),
    ).toEqual({ aceito: false, recusa: 'resgate_acima_do_teto' });

    // O que cabe, cabe: mil pontos numa conta de R$ 10 é resgate cheio.
    expect(
      podeResgatar({ programa: emPontos, saldo: 5000, quantidade: 1000, tetoCents: 1000 }),
    ).toEqual({ aceito: true });

    // E o parcial continua valendo, que é requisito da SPEC.
    expect(
      podeResgatar({ programa: emPontos, saldo: 5000, quantidade: 400, tetoCents: 1000 }),
    ).toEqual({ aceito: true });
  });
});
