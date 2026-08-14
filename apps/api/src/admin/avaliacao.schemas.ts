import { z } from 'zod';
import { DESFECHOS_DA_RECUPERACAO, MAXIMO_DA_RESOLUCAO, MOTIVOS_DA_CONTESTACAO } from '@barbearia/core';

/**
 * A borda da recuperação (bloco 43).
 *
 * O piso de dez caracteres repete o `CHECK` da migração 0046, e a repetição é
 * deliberada: o banco é a garantia, a borda é a mensagem. "Resolvido" sozinho
 * não é registro de nada — seis meses depois ninguém sabe se ligaram, se
 * refizeram o corte ou se desistiram. É a mesma exigência do motivo escrito no
 * override de confiabilidade e no ajuste de saldo.
 */
export const recuperacaoSchema = z.object({
  desfecho: z.enum(DESFECHOS_DA_RECUPERACAO),
  nota: z.string().trim().min(10).max(MAXIMO_DA_RESOLUCAO),
});

/**
 * A borda da contestação (bloco 80).
 *
 * O motivo vem de `z.enum` sobre o catálogo do domínio, e não de uma lista
 * escrita aqui: um motivo novo nasce aceito na borda sem ninguém lembrar dela,
 * e um motivo inventado pelo cliente da API morre antes de chegar ao banco. O
 * `CHECK` da migração 0077 e o `ehMotivoDaContestacao` do domínio são as outras
 * duas camadas — a mesma justificativa escrita três vezes de propósito.
 */
export const contestacaoSchema = z.object({
  motivo: z.enum(MOTIVOS_DA_CONTESTACAO),
  nota: z.string().trim().min(10).max(MAXIMO_DA_RESOLUCAO),
});
