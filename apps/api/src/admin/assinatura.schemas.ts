import { z } from 'zod';

/**
 * A borda do clube (bloco 45).
 *
 * Os limites repetem os `CHECK` da migração 0048: o banco é a garantia, a borda
 * é a mensagem.
 */
export const planoSchema = z.object({
  nome: z.string().trim().min(2).max(80),
  descricao: z.string().trim().max(300).nullable().optional(),
  precoCents: z.number().int().positive().max(1_000_000),
  // 5000 = 50%. Acima disso a casa paga para vender, e costuma ser um zero a mais.
  descontoEmProdutoBps: z.number().int().min(0).max(5000),
  ativo: z.boolean(),
  beneficios: z
    .array(
      z.object({
        serviceId: z.string().uuid(),
        /** Nulo é ilimitado, e não um número grande — um `9999` é cota disfarçada. */
        quantidade: z.number().int().positive().max(100).nullable(),
        cooldownDias: z.number().int().min(0).max(90),
      }),
    )
    .max(10),
});

export const assinarSchema = z.object({
  customerId: z.string().uuid(),
  planId: z.string().uuid(),
});

export const cancelarSchema = z.object({
  motivo: z.string().trim().min(3).max(300),
});
