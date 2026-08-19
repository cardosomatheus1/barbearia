import { z } from 'zod';
import { CONVERSAS } from '@barbearia/core';
import { diaISO } from '../common/data.js';

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

/**
 * A meta de faturamento de um mês.
 *
 * `metaCents` nulo apaga — é o único jeito de dizer "sem meta". Zero seria uma
 * segunda forma de dizer o mesmo, e a CHECK do banco a recusa de propósito:
 * duas maneiras de expressar a ausência é como a tela acaba mostrando
 * "0% de R$ 0,00".
 */
export const metaSchema = z.object({
  professionalId: z.string().uuid(),
  /**
   * Data que existe, não só data com a forma certa.
   *
   * O formato sozinho aceita `2026-99-01`, que atravessa a borda inteira e só
   * morre no Postgres — virando 500 sobre uma entrada que a borda tinha
   * obrigação de recusar com 400. O `refine` fecha isso perguntando ao
   * calendário, que é quem sabe se o mês existe e quantos dias ele tem.
   */
  mes: diaISO
    .refine((valor) => {
      const [ano, mes, dia] = valor.split('-').map(Number);
      if (!ano || !mes || !dia) return false;
      const data = new Date(Date.UTC(ano, mes - 1, dia));
      return (
        data.getUTCFullYear() === ano &&
        data.getUTCMonth() === mes - 1 &&
        data.getUTCDate() === dia
      );
    }, 'data inexistente'),
  // O teto acompanha a CHECK da migração 0022: R$ 1.000.000,00.
  metaCents: z.number().int().min(1).max(100_000_000).nullable(),
});

/**
 * Uma foto antes/depois (bloco 74, SPEC §4.2).
 *
 * A URL é validada na borda com `https` porque ela vai para um `src` — e, se a
 * foto entrar no portfólio, para uma página anônima. É a mesma regra da foto da
 * vitrine, e o banco a repete numa `CHECK`.
 */
export const fotoSchema = z.object({
  tipo: z.enum(['antes', 'depois']),
  url: z.string().url().startsWith('https://').max(2048),
  appointmentId: z.string().uuid().optional(),
  professionalId: z.string().uuid().optional(),
  legenda: z.string().trim().max(120).optional(),
  /** Ausente é "não publica" — o padrão seguro para dado de pessoa. */
  noPortfolio: z.boolean().optional(),
});

export type EntradaDeFoto = z.infer<typeof fotoSchema>;

export const publicarSchema = z.object({ publicar: z.boolean() });
