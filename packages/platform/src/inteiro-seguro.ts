/** Converte bigint/number do banco sem arredondar inteiro silenciosamente no JavaScript. */
export function inteiroSeguroDoBanco(
  valor: bigint | number | null | undefined,
  contexto = 'agregado inteiro',
): number {
  const numero = typeof valor === 'bigint' ? Number(valor) : (valor ?? 0);
  if (!Number.isSafeInteger(numero)) {
    throw new Error(`${contexto} ultrapassou o intervalo inteiro seguro do JavaScript.`);
  }
  return numero;
}
