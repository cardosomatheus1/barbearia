/**
 * A regra de cancelamento em uma frase.
 *
 * Vive num só lugar porque aparece em duas telas — a página pública e o
 * comprovante — e as duas precisam dizer exatamente o mesmo que o servidor
 * aplica. Duas cópias do texto divergem na primeira vez que alguém ajusta uma
 * delas, e quem lê a página é quem sai perdendo.
 *
 * O número vem de `locations.cancel_min_hours`, não do texto livre da
 * barbearia: só a coluna é aplicada.
 */
export function regraDeCancelamento(horas: number): string {
  if (horas <= 0) return 'Dá para cancelar até a hora do atendimento.';
  return `Cancele com pelo menos ${horas === 1 ? '1 hora' : `${horas} horas`} de antecedência.`;
}
