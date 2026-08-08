import { z } from 'zod';
import { PAPEIS } from '@barbearia/core';

/**
 * Entrada da gestão de equipe, validada na borda.
 *
 * `owner` está fora do enum de propósito, e não só barrado no domínio: uma
 * lista fechada que já não aceita o valor é mais barata de auditar do que uma
 * verificação escondida três camadas abaixo.
 */
const PAPEIS_ATRIBUIVEIS = PAPEIS.filter((papel) => papel !== 'owner');

const papel = z.enum(PAPEIS_ATRIBUIVEIS as [string, ...string[]]);

export const staffIdSchema = z.string().uuid();

export const createStaffSchema = z.object({
  // Dois caracteres, não três: "Zé" e "Ana" são nomes, e o piso de três veio
  // copiado do cadastro do dono sem ninguém perguntar. Recusar o nome de
  // alguém na hora de criar a conta dela é o tipo de atrito que faz a
  // barbearia desistir e voltar a emprestar a senha.
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(160),
  role: papel,
  phone: z.string().trim().min(8).max(24).optional(),
  /** Vínculo com a agenda: o barbeiro que também tem conta é uma pessoa só. */
  professionalId: z.string().uuid().optional(),
});

export const roleSchema = z.object({ role: papel });

export const activeSchema = z.object({ active: z.boolean() });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  // O piso combina com `MIN_PASSWORD` do domínio; aqui é só para recusar cedo.
  newPassword: z.string().min(10).max(200),
});
