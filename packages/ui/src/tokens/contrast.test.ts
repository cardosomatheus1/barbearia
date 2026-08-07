import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  meetsContrast,
  parseHex,
  relativeLuminance,
  requiredRatio,
} from './contrast.js';

describe('parseHex', () => {
  it('aceita 3 e 6 dígitos, com ou sem cerquilha', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseHex('#E0A94E')).toEqual({ r: 224, g: 169, b: 78 });
  });

  it('recusa entrada inválida', () => {
    for (const value of ['', '#12', '#12345', 'rgb(0,0,0)', '#gggggg']) {
      expect(() => parseHex(value)).toThrow(RangeError);
    }
  });
});

describe('contrastRatio', () => {
  it('preto e branco dão o máximo de 21', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
  });

  it('cores idênticas dão 1', () => {
    expect(contrastRatio('#E0A94E', '#E0A94E')).toBeCloseTo(1, 5);
  });

  it('é simétrico', () => {
    expect(contrastRatio('#0E0E10', '#F5F3F0')).toBeCloseTo(
      contrastRatio('#F5F3F0', '#0E0E10'),
      10,
    );
  });

  it('bate com valores conhecidos da WCAG', () => {
    // Referências públicas amplamente usadas para calibrar implementações.
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
  });
});

describe('relativeLuminance', () => {
  it('preto é 0 e branco é 1', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 6);
  });
});

describe('requiredRatio', () => {
  it('segue a tabela da WCAG', () => {
    expect(requiredRatio('AA', 'normal')).toBe(4.5);
    expect(requiredRatio('AA', 'large')).toBe(3);
    expect(requiredRatio('AAA', 'normal')).toBe(7);
    expect(requiredRatio('AAA', 'large')).toBe(4.5);
  });
});

describe('meetsContrast', () => {
  it('aprova no limite e reprova logo abaixo', () => {
    // #767676 sobre branco = 4.54, acima de 4.5. #777777 = 4.48, abaixo.
    expect(meetsContrast('#767676', '#FFFFFF')).toBe(true);
    expect(meetsContrast('#777777', '#FFFFFF')).toBe(false);
  });

  it('texto grande passa com menos contraste', () => {
    expect(meetsContrast('#949494', '#FFFFFF', 'AA', 'normal')).toBe(false);
    expect(meetsContrast('#949494', '#FFFFFF', 'AA', 'large')).toBe(true);
  });
});
