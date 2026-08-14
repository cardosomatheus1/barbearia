import { z } from 'zod';

/**
 * Entrada dos indicadores da rede (bloco 77).
 *
 * O período é dia **da unidade**, não instante: é `orders.business_day` que
 * responde "de que dia é este dinheiro", e ele é uma data.
 */
const diaSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'data inexistente');

export const periodoDaRedeSchema = z
  .object({ de: diaSchema, ate: diaSchema })
  .refine((p) => p.de <= p.ate, { message: 'o início não pode ser depois do fim' })
  .refine(
    (p) =>
      (Date.parse(`${p.ate}T00:00:00Z`) - Date.parse(`${p.de}T00:00:00Z`)) / 86_400_000 <= 366,
    { message: 'a janela vai até um ano' },
  );

export const mesDaRedeSchema = z.object({ mes: diaSchema });

export const metaDaRedeSchema = z.object({
  franqueadaId: z.string().uuid(),
  mes: diaSchema,
  metaCents: z.number().int().positive().max(1_000_000_000),
});
