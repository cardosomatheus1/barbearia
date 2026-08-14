import { describe, expect, it } from 'vitest';
import {
  DISTANCIA_RELEVANTE_BPS,
  adotar,
  distanciaDoPadrao,
  fraseDaDistancia,
  republicar,
} from './franquia.js';

describe('o padrão da franquia', () => {
  it('a distância tem sinal, e o sinal não vira julgamento', () => {
    const abaixo = distanciaDoPadrao(5500, 4500);
    expect(abaixo?.sentido).toBe('abaixo');
    expect(abaixo?.diferencaCents).toBe(-1000);
    // 1000 / 5500 = 18,18%
    expect(abaixo?.bps).toBe(1818);

    const acima = distanciaDoPadrao(5500, 6600);
    expect(acima?.sentido).toBe('acima');
    expect(acima?.bps).toBe(2000);

    // A frase descreve. "Abaixo do que deveria" é a frase que este produto não
    // pode dizer: a franqueada é outra empresa.
    expect(fraseDaDistancia(abaixo)).toBe('18,2% abaixo do padrão');
    expect(fraseDaDistancia(acima)).toBe('20% acima do padrão');
  });

  it('preço de referência zero devolve null, nunca infinito', () => {
    /**
     * Divisão com denominador zero num relatório devolve `null`. A franqueadora
     * que cadastra um item de cortesia é exatamente quem veria "∞%" — e é a
     * primeira vez que ela abre a tela.
     */
    expect(distanciaDoPadrao(0, 4500)).toBeNull();
    expect(fraseDaDistancia(null)).toBe('sem preço de referência');
  });

  it('abaixo do corte a distância não é assunto', () => {
    // R$ 50 contra R$ 55 é arredondamento de tabela. Marcar tudo faz a lista
    // inteira acender, que é o mesmo que nada acender.
    const pequena = distanciaDoPadrao(5500, 5000);
    expect(pequena?.bps).toBeLessThan(DISTANCIA_RELEVANTE_BPS);
    expect(pequena?.relevante).toBe(false);

    const grande = distanciaDoPadrao(5500, 4900);
    expect(grande?.relevante).toBe(true);
  });

  it('preço igual é "igual", e não uma distância de zero por cento', () => {
    const d = distanciaDoPadrao(5500, 5500);
    expect(d?.sentido).toBe('igual');
    expect(fraseDaDistancia(d)).toBe('igual ao padrão');
  });

  it('adotar copia o preço uma vez; republicar não o copia nunca', () => {
    /**
     * A regra inteira do bloco numa asserção: o número da franqueadora vira o
     * número cobrado **só** no momento em que alguém da franqueada manda. Se
     * `republicar` devolvesse preço, subir o padrão em maio mudaria o que a
     * franqueada cobra em maio, sem ninguém de lá ter decidido — e isso é
     * imposição de preço de revenda.
     */
    const item = {
      name: 'Corte social',
      description: 'Máquina e tesoura',
      referenciaCents: 5500,
      durationMinutes: 30,
    };

    expect(adotar(item)).toEqual({
      name: 'Corte social',
      description: 'Máquina e tesoura',
      priceCents: 5500,
      durationMinutes: 30,
    });

    const depois = republicar({ ...item, referenciaCents: 7500 });
    expect(depois).not.toHaveProperty('priceCents');
    expect(depois).toEqual({
      name: 'Corte social',
      description: 'Máquina e tesoura',
      durationMinutes: 30,
    });
  });
});
