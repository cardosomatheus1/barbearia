import { describe, expect, it } from 'vitest';
import {
  calcularSplit,
  desfechoDoEstornoDeRepasse,
  liquidoDaCasa,
  proximoPassoDaLiquidacao,
  splitFecha,
} from './split.js';

/**
 * Split de pagamento (bloco 49, SPEC §3.5).
 *
 * O exemplo da SPEC é o primeiro teste, literal: R$ 100 viram R$ 55 para a
 * casa, R$ 40 para o profissional e R$ 5 para a plataforma.
 */

const RUAN = 'p-1';
const BRUNO = 'p-2';

const valorDe = (fatias: readonly { parte: string; valorCents: number }[], parte: string) =>
  fatias.filter((f) => f.parte === parte).reduce((s, f) => s + f.valorCents, 0);

describe('o split reparte o pagamento em três', () => {
  it('o exemplo da SPEC, literal', () => {
    const { fatias } = calcularSplit({
      pagamentoCents: 10_000,
      comissoes: [{ professionalId: RUAN, valorCents: 4000 }],
      plataformaBps: 500,
    });

    expect(valorDe(fatias, 'barbearia')).toBe(5500);
    expect(valorDe(fatias, 'profissional')).toBe(4000);
    expect(valorDe(fatias, 'plataforma')).toBe(500);
  });

  it('a soma das partes é o pagamento, ao centavo', () => {
    /**
     * Não é preciosismo: um centavo a mais é dinheiro que o adquirente não tem,
     * e ele recusa a chamada inteira. Um centavo a menos fica preso na conta da
     * plataforma para sempre.
     */
    for (const pagamento of [1, 99, 3333, 10_000, 12_345, 99_999]) {
      const { fatias } = calcularSplit({
        pagamentoCents: pagamento,
        comissoes: [{ professionalId: RUAN, valorCents: Math.floor(pagamento * 0.4) }],
        plataformaBps: 317,
      });
      expect(splitFecha(pagamento, fatias), `pagamento de ${pagamento}`).toBe(true);
    }
  });

  it('dois barbeiros na mesma comanda viram duas fatias, e a plataforma não dobra', () => {
    // A alíquota da plataforma é sobre a transação, não sobre quem atendeu:
    // ela não pode variar com quantos barbeiros entraram na comanda.
    const { fatias } = calcularSplit({
      pagamentoCents: 12_000,
      comissoes: [
        { professionalId: RUAN, valorCents: 2400 },
        { professionalId: BRUNO, valorCents: 2200 },
      ],
      plataformaBps: 500,
    });

    expect(fatias.filter((f) => f.parte === 'profissional')).toHaveLength(2);
    expect(valorDe(fatias, 'plataforma')).toBe(600);
    expect(valorDe(fatias, 'barbearia')).toBe(12_000 - 4600 - 600);
  });

  it('a casa entra na lista mesmo quando fica com zero', () => {
    /**
     * É ela que responde "para onde foi o resto", e uma comanda sem a linha dela
     * parece split incompleto para quem lê o extrato.
     */
    const { fatias } = calcularSplit({
      pagamentoCents: 10_000,
      comissoes: [{ professionalId: RUAN, valorCents: 10_000 }],
      plataformaBps: 0,
    });
    expect(valorDe(fatias, 'barbearia')).toBe(0);
    expect(fatias.some((f) => f.parte === 'barbearia')).toBe(true);
  });

  it('comissão que não cabe no pagamento é recusada, não ajustada', () => {
    /**
     * Acontece de verdade: uma comanda paga metade em dinheiro e metade no Pix
     * — a comissão é da venda inteira e o pagamento é de um pedaço só. Inventar
     * um número que feche seria a casa repassando o que não recebeu.
     */
    const decisao = calcularSplit({
      pagamentoCents: 5000,
      comissoes: [{ professionalId: RUAN, valorCents: 4000 }],
      plataformaBps: 3000,
    });
    expect(decisao.recusa).toBe('comissao_maior_que_o_pagamento');
    expect(decisao.fatias).toHaveLength(0);
  });

  it('comissão zero ou negativa não vira fatia', () => {
    /**
     * Um repasse de zero centavos é uma chamada que o adquirente recusa e uma
     * linha dizendo ao barbeiro que ele recebeu nada. Comissão negativa é
     * estorno, e estorno é acerto no fechamento — o dinheiro desta venda já foi.
     */
    const { fatias } = calcularSplit({
      pagamentoCents: 6000,
      comissoes: [
        { professionalId: RUAN, valorCents: 0 },
        { professionalId: BRUNO, valorCents: -500 },
      ],
      plataformaBps: 0,
    });
    expect(fatias.filter((f) => f.parte === 'profissional')).toHaveLength(0);
    expect(valorDe(fatias, 'barbearia')).toBe(6000);
  });

  it('sem alíquota da plataforma, não existe fatia da plataforma', () => {
    // Zero é o padrão: cobrar sem contrato assinado é o tipo de coisa que se
    // descobre no extrato.
    const { fatias } = calcularSplit({
      pagamentoCents: 6000,
      comissoes: [{ professionalId: RUAN, valorCents: 2400 }],
      plataformaBps: 0,
    });
    expect(fatias.some((f) => f.parte === 'plataforma')).toBe(false);
    expect(splitFecha(6000, fatias)).toBe(true);
  });

  it('pagamento inválido e alíquota fora da faixa são recusados', () => {
    expect(calcularSplit({ pagamentoCents: 0, comissoes: [], plataformaBps: 0 }).recusa)
      .toBe('valor_invalido');
    expect(calcularSplit({ pagamentoCents: 100, comissoes: [], plataformaBps: 5000 }).recusa)
      .toBe('aliquota_invalida');
  });
});

describe('a taxa do adquirente sai do pedaço da casa', () => {
  it('a casa é a residual, e o profissional recebe a comissão cheia', () => {
    /**
     * Se a taxa saísse do bolo antes da repartição, a comissão do barbeiro
     * mudaria conforme o meio de pagamento que o cliente escolheu no balcão — e
     * ele descobriria isso comparando dois cortes iguais.
     *
     * Absorver ou ratear a taxa já é decisão da casa desde o bloco 36, e ela
     * continua sendo tomada onde sempre foi: na base da comissão.
     */
    const { fatias } = calcularSplit({
      pagamentoCents: 10_000,
      comissoes: [{ professionalId: RUAN, valorCents: 4000 }],
      plataformaBps: 500,
    });

    expect(liquidoDaCasa({ fatias, taxaDoAdquirenteCents: 319 })).toBe(5500 - 319);
    expect(valorDe(fatias, 'profissional')).toBe(4000);
  });
});

describe('KYC, liquidação e estorno (bloco 50)', () => {
  const pendente = (extra: Partial<Parameters<typeof proximoPassoDaLiquidacao>[0]> = {}) => ({
    estado: 'pendente' as const,
    valorCents: 4000,
    tentativas: 0,
    kyc: 'aprovado' as const,
    recebedorId: 'rec_1',
    ...extra,
  });

  it('sem cadastro aprovado, a parte é retida — e isso não é falha', () => {
    /**
     * *"Enquanto pendente, o pagamento cai integralmente na barbearia e a
     * comissão é paga fora, **sem bloquear a venda**."* É a frase mais
     * importante da seção, e vai contra o instinto: o caminho óbvio seria
     * recusar a venda até o barbeiro estar aprovado, e o que isso produz é a
     * barbearia descobrindo no balcão que não consegue cobrar.
     */
    for (const kyc of ['ausente', 'pendente', 'recusado'] as const) {
      expect(proximoPassoDaLiquidacao(pendente({ kyc }))).toBe('reter');
    }
  });

  it('aprovado sem id de recebedor também é retido', () => {
    // O `CHECK` do banco impede o par, e esta é a segunda camada: se um dia a
    // linha existir, a falha aparece aqui e não na chamada ao adquirente.
    expect(proximoPassoDaLiquidacao(pendente({ recebedorId: null }))).toBe('reter');
  });

  it('aprovado com recebedor, repassa', () => {
    expect(proximoPassoDaLiquidacao(pendente())).toBe('repassar');
  });

  it('depois de três tentativas, desiste', () => {
    /**
     * Bem menos degraus que a escada de uma cobrança, e a diferença é a direção
     * do dinheiro: repassar de novo é apostar que o adquirente estava fora do
     * ar, e isso ou é verdade na segunda tentativa ou é problema de cadastro que
     * tentar mais vezes não conserta.
     */
    expect(proximoPassoDaLiquidacao(pendente({ estado: 'falhou', tentativas: 2 }))).toBe('repassar');
    expect(proximoPassoDaLiquidacao(pendente({ estado: 'falhou', tentativas: 3 }))).toBe('desistir');
  });

  it('parte em voo não é tentada de novo pela régua', () => {
    /**
     * `liquidando` tem uma chamada no ar. Quem a resgata é a volta seguinte, que
     * a devolve a `falhou` depois de uma hora — e só então a régua a retenta, com
     * a chave estável que faz o adquirente devolver o resultado da primeira.
     * Retentar às cegas é o que paga o barbeiro duas vezes.
     */
    expect(proximoPassoDaLiquidacao(pendente({ estado: 'liquidando' }))).toBe('nada');
  });

  it('estorno de parte em voo cobra, porque o dinheiro pode ter saído', () => {
    /**
     * A escolha conservadora, e ela é o achado da revisão deste bloco: ler
     * `liquidando` como "não saiu" é o caminho pelo qual o cliente é reembolsado,
     * o barbeiro fica com o dinheiro e ninguém deve nada. Cobrar de quem não
     * recebeu é conserto de um lançamento; não cobrar de quem recebeu é dinheiro
     * que ninguém procura.
     */
    expect(desfechoDoEstornoDeRepasse({ estado: 'liquidando', parte: 'profissional' }))
      .toBe('cobrar_do_profissional');
  });

  it('parte já liquidada ou retida não é tentada de novo', () => {
    expect(proximoPassoDaLiquidacao(pendente({ estado: 'liquidado' }))).toBe('nada');
    expect(proximoPassoDaLiquidacao(pendente({ estado: 'retido' }))).toBe('nada');
    expect(proximoPassoDaLiquidacao(pendente({ estado: 'estornado' }))).toBe('nada');
  });

  it('a parte da casa e a da plataforma não passam por KYC', () => {
    // Elas não têm recebedor: a conta da casa **é** para onde o adquirente manda
    // por padrão, e a da plataforma é a nossa.
    expect(proximoPassoDaLiquidacao(pendente({ kyc: null, recebedorId: null })))
      .toBe('repassar');
  });

  it('estorno antes da liquidação apenas cancela a parte', () => {
    // O dinheiro ainda estava com a plataforma: ninguém deve nada.
    expect(desfechoDoEstornoDeRepasse({ estado: 'pendente', parte: 'profissional' }))
      .toBe('cancelar');
    expect(desfechoDoEstornoDeRepasse({ estado: 'retido', parte: 'profissional' }))
      .toBe('cancelar');
  });

  it('estorno de repasse já liquidado vira dívida do profissional', () => {
    /**
     * *"Estorno com split já liquidado exige política explícita de
     * recuperação."* O dinheiro entrou na conta dele e nenhum adquirente deixa a
     * plataforma sacar de um recebedor. A política é lançar comissão negativa no
     * período aberto — o mesmo mecanismo que o estorno de venda já usa, e que o
     * barbeiro já entende.
     */
    expect(desfechoDoEstornoDeRepasse({ estado: 'liquidado', parte: 'profissional' }))
      .toBe('cobrar_do_profissional');
  });

  it('a parte da casa liquidada não vira dívida de ninguém', () => {
    // O dinheiro nunca saiu de lá: o estorno volta da conta dela pelo próprio
    // adquirente, e não há de quem cobrar.
    expect(desfechoDoEstornoDeRepasse({ estado: 'liquidado', parte: 'barbearia' }))
      .toBe('cancelar');
    expect(desfechoDoEstornoDeRepasse({ estado: 'liquidado', parte: 'plataforma' }))
      .toBe('cancelar');
  });

  it('estornar duas vezes não faz nada na segunda', () => {
    expect(desfechoDoEstornoDeRepasse({ estado: 'estornado', parte: 'profissional' }))
      .toBe('nada');
  });
});
