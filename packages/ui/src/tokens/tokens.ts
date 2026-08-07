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
 * A paleta vem de um artefato concreto do ofício: a cadeira de barbeiro
 * esmaltada em verde-menta, com cromado, contra parede de azulejo. Ardósia
 * esverdeada de fundo (tem matiz, não é quase-preto), esmalte como acento,
 * cromado no texto de apoio.
 *
 * A versão anterior era âmbar sobre quase-preto — exatamente um dos três
 * visuais que a skill `frontend-design` aponta como default de design gerado
 * por IA. Tinha justificativa de fachada (couro, latão), mas paleta escura com
 * um acento é o lugar mais previsível possível. Ver
 * `docs/03-direcao-visual.md`.
 */
export const dark: ColorScheme = {
  surface: '#141F1E',
  surfaceRaised: '#1D2B29',
  surfaceHover: '#273634',

  textPrimary: '#F1EEE8',
  textMuted: '#A3B0AD',
  textOnAccent: '#08201A',

  accent: '#79D2B8',
  accentHover: '#5FBFA3',

  border: '#2A3936',
  borderStrong: '#6F7D7A',
  focus: '#8FCBFF',

  success: '#7FD69B',
  warning: '#E6C05F',
  danger: '#FF8D7A',
  textOnDanger: '#2A0D07',
};

/**
 * Tema claro — o padrão do admin.
 *
 * O dono e a recepção passam o dia inteiro na tela; fundo claro cansa menos em
 * sessão longa e imprime melhor.
 */
export const light: ColorScheme = {
  surface: '#F4F2EC',
  surfaceRaised: '#FFFFFF',
  surfaceHover: '#E8E5DC',

  textPrimary: '#141F1E',
  textMuted: '#4E5A57',
  // O esmalte claro precisa ser escuro o bastante para sustentar texto branco.
  textOnAccent: '#FFFFFF',

  accent: '#0E6E57',
  accentHover: '#0A5A47',

  border: '#DAD6CC',
  borderStrong: '#78837F',
  focus: '#1660C4',

  success: '#1C6B44',
  warning: '#7A5500',
  danger: '#A83224',
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
