import { z } from 'zod';
import { FORMAS_DE_PAGAMENTO, TIPOS_DE_ITEM } from '@barbearia/core';

/**
 * A borda do dinheiro.
 *
 * Nada de valor vindo do cliente sem schema, e **centavos inteiros sempre**:
 * `z.number().int()` recusa `49.90` antes que ele vire ponto flutuante em
 * qualquer lugar do sistema. É a mesma decisão do banco, na borda.
 *
 * O teto de `MAX_CENTAVOS` existe para o erro de digitação: sem ele, um zero a
 * mais numa sangria vira uma gaveta impossível que só aparece no fechamento.
 * Cem mil reais numa operação de barbearia é claramente engano.
 */

const MAX_CENTAVOS = 10_000_000;

const centavos = z.number().int().min(0).max(MAX_CENTAVOS);
const centavosPositivos = z.number().int().positive().max(MAX_CENTAVOS);

export const uuidSchema = z.string().uuid();

export const abrirCaixaSchema = z.object({
  openingCents: centavos,
});

export const movimentoSchema = z.object({
  kind: z.enum(['withdrawal', 'supply']),
  amountCents: centavosPositivos,
  // Sangria sem motivo é dinheiro que sai sem explicação — a coluna existe
  // justamente para a conversa do dia seguinte.
  reason: z.string().trim().min(3).max(200),
});

export const fecharCaixaSchema = z.object({
  countedCents: centavos,
  notes: z.string().trim().max(500).optional(),
});

export const abrirComandaSchema = z.object({
  appointmentId: uuidSchema.optional(),
  customerId: uuidSchema.optional(),
});

export const itemSchema = z.object({
  tipo: z.enum(TIPOS_DE_ITEM),
  serviceId: uuidSchema.optional(),
  descricao: z.string().trim().min(1).max(120),
  quantidade: z.number().int().positive().max(99),
  precoUnitarioCents: centavos,
  professionalId: uuidSchema.optional(),
});

export const ajusteSchema = z.object({
  desconto: z
    .object({
      tipo: z.enum(['amount', 'percent']),
      valor: z.number().int().min(0),
      motivo: z.string().trim().max(200).optional(),
    })
    .nullable()
    .optional(),
  gorjetaCents: centavos.optional(),
});

export const fecharComandaSchema = z.object({
  pagamentos: z
    .array(
      z.object({
        forma: z.enum(FORMAS_DE_PAGAMENTO),
        valorCents: centavosPositivos,
      }),
    )
    .min(1)
    .max(5),
});

export const receberFiadoSchema = z.object({
  customerId: uuidSchema,
  amountCents: centavosPositivos,
  // Fiado não paga fiado; o domínio também recusa, e aqui já nem chega.
  forma: z.enum(['cash', 'debit', 'credit', 'pix']),
});

export const diaSchema = z.object({
  // A data é só o dia; o fuso vem da unidade, nunca do aparelho (defeito D2).
  dia: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const codigoMfaSchema = z.object({
  // Aceita com ou sem hífen: o código de recuperação é lido de um papel.
  codigo: z.string().trim().min(6).max(20),
});
