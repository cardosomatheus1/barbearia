import { z } from 'zod';
import { MAXIMO_DA_RESPOSTA, MAXIMO_DO_RECADO, TIPOS_DE_RECADO } from '@barbearia/core';

/**
 * A borda do canal de recados (bloco 40).
 *
 * O tipo sai de `packages/core` e não de uma lista repetida aqui: uma cópia
 * divergiria no dia em que alguém acrescentasse um quarto tipo, e a borda
 * passaria a recusar o que o domínio aceita — com erro de banco no lugar de
 * erro de formulário.
 *
 * `nome` e `telefone` são **opcionais**, e é a decisão do bloco: o recado
 * anônimo existe, e é o de quem desistiu da fila e foi embora.
 */
export const recadoPublicoSchema = z.object({
  tipo: z.enum(TIPOS_DE_RECADO),
  texto: z.string().trim().min(10).max(MAXIMO_DO_RECADO),
  nome: z.string().trim().min(3).max(80).optional(),
  telefone: z.string().min(8).max(24).optional(),
  /**
   * O atendimento a que o recado se refere, quando existe um.
   *
   * Só vale para quem tem sessão, e o domínio confere o dono: sem isso, alguém
   * amarraria a própria reclamação ao atendimento de terceiro.
   */
  appointmentId: z.string().uuid().optional(),
});

export type RecadoPublico = z.infer<typeof recadoPublicoSchema>;

export const respostaAoRecadoSchema = z.object({
  resposta: z.string().trim().min(1).max(MAXIMO_DA_RESPOSTA),
});

export const filaDeRecadosSchema = z.object({
  incluirEncerrados: z.enum(['0', '1']).optional(),
});
