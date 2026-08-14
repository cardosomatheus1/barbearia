import { z } from 'zod';
import { EVENTOS_DE_WEBHOOK } from '@barbearia/core';

/**
 * Entrada dos webhooks (bloco 79).
 *
 * O evento sai do **catálogo do domínio**, e não de uma lista escrita aqui: a
 * borda que repetisse os nomes seria a que fica para trás quando um evento novo
 * entrar.
 */
export const novoEndpointSchema = z.object({
  nome: z.string().trim().min(2).max(80),
  url: z.string().trim().url().max(500),
  eventos: z.array(z.enum(EVENTOS_DE_WEBHOOK)).min(1),
});
