/**
 * Contraste WCAG 2.1.
 *
 * Existe para que a acessibilidade seja **verificada**, não declarada. Sem isso,
 * "usamos cores acessíveis" é opinião — e a primeira mudança de paleta a quebra
 * sem ninguém notar.
 *
 * Matemática pura: nenhuma dependência, nenhum navegador.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function parseHex(value: string): Rgb {
  const match = HEX.exec(value.trim());
  if (!match) throw new RangeError(`Cor inválida: "${value}"`);

  let hex = match[1]!;
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((char) => char + char)
      .join('');
  }

  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

/** Luminância relativa (WCAG 2.1, §relative luminance). */
export function relativeLuminance(color: Rgb | string): number {
  const { r, g, b } = typeof color === 'string' ? parseHex(color) : color;

  const channel = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Razão de contraste entre duas cores. Vai de 1 (idênticas) a 21 (preto/branco). */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

export type TextSize = 'normal' | 'large';
export type WcagLevel = 'AA' | 'AAA';

/**
 * Mínimo exigido.
 *
 * Texto grande é ≥ 18.66px em negrito ou ≥ 24px normal — o padrão é mais
 * frouxo porque traço mais espesso já sustenta a legibilidade.
 */
export function requiredRatio(level: WcagLevel, size: TextSize): number {
  if (level === 'AAA') return size === 'large' ? 4.5 : 7;
  return size === 'large' ? 3 : 4.5;
}

export function meetsContrast(
  foreground: string,
  background: string,
  level: WcagLevel = 'AA',
  size: TextSize = 'normal',
): boolean {
  return contrastRatio(foreground, background) >= requiredRatio(level, size);
}

/** Contraste de componente de interface: borda de campo, ícone, foco. */
export const UI_COMPONENT_MIN_RATIO = 3;

export function meetsComponentContrast(foreground: string, background: string): boolean {
  return contrastRatio(foreground, background) >= UI_COMPONENT_MIN_RATIO;
}
