import { describe, expect, it } from 'vitest';
import {
  COMPARECIMENTOS_PARA_BONUS,
  MINIMO_DE_HISTORICO,
  podeMarcarOnline,
  pontuacaoDeConfianca,
  temPrioridadeNaEspera,
  type AgendamentoNoHistorico,
  type Confiabilidade,
  type DesfechoDoAgendamento,
} from './confiabilidade.js';
import { LIMIAR_PADRAO_DE_SINAL, SCORE_QUE_DISPENSA_SINAL } from './sinal.js';

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

  it('a falta é medida por taxa, não por ocorrência', () => {
    // 100 − 100 × (1/4) = 75. A mesma falta em vinte agendamentos custa cinco
    // pontos: quem vem sempre não é punido como quem veio quatro vezes.
    const emQuatro = [em(1, 'faltou'), ...varios(3, 'compareceu', 2)];
    const emVinte = [em(1, 'faltou'), ...varios(19, 'compareceu', 2)];
    expect(pontuacaoDeConfianca(emQuatro, AGORA).score).toBe(75);
    expect(pontuacaoDeConfianca(emVinte, AGORA).score).toBe(95);
  });

  it('faltar em todos os agendamentos zera o score', () => {
    /**
     * É a âncora da escala, e ela é o que faz os cortes da SPEC significarem
     * alguma coisa. Com os pesos literais do texto — 25 para a falta — o pior
     * cliente possível sairia com 75, e `score < 60` nunca dispararia: o sinal
     * por histórico seria código morto e ninguém veria vermelho.
     *
     * Se este teste começar a devolver 75, é porque os pesos voltaram ao
     * literal, e o bloco 37 inteiro deixou de funcionar em silêncio.
     */
    expect(pontuacaoDeConfianca(varios(4, 'faltou'), AGORA).score).toBe(0);
  });

  it('cancelar avisando custa doze vezes e meia menos que faltar', () => {
    /**
     * É a decisão central do score, e ela é de produto: um cancelamento avisado
     * devolve a vaga para a grade e a fila preenche; uma falta é cadeira parada.
     * Punir quem avisa ensina a não avisar — e quem não avisa vira falta.
     *
     * A **proporção** é a da SPEC; o que mudou foi a escala dos dois, junta.
     */
    const faltou = pontuacaoDeConfianca(varios(4, 'faltou'), AGORA).score;
    const cancelou = pontuacaoDeConfianca(varios(4, 'cancelou_cedo'), AGORA).score;
    expect(100 - faltou).toBe(100);
    expect(100 - cancelou).toBe(8);
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
    // 100 − 20 × (1/4) = 95.
    expect(pontuacaoDeConfianca(atrasado, AGORA).score).toBe(95);
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

describe('os três cortes da SPEC alcançam alguém', () => {
  /**
   * Este bloco é o que impede o score de virar um número decorativo.
   *
   * A SPEC §2.13 define três cortes de uso — 60, 40 e 85 — e com os pesos
   * literais do texto os dois primeiros são inalcançáveis: o pior cliente
   * possível fica em 75. O sinal por histórico existiria no código, teria
   * teste verde, e **nunca seria cobrado de ninguém**.
   *
   * Cada `it` daqui prende um dos cortes a uma pessoa concreta. Se alguém mexer
   * nos pesos, é aqui que fica vermelho — e a mensagem diz qual regra do produto
   * parou de valer, não qual constante mudou.
   */
  const faltasEm10 = (quantas: number): AgendamentoNoHistorico[] => [
    ...varios(quantas, 'faltou', 1),
    ...varios(10 - quantas, 'compareceu', quantas + 1),
  ];

  const scoreCom = (quantas: number) => pontuacaoDeConfianca(faltasEm10(quantas), AGORA).score;

  it('duas faltas em dez já custam a dispensa do sinal', () => {
    // A dispensa é promessa ao cliente fiel. Quem falta uma vez em cinco não é
    // esse cliente.
    expect(scoreCom(1)).toBeGreaterThanOrEqual(SCORE_QUE_DISPENSA_SINAL);
    expect(scoreCom(2)).toBeLessThan(SCORE_QUE_DISPENSA_SINAL);
  });

  it('faltar metade das vezes passa a exigir sinal', () => {
    expect(scoreCom(4)).toBeGreaterThanOrEqual(LIMIAR_PADRAO_DE_SINAL);
    expect(scoreCom(5)).toBeLessThan(LIMIAR_PADRAO_DE_SINAL);
  });

  it('faltar sete em dez tira o agendamento online', () => {
    // O terceiro corte da SPEC (`score < 40`). A tela dele é lacuna declarada;
    // o número que a alimenta tem que ser alcançável desde já, senão a tela
    // nasce morta.
    expect(scoreCom(6)).toBeGreaterThanOrEqual(40);
    expect(scoreCom(7)).toBeLessThan(40);
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
    // Metade falta, metade chega uma hora e meia atrasada: 100 − 50 − 10 = 40.
    const pessimo = [
      ...varios(20, 'faltou', 1),
      ...Array.from({ length: 20 }, (_, i) => em(30 + i, 'compareceu', 90)),
    ];
    expect(pontuacaoDeConfianca(pessimo, AGORA).score).toBe(40);

    // O bônus somaria 110 em quem já está em 100. O teto é o que impede o score
    // de virar crédito acumulado — dez comparecimentos não compram nada além do
    // topo da escala.
    expect(pontuacaoDeConfianca(varios(12, 'compareceu'), AGORA).score).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// O que o score decide (bloco 60, SPEC §2.13 "Uso")
// ---------------------------------------------------------------------------

describe('recusar marcação online em hora cheia', () => {
  const comScore = (score: number, temEfeito = true): Confiabilidade => ({
    score,
    temEfeito,
    considerados: temEfeito ? 10 : 1,
  });

  const pedido = (extra: Partial<Parameters<typeof podeMarcarOnline>[0]> = {}) =>
    podeMarcarOnline({
      confianca: comScore(20),
      limiar: 40,
      ehHorarioDePico: true,
      peloBalcao: false,
      ...extra,
    });

  it('quem falta muito não marca sozinho na hora cheia', () => {
    expect(pedido()).toEqual({ pode: false, recusa: 'score_no_pico' });
  });

  it('a regra nasce desligada, e desligada não recusa ninguém', () => {
    // Recusar um cliente é a coisa mais cara que este produto faz. Ligada por
    // padrão, a barbearia descobriria a regra pelo cliente que ligou reclamando.
    expect(pedido({ limiar: null }).pode).toBe(true);
  });

  it('fora do pico a mesma pessoa marca normalmente', () => {
    // Fora da hora cheia a falta custa uma cadeira que estaria parada de
    // qualquer forma, e a SPEC separa as duas de propósito.
    expect(pedido({ ehHorarioDePico: false }).pode).toBe(true);
  });

  it('o balcão marca para quem quiser — a regra é de canal, não de atendimento', () => {
    // "só recepção" é o que a SPEC escreve. A leitura contrária transformaria
    // uma restrição de canal numa proibição de atender a pessoa.
    expect(pedido({ peloBalcao: true }).pode).toBe(true);
  });

  it('cliente novo não é recusado nem depois de duas faltas seguidas', () => {
    /**
     * Regra de justiça 1 e 4 da SPEC §2.13 juntas: menos de três agendamentos
     * não tem efeito, e o score é 100 por presunção. A confiabilidade vem do
     * domínio e não de um objeto montado à mão — construído à mão, o teste
     * passaria por causa do 100 e não por causa da guarda, e continuaria verde
     * com a guarda removida.
     */
    const duasFaltas = pontuacaoDeConfianca(
      [
        { desfecho: 'faltou', comecariaEm: new Date('2026-10-01T10:00:00Z'), atrasoMinutos: null },
        { desfecho: 'faltou', comecariaEm: new Date('2026-10-08T10:00:00Z'), atrasoMinutos: null },
      ],
      new Date('2026-11-01T10:00:00Z'),
    );
    /**
     * A invariante é o que protege o novato, e por isso ela é o que se afirma:
     * uma guarda de `temEfeito` dentro de `podeMarcarOnline` nunca dispararia —
     * seria termo que não varia, o defeito que o quarto termo do sinal teve por
     * sete blocos.
     */
    expect(duasFaltas.temEfeito).toBe(false);
    expect(duasFaltas.score).toBe(100);
    expect(pedido({ confianca: duasFaltas, limiar: 100 }).pode).toBe(true);
  });

  it('exatamente no limiar passa — o corte é "abaixo de", não "até"', () => {
    expect(pedido({ confianca: comScore(40) }).pode).toBe(true);
    expect(pedido({ confianca: comScore(39) }).pode).toBe(false);
  });
});

describe('prioridade na lista de espera', () => {
  const comScore = (score: number, temEfeito = true): Confiabilidade => ({
    score,
    temEfeito,
    considerados: temEfeito ? 10 : 1,
  });

  it('quem sempre aparece passa na frente entre iguais', () => {
    expect(temPrioridadeNaEspera(comScore(90), 85)).toBe(true);
    expect(temPrioridadeNaEspera(comScore(84), 85)).toBe(false);
  });

  it('cliente novo não recebe prioridade por um 100 que ainda não provou', () => {
    // `temEfeito` protege o novato dos dois lados: não é punido pela falta de
    // histórico, e também não é premiado por ela.
    expect(temPrioridadeNaEspera(comScore(100, false), 85)).toBe(false);
  });
});
