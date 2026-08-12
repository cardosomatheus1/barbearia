import { z } from 'zod';
import { TIPOS_DE_NOTIFICACAO } from '@barbearia/core';

/**
 * A borda do WhatsApp (bloco 55).
 *
 * Os limites repetem os `CHECK` da migração 0058, e a repetição é deliberada: o
 * banco é a garantia, a borda é a mensagem. Sem ela, um nome de template com
 * espaço devolveria erro de constraint em vez de "o nome aceita só minúsculas".
 */

export const cadastroDoWhatsAppSchema = z.object({
  /** Ids da Meta: dígitos, como ela os emite. */
  phoneNumberId: z.string().trim().regex(/^\d{5,32}$/, 'Confira o identificador do número'),
  wabaId: z.string().trim().regex(/^\d{5,32}$/, 'Confira o identificador da conta'),
  numeroVisivel: z.string().trim().max(40).nullable().optional(),
  /**
   * Ausente é "não mexa", e é por isso que ele é opcional em vez de anulável.
   *
   * A tela nunca devolve o token — ela mostra "salvo" e oferece trocá-lo —,
   * então não pode reenviá-lo. Aceitar `null` aqui faria corrigir o número
   * visível apagar a credencial da barbearia inteira.
   */
  token: z.string().trim().min(20).max(500).optional(),
});

export const templateSchema = z.object({
  tipo: z.enum(TIPOS_DE_NOTIFICACAO),
  nome: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,512}$/, 'Só minúsculas, números e sublinhado'),
  corpo: z.string().trim().min(5).max(1024),
});
