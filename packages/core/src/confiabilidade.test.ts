import { describe, expect, it } from 'vitest';
import {
  COMPARECIMENTOS_PARA_BONUS,
  MINIMO_DE_HISTORICO,
  pontuacaoDeConfianca,
  type AgendamentoNoHistorico,
  type DesfechoDoAgendamento,
} from './confiabilidade.js';

const AGORA = new Date('2026-08-11T12:00:00Z');

/** Um agendamento há `diasAtras` dias, com o desfecho pedido. */
const em = (
  diasAtras: number,
  desfecho: DesfechoDoAgendamento,
  atrasoMinutos: number | null = null,
): AgendamentoNoHistorico => ({
  comecariaEm: new Date(AGORA.getTime() - diasAtras * 86_400_000),
  desfecho,
  atrasoMinutos,
});

const varios = (
  quantos: number,
  desfecho: DesfechoDoAgendamento,
  aPartirDe = 1,
): AgendamentoNoHistorico[] =>
  Array.from({ length: quantos }, (_, i) => em(aPartirDe + i, desfecho));

describe('presunção de boa-fé', () => {
  it('cliente novo começa em 100, e não em 50', () => {
    // Regra de justiça 1. Um produto que começa todo mundo no meio da escala
    // pede sinal de quem nunca fez nada — e é justamente o cliente novo que a
    // cobrança espanta.
    expect(pontuacaoDeConfianca([], AGORA)).toEqual({
      score: 100,
      considerados: 0,
      temEfeito: false,
    });
  });

  it('abaixo de três agendamentos o score não decide nada', () => {
    // Regra 4. Duas faltas em dois agendamentos dariam score 50 e sinal
    // obrigatório para sempre — sobre uma amostra que não diz nada.
    const duas = pontuacaoDeConfianca([em(10, 'faltou'), em(20, 'faltou')], AGORA);
    expect(duas.temEfeito).toBe(false);
    expect(duas.score).toBe(100);
  });

  it('o terceiro agendamento liga o score', () => {
    const tres = pontuacaoDeConfianca(varios(MINIMO_DE_HISTORICO, 'compareceu'), AGORA);
    expect(tres.temEfeito).toBe(true);
    expect(tres.considerados).toBe(3);
  });
});

describe('a falta pesa muito mais que o cancelamento avisado', () => {
  it('quem sempre comparece fica em 100', () => {
    expect(pontuacaoDeConfianca(varios(5, 'compareceu'), AGORA).score).toBe(100);
  });

  it('uma falta em quatro tira 25 pontos da taxa, não 25 pontos do score', () => {
    // 100 − 25 × (1/4) = 93,75 → 94. A fórmula é sobre **taxa**: uma falta em
    // quatro dói menos que uma falta em quatro... vezes menos histórico.
    const historico = [em(1, 'faltou'), ...varios(3, 'compareceu', 2)];
    expect(pontuacaoDeConfianca(historico, AGORA).score).toBe(94);
  });

  it('faltar sempre derruba o score a 75', () => {
    expect(pontuacaoDeConfianca(varios(4, 'faltou'), AGORA).score).toBe(75);
  });

  it('cancelar avisando custa doze vezes menos que faltar', () => {
    /**
     * É a decisão central do score, e ela é de produto: um cancelamento avisado
     * devolve a vaga para a grade e a fila preenche; uma falta é cadeira parada.
     * Punir quem avisa ensina a não avisar — e quem não avisa vira falta.
     */
    const faltou = pontuacaoDeConfianca(varios(4, 'faltou'), AGORA).score;
    const cancelou = pontuacaoDeConfianca(varios(4, 'cancelou_cedo'), AGORA).score;
    expect(100 - faltou).toBe(25);
    expect(100 - cancelou).toBe(2);
  });

  it('cancelar em cima da hora custa mais que cancelar cedo, e menos que faltar', () => {
    const cedo = pontuacaoDeConfianca(varios(4, 'cancelou_cedo'), AGORA).score;
    const emCima = pontuacaoDeConfianca(varios(4, 'cancelou_em_cima'), AGORA).score;
    const faltou = pontuacaoDeConfianca(varios(4, 'faltou'), AGORA).score;
    expect(faltou).toBeLessThan(emCima);
    expect(emCima).toBeLessThan(cedo);
  });
});

describe('o cancelamento da casa nunca conta', () => {
  it('não pune, e também não dilui a taxa de quem falta', () => {
    /**
     * Regra 3, nos dois sentidos. Deixá-lo no **denominador** seria tão errado
     * quanto no numerador: a barbearia melhoraria o score de quem falta só por
     * ter fechado um dia, e a proteção da agenda afrouxaria sozinha.
     */
    const semACasa = pontuacaoDeConfianca(
      [em(1, 'faltou'), ...varios(3, 'compareceu', 2)],
      AGORA,
    );
    const comACasa = pontuacaoDeConfianca(
      [em(1, 'faltou'), ...varios(3, 'compareceu', 2), ...varios(4, 'cancelado_pela_casa', 10)],
      AGORA,
    );
    expect(comACasa.score).toBe(semACasa.score);
    expect(comACasa.considerados).toBe(semACasa.considerados);
  });

  it('e não interrompe a sequência de comparecimentos do bônus', () => {
    // A barbearia fechou no meio de uma sequência boa. O cliente não tem nada a
    // ver com isso.
    const comFuro = [
      ...varios(5, 'compareceu', 1),
      em(6, 'cancelado_pela_casa'),
      ...varios(5, 'compareceu', 7),
    ];
    expect(pontuacaoDeConfianca(comFuro, AGORA).score).toBe(100);
  });
});

describe('atraso', () => {
  it('atraso acima de dez minutos pesa; abaixo, não', () => {
    const pontual = [...varios(3, 'compareceu'), { ...em(4, 'compareceu'), atrasoMinutos: 9 }];
    const atrasado = [...varios(3, 'compareceu'), { ...em(4, 'compareceu'), atrasoMinutos: 11 }];
    expect(pontuacaoDeConfianca(pontual, AGORA).score).toBe(100);
    expect(pontuacaoDeConfianca(atrasado, AGORA).score).toBe(99);
  });

  it('quem não teve chegada registrada não é contado como atrasado', () => {
    // `atrasoMinutos` nulo é ausência de dado, não pontualidade nem atraso.
    // Tratar nulo como atraso puniria o cliente por um registro que a casa não
    // fez.
    const semRegistro = varios(4, 'compareceu');
    expect(pontuacaoDeConfianca(semRegistro, AGORA).score).toBe(100);
  });
});

describe('bônus de fidelidade', () => {
  it('dez comparecimentos seguidos valem dez pontos', () => {
    const historico = [
      ...varios(COMPARECIMENTOS_PARA_BONUS, 'compareceu', 1),
      em(200, 'faltou'),
    ];
    const semBonus = pontuacaoDeConfianca(
      [...varios(COMPARECIMENTOS_PARA_BONUS - 1, 'compareceu', 1), em(200, 'faltou')],
      AGORA,
    );
    // Com o bônus o teto de 100 é atingido apesar da falta antiga.
    expect(pontuacaoDeConfianca(historico, AGORA).score).toBe(100);
    expect(semBonus.score).toBeLessThan(100);
  });

  it('uma falta recente quebra a sequência', () => {
    const historico = [em(1, 'faltou'), ...varios(COMPARECIMENTOS_PARA_BONUS, 'compareceu', 2)];
    expect(pontuacaoDeConfianca(historico, AGORA).score).toBeLessThan(100);
  });
});

describe('a janela de doze meses', () => {
  it('quem faltou há mais de um ano e voltou recupera integralmente', () => {
    // Regra 6. Sem a janela, uma falta de 2019 seria carregada para sempre — e
    // o score deixaria de medir o cliente de hoje.
    const antigo = [
      { ...em(400, 'faltou') },
      { ...em(380, 'faltou') },
      ...varios(4, 'compareceu', 1),
    ];
    expect(pontuacaoDeConfianca(antigo, AGORA).score).toBe(100);
  });

  it('agendamento futuro não entra na conta', () => {
    // Ele ainda não aconteceu; contá-lo como comparecimento inflaria o score de
    // quem só marcou.
    const comFuturo = [...varios(3, 'faltou', 1), em(-30, 'compareceu')];
    expect(pontuacaoDeConfianca(comFuturo, AGORA).considerados).toBe(3);
  });
});

describe('o score é determinístico', () => {
  it('a ordem do histórico não muda o resultado', () => {
    const historico = [
      em(1, 'compareceu'),
      em(5, 'faltou'),
      em(9, 'cancelou_cedo'),
      em(14, 'compareceu', 20),
    ];
    const invertido = [...historico].reverse();
    expect(pontuacaoDeConfianca(invertido, AGORA)).toEqual(
      pontuacaoDeConfianca(historico, AGORA),
    );
  });

  it('nunca sai de 0 a 100', () => {
    const pessimo = [
      ...varios(20, 'faltou', 1),
      ...Array.from({ length: 20 }, (_, i) => em(30 + i, 'compareceu', 90)),
    ];
    const resultado = pontuacaoDeConfianca(pessimo, AGORA);
    expect(resultado.score).toBeGreaterThanOrEqual(0);
    expect(resultado.score).toBeLessThanOrEqual(100);
  });
});
