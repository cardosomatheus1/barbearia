import { z } from 'zod';

/**
 * Entrada do cardápio padrão da franquia (bloco 76).
 *
 * O preço é de **referência** e chega em centavos inteiros, como todo dinheiro
 * deste produto. `duracaoMinutos` tem teto porque a grade da rede é operação:
 * um item de oito horas não é padrão de barbearia, é dado digitado errado.
 */
export const itemDoPadraoSchema = z.object({
  id: z.string().uuid().optional(),
  nome: z.string().trim().min(2).max(120),
  descricao: z.string().trim().max(500).nullable().default(null),
  referenciaCents: z.number().int().min(0).max(10_000_000),
  duracaoMinutos: z.number().int().min(5).max(480),
  categoria: z.string().trim().min(1).max(80).nullable().default(null),
  posicao: z.number().int().min(0).max(999).default(0),
});

export const adocaoSchema = z.object({
  itemId: z.string().uuid(),
});
