import { z } from 'zod';
import { FINALIDADES } from '@barbearia/crm';

/**
 * A borda dos direitos do titular (bloco 31).
 *
 * A versão do texto tem piso de um caractere e **não tem padrão**: consentimento
 * sem dizer o que a pessoa leu não é comprovável, e um padrão silencioso do tipo
 * `'v1'` seria pior que a ausência — daria aparência de prova.
 */
export const consentimentoSchema = z.object({
  finalidade: z.enum(FINALIDADES as unknown as [string, ...string[]]),
  concedido: z.boolean(),
  versaoDoTexto: z.string().trim().min(1).max(80),
});

export const pedidoSchema = z.object({
  tipo: z.enum(['export', 'deletion']),
});

/**
 * Encerrar o pedido.
 *
 * O motivo é opcional no schema e obrigatório no domínio quando a resposta é
 * recusa — a borda não sabe qual dos dois é, e checar aqui duplicaria a regra
 * num lugar que não é o dono dela.
 */
export const encerramentoSchema = z.object({
  atendido: z.boolean(),
  nota: z.string().trim().max(500).optional(),
});
