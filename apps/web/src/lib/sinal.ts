import { PESO_DA_FALTA } from '@barbearia/core';

/**
 * O limiar do sinal, dito em português (bloco 37).
 *
 * O motor decide por **score**, um número de 0 a 100 que a SPEC §2.13 manda
 * nunca mostrar ao cliente. Mostrá-lo ao dono também não ajuda: ele teria que
 * explicar no balcão por que "72" cobra e "74" não, e não conseguiria — porque
 * a resposta depende de uma fórmula que não está na tela.
 *
 * Então a tela pergunta o que a barbearia de fato pensa: **de quem falta quantas
 * vezes em dez eu quero sinal?** As duas funções aqui são a tradução, e ficam
 * juntas de propósito — separadas, a que lê e a que escreve discordariam no
 * primeiro ajuste da fórmula.
 *
 * ## De onde sai a conta
 *
 * Com dez agendamentos e `f` faltas, o score é `100 − PESO_DA_FALTA × (f/10)`.
 * O motor cobra quando `score < limiar` — estritamente menor. Para que "cobrar
 * de quem faltou `n` em dez" signifique `f >= n`, o limiar precisa ficar um
 * degrau acima do score de `n−1` faltas.
 */

/** Quantos agendamentos a pergunta da tela usa como base. */
export const BASE_DE_FALTAS = 10;

const DEGRAU = PESO_DA_FALTA / BASE_DE_FALTAS;

/** Faltas em dez → o limiar de score que o motor aplica. */
export function limiarDeFaltas(faltasEmDez: number): number {
  const n = Math.min(BASE_DE_FALTAS, Math.max(1, Math.round(faltasEmDez)));
  return Math.round(100 - DEGRAU * (n - 1));
}

/** O limiar guardado → a pergunta que a tela faz. */
export function faltasDoLimiar(limiar: number): number {
  const n = (100 - limiar) / DEGRAU + 1;
  return Math.min(BASE_DE_FALTAS, Math.max(1, Math.round(n)));
}
