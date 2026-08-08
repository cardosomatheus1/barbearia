import { z } from 'zod';

/**
 * Entrada da importação de base, validada na borda.
 *
 * O arquivo chega como texto no corpo, não como `multipart`. É uma escolha, e
 * não preguiça: o conteúdo já é texto por definição (CSV), o `apps/web` é
 * inteiro renderizado no servidor e lê o arquivo na *server action* antes de
 * chamar a API, e um segundo formato de corpo só nesta rota traria um parser a
 * mais para manter e para auditar.
 */

/**
 * Teto do arquivo, em caracteres.
 *
 * Oito megabytes de texto são muito acima de qualquer base de barbearia — vinte
 * mil clientes cabem em menos de dois. O teto existe para que a borda recuse
 * antes de o parser começar a trabalhar, e para que a mensagem seja "arquivo
 * grande demais" em vez de um tempo de resposta que ninguém explica.
 */
export const TETO_DO_ARQUIVO = 8 * 1024 * 1024;

export const importacaoSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  conteudo: z.string().min(1).max(TETO_DO_ARQUIVO),
  /**
   * O separador, quando a pessoa discorda da detecção.
   *
   * Lista fechada em vez de "um caractere qualquer": um separador arbitrário
   * vindo do cliente muda como o arquivo inteiro é lido, e três são os que
   * existem em exportação real.
   */
  separador: z.enum([',', ';', '\t']).optional(),
});

export const importIdSchema = z.string().uuid();

/**
 * O slug legado.
 *
 * O formato é conferido de novo no domínio — este schema recusa o que nem
 * parece slug antes de abrir transação, e o domínio é quem sabe o que está
 * reservado.
 */
export const slugLegadoSchema = z.object({
  slug: z.string().trim().toLowerCase().min(2).max(60),
});
