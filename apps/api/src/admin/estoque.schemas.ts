import { z } from 'zod';
import { TIPOS_DE_MOVIMENTO_DE_ESTOQUE, TIPOS_DE_PRODUTO } from '@barbearia/core';

const MAX_CENTAVOS = 100_000_000;

/**
 * A borda do estoque (bloco 44).
 *
 * Os limites repetem os `CHECK` da migração 0047, e a repetição é deliberada:
 * o banco é a garantia, a borda é a mensagem.
 */
export const produtoSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  tipo: z.enum(TIPOS_DE_PRODUTO),
  sku: z.string().trim().max(60).nullable().optional(),
  barcode: z.string().trim().max(60).nullable().optional(),
  categoria: z.string().trim().max(60).nullable().optional(),
  fornecedor: z.string().trim().max(120).nullable().optional(),
  custoCents: z.number().int().min(0).max(MAX_CENTAVOS),
  /**
   * Nulo em `internal`, obrigatório em `resale` — e o domínio decide qual, não
   * este schema: aceitar preço num produto interno e ignorá-lo depois é mais
   * previsível do que recusar na borda uma combinação que a tela pode mandar
   * enquanto o operador troca o tipo no formulário.
   */
  precoCents: z.number().int().min(0).max(MAX_CENTAVOS).nullable(),
  minimo: z.number().int().min(0).max(100_000),
  unidade: z.enum(['un', 'ml', 'g']),
  venceEm: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  ativo: z.boolean(),
});

export const movimentoSchema = z.object({
  produtoId: z.string().uuid(),
  /**
   * `venda` e `consumo` não entram: eles nascem do fechamento da comanda, e
   * lançá-los à mão criaria a segunda fonte do mesmo fato — o estoque baixando
   * sem venda no caixa.
   */
  tipo: z.enum(TIPOS_DE_MOVIMENTO_DE_ESTOQUE).refine(
    (t) => t !== 'venda' && t !== 'consumo',
    'venda e consumo saem da comanda, não do balcão',
  ),
  quantidade: z.number().int().refine((v) => v !== 0, 'informe um movimento'),
  // O mesmo piso do `CHECK` do banco.
  motivo: z.string().trim().min(3).max(300).optional(),
});

export const fichaSchema = z.object({
  itens: z
    .array(
      z.object({
        produtoId: z.string().uuid(),
        quantidade: z.number().int().positive().max(10_000),
      }),
    )
    .max(20),
});
