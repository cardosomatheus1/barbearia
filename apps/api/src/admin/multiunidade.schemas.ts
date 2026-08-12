import { z } from 'zod';
import { fusoConhecido } from '@barbearia/core';

export const escolherUnidadeSchema = z.object({
  unidadeId: z.string().uuid(),
});

/**
 * A lista vazia é **legítima** e significa "todas".
 *
 * Um `min(1)` aqui faria a única forma de devolver alguém ao acesso geral ser
 * um `DELETE` no banco — e o padrão permissivo é a razão de este bloco não
 * trancar a equipe inteira para fora no dia da migração.
 *
 * O teto existe porque a lista vira um `ANY(...)` no `WHERE`: cinquenta lojas é
 * mais do que qualquer rede que este produto atende, e sem limite a borda
 * aceitaria um corpo de dez mil uuid.
 */
export const unidadesDoOperadorSchema = z.object({
  unidades: z.array(z.string().uuid()).max(50),
});

export const transferenciaSchema = z.object({
  produtoId: z.string().uuid(),
  origemId: z.string().uuid(),
  destinoId: z.string().uuid(),
  quantidade: z.number().int().min(1).max(100_000),
  nota: z.string().trim().max(240).nullable().optional(),
});

/**
 * O fuso da unidade sai de `packages/core`, nunca escrito aqui.
 *
 * A tela e a borda precisam da **mesma** lista: escritas separadamente, a tela
 * ofereceria um fuso que a borda recusa, e o erro sairia como "confira os dados"
 * sobre um campo que estava certo.
 */
export const criarUnidadeSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  timezone: z.string().refine(fusoConhecido, 'fuso desconhecido'),
  cidade: z.string().trim().max(80).nullable().optional(),
});

export const unidadeAtivaSchema = z.object({
  ativa: z.boolean(),
});
