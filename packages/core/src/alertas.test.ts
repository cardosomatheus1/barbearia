import { describe, expect, it } from 'vitest';

import { avaliar, filaTravada, volumeDeAgendamentoCaiu } from './alertas.js';

/**
 * O que estes testes provam não é que a conta bate — é que o alerta **não
 * dispara** nos casos em que disparar seria pior do que ficar quieto.
 *
 * Um sistema de alerta que grita à toa é desligado em duas semanas, e aí ele
 * não avisa nem quando importa. Por isso metade daqui é caminho triste do
 * alerta: pouco volume, dia da semana errado, fila cheia mas andando.
 */

describe('volume de agendamento', () => {
  it('queda pela metade numa casa movimentada é crítico', () => {
    const alerta = volumeDeAgendamentoCaiu({ hoje: 8, mesmoDiaSemanaPassada: 24 });

    expect(alerta?.severidade).toBe('critico');
    expect(alerta?.frase).toContain('67%');
    expect(alerta?.frase).toContain('página pública');
  });

  it('barbearia pequena não leva susto por variação normal', () => {
    // Três para um é −67%, o mesmo percentual do caso acima. A diferença é que
    // aqui não significa nada: é uma terça fraca numa casa de duas cadeiras.
    expect(volumeDeAgendamentoCaiu({ hoje: 1, mesmoDiaSemanaPassada: 3 })).toBeNull();
  });

  it('barbearia que abriu esta semana não regrediu', () => {
    expect(volumeDeAgendamentoCaiu({ hoje: 4, mesmoDiaSemanaPassada: 0 })).toBeNull();
  });

  it('crescer não é alerta', () => {
    expect(volumeDeAgendamentoCaiu({ hoje: 40, mesmoDiaSemanaPassada: 20 })).toBeNull();
  });

  it('queda de um terço é aviso, não crítico', () => {
    const alerta = volumeDeAgendamentoCaiu({ hoje: 13, mesmoDiaSemanaPassada: 20 });

    expect(alerta?.severidade).toBe('aviso');
  });
});

describe('fila de trabalho', () => {
  it('o sinal é a idade da tarefa, não o tamanho da fila', () => {
    // As quatro combinações, e é por serem as quatro que este teste prova
    // alguma coisa. A primeira versão dele só tinha as duas do meio, e uma
    // implementação que olhasse **o tamanho** da fila passava nas duas — o
    // teste parecia prova e não era.
    const nova = 2;
    const velha = 75;

    // fila grande e andando: sábado de manhã. Alertar aqui é alertar todo sábado.
    expect(filaTravada({ pendentes: 300, idadeDaMaisAntigaMinutos: nova })).toBeNull();
    // fila pequena e andando: o caso mais comum do dia inteiro.
    expect(filaTravada({ pendentes: 3, idadeDaMaisAntigaMinutos: nova })).toBeNull();

    // fila pequena e parada: worker morto, e é o que precisa acordar alguém.
    expect(filaTravada({ pendentes: 2, idadeDaMaisAntigaMinutos: velha })?.severidade).toBe(
      'critico',
    );
    // fila grande e parada: idem, com mais estrago acumulado.
    const grandeEParada = filaTravada({ pendentes: 300, idadeDaMaisAntigaMinutos: velha });
    expect(grandeEParada?.severidade).toBe('critico');
    expect(grandeEParada?.frase).toContain('worker');
  });

  it('fila vazia nunca alerta, por mais velha que seja a marca', () => {
    expect(filaTravada({ pendentes: 0, idadeDaMaisAntigaMinutos: 9999 })).toBeNull();
  });

  it('vinte minutos parada é aviso', () => {
    expect(filaTravada({ pendentes: 5, idadeDaMaisAntigaMinutos: 20 })?.severidade).toBe('aviso');
  });
});

describe('avaliar', () => {
  it('devolve só o que disparou, crítico na frente', () => {
    const alertas = avaliar({
      volume: { hoje: 13, mesmoDiaSemanaPassada: 20 }, // aviso
      fila: { pendentes: 2, idadeDaMaisAntigaMinutos: 90 }, // crítico
    });

    expect(alertas.map((a) => a.regra)).toEqual(['fila.travada', 'agendamento.volume_caiu']);
  });

  it('sem medida nenhuma, silêncio', () => {
    expect(avaliar({})).toEqual([]);
  });

  it('barbearia recém-aberta, com tudo zerado, não acorda ninguém', () => {
    // O caso que mais assusta de graça: casa nova, sem histórico, sem visita e
    // sem fila. Zero em toda parte parece catástrofe e é só uma barbearia que
    // abriu ontem. `exactOptionalPropertyTypes` já impede passar `undefined`
    // explícito, então a ausência aqui é omissão de verdade — que é como o
    // coletor monta o objeto.
    const alertas = avaliar({
      volume: { hoje: 0, mesmoDiaSemanaPassada: 0 },
      fila: { pendentes: 0, idadeDaMaisAntigaMinutos: 0 },
    });

    expect(alertas).toEqual([]);
  });
});
