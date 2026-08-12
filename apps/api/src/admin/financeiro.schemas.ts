import { z } from 'zod';
import { LIMITE_MAXIMO_DE_FIADO_CENTS } from '@barbearia/core';

/**
 * A borda do financeiro (bloco 51).
 *
 * Os limites repetem os `CHECK` da migração 0054, e a repetição é deliberada:
 * o banco é a garantia, a borda é a mensagem. Sem ela, digitar um valor negativo
 * devolveria erro de constraint em vez de "confira o valor".
 */

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');
const direcao = z.enum(['pagar', 'receber']);

/** Cem mil reais numa conta de barbearia é um zero a mais. */
const valor = z.number().int().positive().max(100_000_000);

export const contaNovaSchema = z.object({
  direcao,
  descricao: z.string().trim().min(2).max(120),
  valorCents: valor,
  vencimentoEm: dia,
  categoriaId: z.string().uuid().nullable().optional(),
  contaId: z.string().uuid().nullable().optional(),
  observacao: z.string().trim().max(500).nullable().optional(),
});

export const quitacaoSchema = z.object({
  /**
   * Pode ser diferente do valor da conta, e isso é o caso comum: desconto por
   * antecipação e juros por atraso são o que o fornecedor faz.
   */
  valorPagoCents: valor,
  pagaEm: dia,
  pelaGaveta: z.boolean(),
});

export const cancelamentoDeContaSchema = z.object({
  motivo: z.string().trim().min(3).max(300),
});

export const categoriaNovaSchema = z.object({
  nome: z.string().trim().min(2).max(60),
  direcao,
});

export const contaFinanceiraNovaSchema = z.object({
  nome: z.string().trim().min(2).max(60),
  locationId: z.string().uuid().nullable().optional(),
  ehGaveta: z.boolean().optional(),
});

export const transferenciaSchema = z.object({
  deContaId: z.string().uuid(),
  paraContaId: z.string().uuid(),
  valorCents: valor,
  quandoEm: dia,
  observacao: z.string().trim().max(300).nullable().optional(),
});

export const limiteDeFiadoSchema = z.object({
  /** Zero é válido e significa "não vende fiado para esta pessoa". */
  limiteCents: z.number().int().min(0).max(LIMITE_MAXIMO_DE_FIADO_CENTS),
});

export const saldoInicialDeFiadoSchema = z.object({
  deveCents: valor,
  motivo: z.string().trim().min(3).max(300),
});

export const filtroDoFinanceiroSchema = z.object({
  direcao: direcao.optional(),
  fechadas: z.enum(['true', 'false']).optional(),
});

export const categoriaAtivaSchema = z.object({
  ativa: z.boolean(),
});
