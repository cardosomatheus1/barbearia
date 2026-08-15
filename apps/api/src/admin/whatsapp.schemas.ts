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

/**
 * O que a janela da Meta devolve ao navegador (bloco 83).
 *
 * O `code` vale uma vez e é trocado no servidor pelo token — o `appSecret`
 * nunca chega ao navegador, então não há como o cliente fazer a troca sozinho.
 *
 * Os dois ids têm o mesmo formato que `salvarCadastroDoWhatsApp` exige, e a
 * conferência é repetida lá dentro de propósito: a borda garante forma, e o
 * domínio é quem responde por gravar.
 */
export const signupDoWhatsAppSchema = z.object({
  code: z.string().trim().min(1).max(512),
  /**
   * Opcionais desde o bloco 84, e é o conserto do celular.
   *
   * Eles chegavam do evento `message` da janela da Meta — que no computador
   * roda numa janela filha e no celular numa **aba separada**, onde a mensagem
   * não volta. Exigi-los aqui fazia a conexão morrer calada no aparelho em que
   * a barbearia realmente opera.
   *
   * Ausentes, o servidor os descobre pelo token. O formato continua conferido:
   * o que chega vira dica, e dica malformada é recusada como qualquer entrada.
   */
  wabaId: z.string().regex(/^[0-9]{5,32}$/).optional(),
  phoneNumberId: z.string().regex(/^[0-9]{5,32}$/).optional(),
  numeroVisivel: z.string().trim().max(32).nullable().optional(),
});
