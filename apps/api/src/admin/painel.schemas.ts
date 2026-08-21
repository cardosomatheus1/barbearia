import { z } from 'zod';
import { diaISO } from '../common/data.js';

/**
 * O dia que o painel mostra.
 *
 * Opcional: sem ele vale o dia **da unidade**, resolvido no servidor. O
 * parâmetro existe para olhar ontem, não para o aparelho decidir que dia é hoje
 * — que foi o defeito D2 do sistema analisado.
 *
 * A data é conferida contra o calendário, não só contra a forma: `2026-99-01`
 * atravessaria a borda e morreria no Postgres como 500, sobre uma entrada que
 * cabia recusar com 400.
 */
export const diaSchema = z.object({
  periodo: z.enum(['dia', '7d', 'mes']).optional(),
  /**
   * A janela em dias corridos, que é a do assistente (bloco 128).
   *
   * Ela existe para o link de "conferir na tela" levar ao **mesmo número**: o
   * assistente responde sobre 1, 2, 7, 15, 30, 90 ou 365 dias, e o painel só
   * tinha Hoje / 7 dias / mês-calendário. O teto é o mesmo do assistente — um
   * ano —, e o piso é um dia: um `?dias=0` viraria janela vazia, e um negativo,
   * janela invertida que o Postgres devolve como zero linhas em silêncio.
   */
  dias: z.coerce.number().int().min(1).max(365).optional(),
  dia: diaISO
    .refine((valor) => {
      const [ano, mes, dia] = valor.split('-').map(Number);
      if (!ano || !mes || !dia) return false;
      const data = new Date(Date.UTC(ano, mes - 1, dia));
      return (
        data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia
      );
    }, 'data inexistente')
    .optional(),
});

/**
 * A página seguinte da trilha.
 *
 * O cursor é o id da última linha lida — um inteiro crescente, porque
 * `audit_log` é append-only. Validado como número inteiro positivo em texto: o
 * valor vem da própria resposta anterior, mas continua sendo entrada externa.
 */
export const trilhaSchema = z.object({
  antesDe: z.string().regex(/^\d{1,19}$/, 'cursor inválido').optional(),
});
