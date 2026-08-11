import { z } from 'zod';
import { MODOS_DE_FIDELIDADE } from '@barbearia/core';

/**
 * A borda do programa de fidelidade (bloco 41).
 *
 * Os limites repetem os `CHECK` da migração 0044, e a repetição é deliberada:
 * o banco é a garantia, a borda é a mensagem. Sem ela, digitar 100% de cashback
 * devolveria erro de constraint em vez de "confira os números".
 */
export const programaSchema = z.object({
  modo: z.enum(MODOS_DE_FIDELIDADE),
  pontosPorReal: z.number().int().min(1).max(100),
  valorDoPontoCents: z.number().int().min(1).max(1000),
  visitasParaPremio: z.number().int().min(2).max(100),
  // 5000 = 50%. Acima disso a casa paga para atender, e costuma ser um zero a
  // mais no formulário.
  cashbackBps: z.number().int().min(0).max(5000),
  validadeDias: z.number().int().min(30).max(3650).nullable(),
});

export const ajusteDeSaldoSchema = z.object({
  /** Com sinal: positivo credita, negativo debita. Zero não é movimento. */
  quantidade: z.number().int().refine((v) => v !== 0, 'informe um movimento'),
  // O mesmo piso do override de confiabilidade (bloco 37) e do `CHECK` do banco.
  motivo: z.string().trim().min(10).max(300),
});

export const resgateSchema = z.object({
  quantidade: z.number().int().positive(),
});
