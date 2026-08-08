/**
 * Preço digitado em reais, gravado em centavos inteiros.
 *
 * "49,90" e "49.90" chegam do mesmo campo — o teclado numérico do celular
 * brasileiro dá vírgula, e o do notebook dá ponto. Converter com
 * `Number(valor) * 100` produz 4989.999999999999 para "49.90", e
 * `Math.round` esconde isso até o dia em que não esconde. Por isso os centavos
 * saem dos dígitos, nunca de multiplicação em ponto flutuante — dinheiro é
 * inteiro em todo o sistema (CLAUDE.md).
 */
export function centavosDoCampo(bruto: string): number | null {
  const limpo = bruto.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(limpo)) return null;

  const [reais = '0', centavos = ''] = limpo.split('.');
  return Number(reais) * 100 + Number(centavos.padEnd(2, '0'));
}

/** 4990 vira "49,90" — o formato que volta para o campo de edição. */
export function reaisDoCampo(centavos: number): string {
  return (centavos / 100).toFixed(2).replace('.', ',');
}
