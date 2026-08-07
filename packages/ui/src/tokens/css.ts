import { buttonCss } from '../components/Button.js';
import { fieldCss } from '../components/Field.js';
import { primitivesCss } from '../components/primitives.js';
import {
  dark,
  light,
  fontSize,
  fontWeight,
  font,
  motion,
  radius,
  shadow,
  size,
  space,
  zIndex,
  type ColorScheme,
} from './tokens.js';

/**
 * Gera as custom properties do CSS a partir dos tokens tipados.
 *
 * Uma fonte só: os tokens em TypeScript são verificados por teste, e o CSS é
 * derivado deles. Manter duas listas em paralelo garantiria que uma delas
 * ficasse desatualizada.
 */

function colorBlock(scheme: ColorScheme): string {
  return Object.entries(scheme)
    .map(([key, value]) => `  --color-${kebab(key)}: ${value};`)
    .join('\n');
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function block(prefix: string, values: Record<string, string | number>): string {
  return Object.entries(values)
    .map(([key, value]) => `  --${prefix}-${kebab(key)}: ${value};`)
    .join('\n');
}

export function emitCss(): string {
  return `/* Gerado por packages/ui/src/tokens/css.ts. Não editar à mão. */

:root {
  color-scheme: dark;
${colorBlock(dark)}

${block('space', space)}
${block('radius', radius)}
${block('font-size', fontSize)}
${block('font-weight', fontWeight)}
${block('font', font)}
${block('size', size)}
${block('motion', motion)}
${block('shadow', shadow)}
${block('z', zIndex)}
}

/* O admin usa tema claro; a página pública fica no escuro. */
[data-theme='light'] {
  color-scheme: light;
${colorBlock(light)}
}

/* Quem prefere claro no sistema recebe claro, a menos que a página fixe o tema. */
@media (prefers-color-scheme: light) {
  :root:not([data-theme='dark']) {
    color-scheme: light;
${colorBlock(light)}
  }
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-family: var(--font-sans);
  font-size: var(--font-size-base);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/*
 * Anel de foco visível em tudo que recebe foco por teclado.
 *
 * Nunca usar \`outline: none\` sem substituir: quem navega por teclado perde a
 * noção de onde está e o formulário fica inoperável.
 */
:where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

/* Respeita quem pediu menos movimento no sistema operacional. */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

/* Horário e preço em coluna: numerais de largura fixa não dançam. */
.tabular {
  font-variant-numeric: tabular-nums;
}
${buttonCss}
${fieldCss}
${primitivesCss}
`;
}
