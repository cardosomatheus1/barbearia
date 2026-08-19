import { buttonCss } from '../components/Button.js';
import { fieldCss } from '../components/Field.js';
import { primitivesCss } from '../components/primitives.js';
import {
  breakpoint,
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
${block('breakpoint', breakpoint)}
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

/*
 * Nada estoura a largura da tela.
 *
 * Rolagem horizontal no corpo é o defeito mais comum em página de barbearia
 * aberta no celular: um preço largo, uma imagem sem limite, uma tabela — e a
 * página inteira passa a arrastar de lado. Conteúdo largo rola dentro do
 * próprio recipiente.
 */
html, body {
  max-width: 100%;
  overflow-x: hidden;
}

img, video, svg {
  max-width: 100%;
  height: auto;
}

/* Recipiente largo rola sozinho, sem levar a página junto. */
.ui-scroll-x {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  /*
   * O "relative" não é enfeite: sem ele o recipiente não é bloco contentor, e
   * todo descendente "position: absolute" — incluindo cada .ui-visually-hidden
   * — é posicionado contra a página, na coordenada que tem dentro do conteúdo
   * largo. Um rótulo de leitor de tela na quarta coluna de uma tabela de 682px
   * ia parar em x=420 no documento e levava a página a rolar 424px numa tela de
   * 360. "overflow" sozinho não segura quem se posiciona fora do fluxo.
   */
  position: relative;
  /*
   * A **pista de que rola** (bloco 99).
   *
   * Conteudo largo cortado na direita, sem barra visivel, le como conteudo que
   * acabou: quem opera no celular nao descobre que ha mais tres colunas do
   * heatmap ou mais quatro telas na barra de secoes. O gradiente de mascara
   * apaga a borda direita **enquanto ha o que rolar** e some no fim, entao ele
   * e a propria informacao e nao um enfeite fixo.
   *
   * A propriedade animation-timeline com scroll(self inline) faz isso sem um byte de
   * JavaScript. Onde o navegador nao suporta, a regra inteira e ignorada e o
   * recipiente fica como antes — degradacao silenciosa, nao quebra.
   */
  scroll-timeline: --rolagem-x inline;
}

@supports (animation-timeline: scroll(self inline)) {
  .ui-scroll-x {
    mask-image: linear-gradient(to right, #000 0 calc(100% - 2.5rem), transparent 100%);
    animation: ui-fim-da-rolagem linear both;
    animation-timeline: scroll(self inline);
    animation-range: contain;
  }

  /* No fim da rolagem nao ha mais o que anunciar: a mascara sai inteira. */
  @keyframes ui-fim-da-rolagem {
    to {
      mask-image: linear-gradient(to right, #000 0 100%, #000 100%);
    }
  }

  /* Quem pediu menos movimento nao perde a informacao: ela vira estatica. */
  @media (prefers-reduced-motion: reduce) {
    .ui-scroll-x { animation: none; }
  }
}

/*
 * Barra de ação fixa no rodapé respeita a área segura do aparelho.
 *
 * Sem isso o botão "Agendar" fica debaixo da barra de gestos do iPhone e o
 * cliente não consegue tocar no elemento mais importante da página.
 */
.ui-sticky-action {
  position: sticky;
  bottom: 0;
  padding: var(--space-3) var(--space-4);
  padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
  background: var(--color-surface);
  border-top: 1px solid var(--color-border);
  z-index: var(--z-sticky);
}

/* A barra já tem recuo próprio. Um container dentro dela somaria o dele, e a
   ação principal ficaria mais estreita que o conteúdo logo acima — desalinho
   visível justamente no elemento mais importante da tela. */
.ui-sticky-action > .ui-container {
  padding-inline: 0;
}

.ui-container {
  width: 100%;
  max-width: var(--size-container);
  margin-inline: auto;
  padding-inline: var(--space-4);
}

@media (min-width: 768px) {
  .ui-container { padding-inline: var(--space-6); }
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
