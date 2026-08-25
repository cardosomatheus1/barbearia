/**
 * Converte agregados inteiros do PostgreSQL sem rebaixá-los para `int4` no SQL.
 *
 * `sum(integer)` já retorna `bigint`; o cast histórico `::int` recriava o teto
 * de 2.147.483.647 centavos (~R$ 21,47 mi). No JavaScript o teto exato é muito
 * maior (Number.MAX_SAFE_INTEGER). Se um agregado ultrapassar esse limite,
 * falhar explicitamente é melhor do que arredondar dinheiro em silêncio.
 */
export function inteiroSeguroDoBanco(
  valor: bigint | number | null | undefined,
  contexto = 'agregado monetário',
): number {
  const numero = typeof valor === 'bigint' ? Number(valor) : (valor ?? 0);
  if (!Number.isSafeInteger(numero)) {
    throw new Error(`${contexto} ultrapassou o intervalo inteiro seguro do JavaScript.`);
  }
  return numero;
}
