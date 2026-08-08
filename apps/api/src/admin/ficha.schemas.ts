import { z } from 'zod';
import { CONVERSAS } from '@barbearia/core';

/**
 * O que o barbeiro anota sobre o cliente.
 *
 * Os tetos acompanham a CHECK da migração 0021 — e existem pela mesma razão
 * dela: anotação sem limite vira o lugar onde alguém cola o histórico inteiro,
 * e aí a tela rola antes de mostrar o que importa.
 *
 * `nullable().optional()` em todos os livres porque a tela manda o campo vazio
 * quando o barbeiro apaga: distinguir "não mandou" de "mandou vazio" faria
 * apagar uma anotação exigir uma rota diferente de escrevê-la.
 */
const campoCurto = z.string().trim().max(120).nullable().optional();

export const preferenciasSchema = z.object({
  maquinaLaterais: campoCurto,
  tipoDegrade: campoCurto,
  topo: campoCurto,
  barbaEstilo: campoCurto,
  produtosEvitar: z.string().trim().max(240).nullable().optional(),
  // O único fechado: ele muda o comportamento de quem atende e precisa ser
  // legível de relance com a mesma palavra sempre.
  conversa: z.enum(CONVERSAS),
  observacoes: z.string().trim().max(1000).nullable().optional(),
});

/**
 * O convite do barbeiro.
 *
 * Sem `role`: convidar é sempre criar um `professional`. Aceitar o papel aqui
 * transformaria "convidar o Ruan" numa forma silenciosa de criar um gerente,
 * fora da tela de equipe que exige `team.manage` para isso.
 */
export const conviteSchema = z.object({
  professionalId: z.string().uuid(),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(30).optional(),
});
