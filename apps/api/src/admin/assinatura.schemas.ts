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
  /** Dias de antecedência a mais que o visitante (bloco 46). Zero é a da casa. */
  janelaDeAgendamentoDias: z.number().int().min(0).max(180).optional(),
  /**
   * As faixas em que o plano **não** vale (bloco 46).
   *
   * O proibido e não o permitido: a barbearia abre setenta horas e bloqueia
   * quatro. Guardar o permitido faria toda mudança de horário de funcionamento
   * exigir reescrever o plano.
   */
  bloqueios: z
    .array(
      z.object({
        diaDaSemana: z.number().int().min(0).max(6).nullable(),
        inicio: z.number().int().min(0).max(1440),
        fim: z.number().int().min(0).max(1440),
      }).refine((b) => b.inicio < b.fim, 'a faixa termina antes de começar'),
    )
    .max(21)
    .optional(),
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

export const dependenteSchema = z.object({
  customerId: z.string().uuid(),
});
