import { describe, expect, it } from 'vitest';
import type { Confiabilidade } from './confiabilidade.js';
import {
  LIMIAR_PADRAO_DE_SINAL,
  POLITICA_SEM_SINAL,
  SCORE_QUE_DISPENSA_SINAL,
  decidirReembolso,
  decidirSinal,
  valorDoSinal,
  type PoliticaDeSinal,
} from './sinal.js';

const FIXO: PoliticaDeSinal = {
  ...POLITICA_SEM_SINAL,
  modalidade: 'fixo',
  valorFixoCents: 2000,
  limiarDeScore: LIMIAR_PADRAO_DE_SINAL,
};

/** Um score com efeito, no valor pedido. */
const com = (score: number): Confiabilidade => ({ score, considerados: 8, temEfeito: true });
/** Cliente novo: 100 por presunção, sem efeito. */
const NOVO: Confiabilidade = { score: 100, considerados: 1, temEfeito: false };
/**
 * Score baixo **sem** efeito.
 *
 * `pontuacaoDeConfianca` nunca devolve isto — ela força 100 abaixo de três
 * agendamentos. Mas `decidirSinal` recebe o número de fora e não pode depender
 * de uma invariante que mora em outra função: no dia em que alguém passar um
 * score vindo do banco, ou de um override do gerente, é `temEfeito` que segura.
 * A primeira versão deste teste usava score 100 e passava mesmo com a guarda
 * removida — provava a aritmética, não a regra.
 */
const NOVO_COM_SCORE_RUIM: Confiabilidade = { score: 30, considerados: 2, temEfeito: false };

const pedir = (extra: Partial<Parameters<typeof decidirSinal>[0]> = {}) =>
  decidirSinal({
    politica: FIXO,
    confianca: com(90),
    ticketCents: 7000,
    servicoSempreExige: false,
    ...extra,
  });

describe('quanto custa o sinal', () => {
  it('percentual sai em centavos inteiros, arredondado uma vez', () => {
    const politica = { ...FIXO, modalidade: 'percentual' as const, percentualBps: 3000 };
    expect(valorDoSinal(politica, 7000)).toBe(2100);
    // 30% de 6.999 = 2.099,7 → 2100. Meio centavo não existe.
    expect(valorDoSinal(politica, 6999)).toBe(2100);
  });

  it('nunca passa do ticket', () => {
    /**
     * Um sinal maior que o serviço seria a barbearia cobrando adiantado mais do
     * que vai faturar — e o cliente pagando para marcar. Acontece de verdade com
     * sinal fixo de R$ 20 num pezinho de R$ 15.
     */
    expect(valorDoSinal(FIXO, 1500)).toBe(1500);
    expect(valorDoSinal({ ...FIXO, modalidade: 'total' }, 7000)).toBe(7000);
  });

  it('a modalidade "nenhum" custa zero, qualquer que seja o valor cadastrado', () => {
    expect(valorDoSinal({ ...FIXO, modalidade: 'nenhum' }, 7000)).toBe(0);
  });
});

describe('de quem se pede sinal', () => {
  it('com a modalidade desligada, de ninguém', () => {
    expect(pedir({ politica: POLITICA_SEM_SINAL, confianca: com(10) }).exigido).toBe(false);
  });

  it('score sem efeito não exige sinal, por baixo que seja', () => {
    expect(pedir({ confianca: NOVO_COM_SCORE_RUIM }).exigido).toBe(false);
  });

  it('cliente novo não paga sinal', () => {
    /**
     * É a razão de o sinal ser seletivo. Cobrar de quem nunca veio espanta
     * exatamente o cliente que a barbearia quer, e o score dele é 100 por
     * presunção — não por mérito, e portanto não pode exigir nada.
     */
    expect(pedir({ confianca: NOVO }).exigido).toBe(false);
  });

  it('quem está abaixo do limiar paga, e o motivo é o histórico', () => {
    const decisao = pedir({ confianca: com(LIMIAR_PADRAO_DE_SINAL - 1) });
    expect(decisao).toEqual({ exigido: true, motivo: 'score', valorCents: 2000 });
  });

  it('exatamente no limiar não paga — o corte é estrito', () => {
    expect(pedir({ confianca: com(LIMIAR_PADRAO_DE_SINAL) }).exigido).toBe(false);
  });

  it('serviço que sempre exige cobra até de quem tem histórico bom', () => {
    const decisao = pedir({ confianca: com(80), servicoSempreExige: true });
    expect(decisao.exigido).toBe(true);
    expect(decisao.motivo).toBe('servico');
  });

  it('ticket acima do teto cobra de qualquer um', () => {
    const decisao = pedir({
      politica: { ...FIXO, tetoSemSinalCents: 20000 },
      confianca: com(70),
      ticketCents: 25000,
    });
    expect(decisao.motivo).toBe('ticket');
  });

  it('teto zerado desliga o termo do ticket', () => {
    expect(pedir({ confianca: com(70), ticketCents: 500000 }).exigido).toBe(false);
  });
});

describe('quem nunca faltou não paga sinal', () => {
  it('score alto dispensa até o serviço que sempre exige', () => {
    /**
     * A dispensa é a contrapartida que torna a cobrança justa: se nem o cliente
     * impecável escapa, o sinal deixa de ser seletivo e vira pedágio.
     */
    const decisao = pedir({ confianca: com(SCORE_QUE_DISPENSA_SINAL), servicoSempreExige: true });
    expect(decisao.exigido).toBe(false);
  });

  it('mas não dispensa quando o risco é o tamanho da reserva', () => {
    // Ali o risco não é a pessoa: uma falta de quatro serviços num sábado custa
    // o sábado, por melhor que seja o histórico.
    const decisao = pedir({
      politica: { ...FIXO, tetoSemSinalCents: 20000 },
      confianca: com(100),
      ticketCents: 25000,
    });
    expect(decisao).toMatchObject({ exigido: true, motivo: 'ticket' });
  });

  it('um ponto abaixo da dispensa já paga', () => {
    const decisao = pedir({
      confianca: com(SCORE_QUE_DISPENSA_SINAL - 1),
      servicoSempreExige: true,
    });
    expect(decisao.exigido).toBe(true);
  });
});

describe('o motivo é o primeiro que se aplica, na ordem de explicar', () => {
  it('serviço vem antes de histórico', () => {
    // "Este serviço sempre pede sinal" é uma frase sobre o serviço. "Seu
    // histórico" é sobre a pessoa, e ninguém quer dizê-la havendo outra
    // verdadeira antes.
    const decisao = pedir({ confianca: com(20), servicoSempreExige: true });
    expect(decisao.motivo).toBe('servico');
  });

  it('histórico vem antes de ticket', () => {
    const decisao = pedir({
      politica: { ...FIXO, tetoSemSinalCents: 5000 },
      confianca: com(20),
      ticketCents: 9000,
    });
    expect(decisao.motivo).toBe('score');
  });
});

describe('o sinal volta ou fica', () => {
  const reembolso = (extra: Partial<Parameters<typeof decidirReembolso>[0]> = {}) =>
    decidirReembolso({
      politica: { ...FIXO, horasParaReembolso: 24 },
      quem: 'cliente',
      horasDeAntecedencia: 48,
      ...extra,
    });

  it('a casa cancelou: devolve sempre, mesmo em cima da hora', () => {
    expect(reembolso({ quem: 'casa', horasDeAntecedencia: 0 }).desfecho).toBe('devolver');
  });

  it('faltou sem avisar: retém — é o caso para o qual o sinal existe', () => {
    expect(reembolso({ quem: 'falta', horasDeAntecedencia: null }).desfecho).toBe('reter');
  });

  it('avisou dentro do prazo: devolve', () => {
    /**
     * Espelha a regra do score de propósito. Reter de quem cancela com dois dias
     * ensinaria a não cancelar — e a vaga que voltaria para a grade viraria
     * cadeira parada.
     */
    expect(reembolso({ horasDeAntecedencia: 24 }).desfecho).toBe('devolver');
    expect(reembolso({ horasDeAntecedencia: 100 }).desfecho).toBe('devolver');
  });

  it('cancelou depois do prazo: retém', () => {
    expect(reembolso({ horasDeAntecedencia: 23 }).desfecho).toBe('reter');
    expect(reembolso({ horasDeAntecedencia: 0 }).desfecho).toBe('reter');
  });

  it('antecedência desconhecida devolve, e não retém', () => {
    /**
     * Ela só é nula em agendamento anterior à migração que passou a carimbar o
     * cancelamento. Reter o dinheiro de alguém por causa de um registro que a
     * casa não fez é cobrar pelo próprio buraco.
     */
    const decisao = reembolso({ horasDeAntecedencia: null });
    expect(decisao.desfecho).toBe('devolver');
    expect(decisao.porque).toContain('registro');
  });

  it('toda decisão vem com o motivo escrito', () => {
    // A recepção repete a frase para o cliente, e o cliente discute o motivo,
    // não o código.
    for (const quem of ['cliente', 'casa', 'falta'] as const) {
      expect(reembolso({ quem }).porque.length).toBeGreaterThan(10);
    }
  });
});
