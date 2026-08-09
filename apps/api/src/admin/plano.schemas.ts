import { z } from 'zod';

/**
 * A borda da troca de plano pelo dono (bloco 28).
 *
 * O código é chave de catálogo e não texto livre: casar com o formato aqui
 * evita que um erro de digitação chegue ao domínio como "plano inexistente" —
 * e é o mesmo schema que a plataforma já usa do lado dela, escrito de novo
 * porque as duas bordas são independentes e uma não deve afrouxar quando a
 * outra mudar.
 */
export const trocaDePlanoSchema = z.object({
  planoCode: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/, 'código de plano inválido'),
});

export type TrocaDePlano = z.infer<typeof trocaDePlanoSchema>;
