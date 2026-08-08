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
 * Tema escuro — Barber Dock.
 *
 * A paleta é da marca, e a marca é um selo náutico: círculo azul-noite, campo
 * de pergaminho, âncora, corda e o poste de barbeiro listrado. Três cores, não
 * "escuro com um acento":
 *
 * | Papel | Valor | De onde vem |
 * |---|---|---|
 * | `surface` | `#071018` | o azul-noite do selo — tem matiz, não é preto |
 * | `surfaceRaised` | `#0C1822` | o mesmo casco, um degrau acima |
 * | `textPrimary` | `#F7F4EE` | a tinta branca do letreiro |
 * | `accent` | `#E1C39D` | **o campo de pergaminho do selo** |
 * | `danger` | `#E05246` | a listra do poste |
 *
 * ## Por que o pergaminho é o acento, e não o vermelho
 *
 * No selo o vermelho é um detalhe pequeno e o creme é o campo inteiro — quem
 * olha de longe vê creme sobre azul. E há uma razão de produto mais dura:
 * **vermelho já significa "cancelar", "faltou" e "erro"** em trinta telas deste
 * sistema. Um botão "Agendar" vermelho ao lado de um "Cancelar" vermelho é a
 * receita de toque errado no balcão, com cliente na frente.
 *
 * O que o vermelho faz é o que faz no selo: aparece pouco e chama atenção —
 * na tarja de seção, no traço sob a palavra do título, no que remove dinheiro.
 */
export const dark: ColorScheme = {
  surface: '#071018',
  surfaceRaised: '#0C1822',
  surfaceHover: '#142633',

  textPrimary: '#F7F4EE',
  textMuted: '#A6B0B6',
  // Tinta do casco sobre o pergaminho: é o miolo do selo, invertido.
  textOnAccent: '#0A1620',

  accent: '#E1C39D',
  accentHover: '#F2E1C8',

  border: '#1E2E3A',
  borderStrong: '#6E7C86',
  focus: '#8FC6FF',

  success: '#5FD79B',
  warning: '#E8B15E',
  danger: '#F0665A',
  textOnDanger: '#2A0705',
};

/**
 * Tema claro — o padrão do admin.
 *
 * O dono e a recepção passam o dia inteiro na tela; fundo claro cansa menos em
 * sessão longa e imprime melhor.
 *
 * O fundo é o **pergaminho do selo**, não branco: é o que costura o admin à
 * página pública sem escurecê-lo. E o acento inverte — no claro quem sustenta
 * texto branco é o azul-noite do casco, porque creme sobre branco não seria
 * botão nenhum.
 */
export const light: ColorScheme = {
  surface: '#F2ECE1',
  surfaceRaised: '#FFFFFF',
  surfaceHover: '#E6DCCB',

  textPrimary: '#0A1620',
  textMuted: '#4C5A64',
  textOnAccent: '#FFFFFF',

  accent: '#123349',
  accentHover: '#0A2436',

  border: '#DCD1BE',
  borderStrong: '#75818A',
  focus: '#1660C4',

  success: '#186B45',
  warning: '#7A5500',
  danger: '#A8241C',
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
  { foreground: 'success', background: 'surfaceRaised', kind: 'text', why: 'alta no painel' },
  { foreground: 'warning', background: 'surface', kind: 'text', why: 'aviso' },
  { foreground: 'warning', background: 'surfaceRaised', kind: 'text', why: 'severidade do diagnóstico' },
  { foreground: 'borderStrong', background: 'surface', kind: 'component', why: 'borda de campo' },
  { foreground: 'borderStrong', background: 'surfaceRaised', kind: 'component', why: 'borda em cartão' },
  { foreground: 'focus', background: 'surface', kind: 'component', why: 'anel de foco' },
  { foreground: 'focus', background: 'surfaceRaised', kind: 'component', why: 'foco em cartão' },
  { foreground: 'accent', background: 'surface', kind: 'component', why: 'ícone de destaque' },
];

/**
 * Escala de espaçamento. Base 4px — múltiplos batem com a grade de tipografia.
 *
 * De 0 a 8 é a escala de **produto**: densidade de admin e de formulário, onde
 * rolagem custa tempo de quem passa o dia na tela.
 *
 * De 9 a 11 é a escala de **página de venda**, e ela existe porque a de produto
 * não servia: a landing feita com `space-8` no lugar de respiro de seção ficou
 * apertada e sem hierarquia — o que faz uma página parecer cara é ar, e ar não
 * sai de uma escala desenhada para caber comanda em 360px. Nenhuma tela de
 * operação usa estes três.
 */
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
  '9': '5.5rem',
  '10': '7rem',
  '11': '9.5rem',
} as const;

export const radius = {
  sm: '0.375rem',
  md: '0.625rem',
  lg: '1rem',
  /** Painel grande de página de venda: cartão de 600px com raio de 16px parece caixa. */
  xl: '1.5rem',
  full: '9999px',
} as const;

/**
 * As duas letras da marca.
 *
 * `--font-oswald` e `--font-dm-sans` são publicados pelo `next/font` em
 * `apps/web/src/app/layout.tsx`, que **baixa e serve os arquivos do nosso
 * domínio**. Não é detalhe de performance: `@import` do Google Fonts, que é como
 * o mock chega, faz o navegador de cada cliente pedir a fonte a um terceiro e
 * entregar o IP dele junto — dado pessoal saindo da barbearia para fora do
 * produto, a cada visita.
 *
 * A pilha continua com alternativas do sistema depois da fonte da marca: se o
 * arquivo não chegar, o título ainda sai condensado em vez de virar outra
 * página.
 */
export const font = {
  /**
   * Título: condensada, em caixa alta.
   *
   * É o que o letreiro do selo faz — "BARBER DOCK" curvado em condensada
   * pesada. Sem ela a identidade some, porque cor sozinha não diferencia.
   */
  display:
    "var(--font-oswald), 'Oswald', 'Arial Narrow', 'Helvetica Neue Condensed', system-ui, sans-serif",
  /** Corpo: geométrica de leitura, o contraponto neutro da condensada. */
  sans: "var(--font-dm-sans), 'DM Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  /** Numerais tabulares para horário e preço: coluna que não dança ao trocar de valor. */
  numeric:
    "var(--font-dm-sans), 'DM Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
} as const;

/**
 * Escala tipográfica.
 *
 * Até `3xl` é o produto. De `4xl` para cima é o letreiro: título de seção e
 * herói de página de venda, onde a condensada da marca precisa de tamanho para
 * virar letreiro em vez de subtítulo grande.
 */
export const fontSize = {
  xs: '0.75rem',
  sm: '0.875rem',
  base: '1rem',
  lg: '1.125rem',
  xl: '1.375rem',
  '2xl': '1.75rem',
  '3xl': '2.25rem',
  '4xl': '3rem',
  '5xl': '4rem',
  '6xl': '5.5rem',
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
  /** Painel flutuando sobre a página: a sombra é o que dá a altura. */
  xl: '0 45px 130px rgb(0 0 0 / 0.55)',
} as const;

export const zIndex = {
  base: 0,
  sticky: 10,
  overlay: 100,
  modal: 200,
  toast: 300,
} as const;
