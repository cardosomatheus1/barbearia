/**
 * Tokens do design system.
 *
 * Semânticos, não paleta: o componente pede `surface` e `textPrimary`, nunca
 * `cinza700`. Trocar a marca vira trocar um arquivo, e nenhum componente
 * precisa saber que a cor mudou.
 *
 * Cada par usado junto está declarado em `CONTRAST_PAIRS` e é verificado contra
 * a WCAG por teste. Contraste que não é medido é contraste que não existe.
 */

export interface ColorScheme {
  /** Fundo da página. */
  readonly surface: string;
  /** Cartão, campo, qualquer coisa acima do fundo. */
  readonly surfaceRaised: string;
  /** Estado de foco/hover sobre superfície. */
  readonly surfaceHover: string;

  readonly textPrimary: string;
  /** Texto de apoio: rótulo, duração, legenda. */
  readonly textMuted: string;
  /** Texto sobre a cor de destaque. */
  readonly textOnAccent: string;

  /** Ação principal do funil. Em barbearia, "Agendar". */
  readonly accent: string;
  readonly accentHover: string;

  readonly border: string;
  /** Borda de campo de formulário — precisa de contraste de componente. */
  readonly borderStrong: string;
  /** Anel de foco. Sempre visível, nunca removido. */
  readonly focus: string;

  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  readonly textOnDanger: string;
}

/**
 * Tema escuro — o padrão da página pública.
 *
 * Barbearia é ambiente de pouca luz e o cliente agenda no celular, muitas vezes
 * na rua. Fundo escuro com destaque âmbar sustenta leitura em tela pequena e
 * combina com a identidade do setor.
 */
export const dark: ColorScheme = {
  surface: '#0E0E10',
  surfaceRaised: '#1A1A1E',
  surfaceHover: '#24242A',

  textPrimary: '#F5F3F0',
  textMuted: '#A8A29B',
  textOnAccent: '#1A1206',

  accent: '#E0A94E',
  accentHover: '#EFBD68',

  border: '#2E2E35',
  borderStrong: '#6E6A64',
  focus: '#7FC4FF',

  success: '#5FD08A',
  warning: '#E8B84B',
  danger: '#FF7A70',
  textOnDanger: '#2A0A07',
};

/**
 * Tema claro — o padrão do admin.
 *
 * O dono e a recepção passam o dia inteiro na tela; fundo claro cansa menos em
 * sessão longa e imprime melhor.
 */
export const light: ColorScheme = {
  surface: '#FBFAF8',
  surfaceRaised: '#FFFFFF',
  surfaceHover: '#F1EEE9',

  textPrimary: '#1A1A1E',
  // O destaque do tema claro é um âmbar escuro, então o texto sobre ele é
  // branco. Reaproveitar o quase-preto do tema escuro dava 3.3:1 no estado de
  // hover — reprovado, e só descoberto porque o par está declarado.
  textOnAccent: '#FFFFFF',
  textMuted: '#5C5751',

  // Escolhido por cálculo, não por gosto: branco sobre ele precisa passar de
  // 4.5:1 e o tom precisa continuar lendo como âmbar. #A9741B, a primeira
  // tentativa, dava 4.04 — reprovado.
  accent: '#9C6C0E',
  accentHover: '#855C0C',

  border: '#DFDAD2',
  borderStrong: '#8A847C',
  focus: '#1F6FD0',

  success: '#1C7A45',
  warning: '#8A5D00',
  danger: '#B3261E',
  textOnDanger: '#FFFFFF',
};

/** Par de cores que aparece junto na interface, com o mínimo que precisa cumprir. */
export interface ContrastPair {
  readonly foreground: keyof ColorScheme;
  readonly background: keyof ColorScheme;
  readonly kind: 'text' | 'largeText' | 'component';
  readonly why: string;
}

/**
 * Todos os pares que a interface realmente usa.
 *
 * Manter esta lista em dia é o que faz o teste valer: par não declarado é par
 * não verificado.
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { foreground: 'textPrimary', background: 'surface', kind: 'text', why: 'corpo da página' },
  { foreground: 'textPrimary', background: 'surfaceRaised', kind: 'text', why: 'texto em cartão' },
  { foreground: 'textPrimary', background: 'surfaceHover', kind: 'text', why: 'item sob o cursor' },
  { foreground: 'textMuted', background: 'surface', kind: 'text', why: 'duração e preço de apoio' },
  { foreground: 'textMuted', background: 'surfaceRaised', kind: 'text', why: 'rótulo em cartão' },
  { foreground: 'textOnAccent', background: 'accent', kind: 'text', why: 'botão Agendar' },
  { foreground: 'textOnAccent', background: 'accentHover', kind: 'text', why: 'botão sob o cursor' },
  { foreground: 'accent', background: 'surface', kind: 'largeText', why: 'preço em destaque' },
  { foreground: 'accent', background: 'surfaceRaised', kind: 'largeText', why: 'preço em cartão' },
  { foreground: 'textOnDanger', background: 'danger', kind: 'text', why: 'botão Cancelar' },
  { foreground: 'danger', background: 'surface', kind: 'text', why: 'mensagem de erro' },
  { foreground: 'danger', background: 'surfaceRaised', kind: 'text', why: 'erro em cartão' },
  { foreground: 'success', background: 'surface', kind: 'text', why: 'confirmação' },
  { foreground: 'warning', background: 'surface', kind: 'text', why: 'aviso' },
  { foreground: 'borderStrong', background: 'surface', kind: 'component', why: 'borda de campo' },
  { foreground: 'borderStrong', background: 'surfaceRaised', kind: 'component', why: 'borda em cartão' },
  { foreground: 'focus', background: 'surface', kind: 'component', why: 'anel de foco' },
  { foreground: 'focus', background: 'surfaceRaised', kind: 'component', why: 'foco em cartão' },
  { foreground: 'accent', background: 'surface', kind: 'component', why: 'ícone de destaque' },
];

/** Escala de espaçamento. Base 4px — múltiplos batem com a grade de tipografia. */
export const space = {
  '0': '0',
  '1': '0.25rem',
  '2': '0.5rem',
  '3': '0.75rem',
  '4': '1rem',
  '5': '1.5rem',
  '6': '2rem',
  '7': '3rem',
  '8': '4rem',
} as const;

export const radius = {
  sm: '0.375rem',
  md: '0.625rem',
  lg: '1rem',
  full: '9999px',
} as const;

export const font = {
  /** Pilha de sistema: zero requisição de rede e zero deslocamento de layout. */
  sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  /** Numerais tabulares para horário e preço: coluna que não dança ao trocar de valor. */
  numeric:
    "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
} as const;

export const fontSize = {
  xs: '0.75rem',
  sm: '0.875rem',
  base: '1rem',
  lg: '1.125rem',
  xl: '1.375rem',
  '2xl': '1.75rem',
  '3xl': '2.25rem',
} as const;

export const fontWeight = {
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/**
 * Alvo de toque mínimo.
 *
 * 44px é o piso das diretrizes de acessibilidade para dedo. O cliente agenda em
 * pé, na rua, com uma mão — botão menor que isso vira erro de toque.
 */
export const MIN_TOUCH_TARGET_PX = 44;

/**
 * Pontos de quebra.
 *
 * Nomeados pelo contexto de uso, não por dispositivo: "tablet" envelhece,
 * "a partir de 640px" não. Sempre aplicados com `min-width` — ver a regra de
 * mobile-first no CLAUDE.md.
 *
 * O piso de projeto é 360px: Android popular no Brasil, que é o aparelho em que
 * o cliente da barbearia realmente agenda.
 */
export const breakpoint = {
  /** Piso de projeto. Nada pode quebrar abaixo disso. */
  base: '360px',
  /** Celular grande e landscape. */
  sm: '480px',
  /** Tablet em pé; a partir daqui cabem duas colunas. */
  md: '768px',
  /** Notebook; o admin começa a ficar confortável. */
  lg: '1024px',
  /** Monitor; a agenda do admin ganha colunas por profissional. */
  xl: '1280px',
} as const;

export const size = {
  touch: `${MIN_TOUCH_TARGET_PX}px`,
  /** Largura máxima de leitura confortável. */
  readable: '65ch',
  /** Largura máxima do conteúdo da página pública. */
  container: '72rem',
} as const;

export const motion = {
  fast: '120ms',
  base: '200ms',
  /** Curva de saída: rápida no início, suave no fim. */
  ease: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

export const shadow = {
  sm: '0 1px 2px rgb(0 0 0 / 0.16)',
  md: '0 4px 12px rgb(0 0 0 / 0.20)',
  lg: '0 12px 32px rgb(0 0 0 / 0.28)',
} as const;

export const zIndex = {
  base: 0,
  sticky: 10,
  overlay: 100,
  modal: 200,
  toast: 300,
} as const;
