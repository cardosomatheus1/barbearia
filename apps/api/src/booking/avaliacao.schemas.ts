import { z } from 'zod';
import { MAXIMO_DO_COMENTARIO } from '@barbearia/core';

const estrela = z.number().int().min(1).max(5);

/**
 * A borda da avaliação do cliente (bloco 43).
 *
 * `customerId` **não** está aqui, e a ausência é a regra: ele vem da sessão. A
 * RLS separa barbearias e não separa clientes dentro de uma — aceito no corpo,
 * ele deixaria qualquer pessoa autenticada avaliar o corte de qualquer outra.
 *
 * As quatro categorias são opcionais, como manda a SPEC §4.10: quem só quer dar
 * as estrelas dá, e um formulário que exige cinco notas para elogiar um corte é
 * um formulário que ninguém preenche.
 */
export const novaAvaliacaoSchema = z.object({
  appointmentId: z.string().uuid(),
  nota: estrela,
  comentario: z.string().trim().max(MAXIMO_DO_COMENTARIO).optional(),
  categorias: z
    .object({
      atendimento: estrela.optional(),
      qualidade: estrela.optional(),
      pontualidade: estrela.optional(),
      ambiente: estrela.optional(),
    })
    .optional(),
});
