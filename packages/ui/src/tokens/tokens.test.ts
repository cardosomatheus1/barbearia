import { describe, expect, it } from 'vitest';
import { contrastRatio, requiredRatio, UI_COMPONENT_MIN_RATIO } from './contrast.js';
import {
  CONTRAST_PAIRS,
  dark,
  light,
  MIN_TOUCH_TARGET_PX,
  type ColorScheme,
} from './tokens.js';

const themes: readonly [string, ColorScheme][] = [
  ['escuro', dark],
  ['claro', light],
];

describe('tokens — acessibilidade de cor', () => {
  for (const [name, theme] of themes) {
    describe(`tema ${name}`, () => {
      for (const pair of CONTRAST_PAIRS) {
        const minimum =
          pair.kind === 'component'
            ? UI_COMPONENT_MIN_RATIO
            : requiredRatio('AA', pair.kind === 'largeText' ? 'large' : 'normal');

        it(`${pair.foreground} sobre ${pair.background} (${pair.why}) atinge ${minimum}:1`, () => {
          const ratio = contrastRatio(theme[pair.foreground], theme[pair.background]);
          expect(
            ratio,
            `${pair.foreground}/${pair.background} = ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(minimum);
        });
      }
    });
  }
});

describe('tokens — consistência', () => {
  it('os dois temas declaram exatamente as mesmas chaves', () => {
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });

  it('toda cor é hexadecimal de 6 dígitos', () => {
    for (const [name, theme] of themes) {
      for (const [key, value] of Object.entries(theme)) {
        expect(value, `${name}.${key}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it('todo token de cor aparece em algum par verificado', () => {
    // Cor que ninguém declarou como par é cor cujo contraste nunca foi medido.
    const declared = new Set(
      CONTRAST_PAIRS.flatMap((pair) => [pair.foreground, pair.background]),
    );
    // `border` é separador decorativo — a WCAG 1.4.11 exige contraste de
    // componentes que transmitem informação ou estado, não de divisória
    // estética. A borda funcional é `borderStrong`, essa sim verificada.
    const exempt = new Set<keyof ColorScheme>(['border']);
    for (const key of Object.keys(dark) as (keyof ColorScheme)[]) {
      if (exempt.has(key)) continue;
      expect(declared.has(key), `token "${key}" não é verificado por nenhum par`).toBe(true);
    }
  });

  it('o alvo de toque mínimo respeita a diretriz de 44px', () => {
    expect(MIN_TOUCH_TARGET_PX).toBeGreaterThanOrEqual(44);
  });
});
