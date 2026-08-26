import { z } from 'zod';
import { ACOES } from '@barbearia/core';
import { diaISO } from '../common/data.js';

/**
 * Entrada do balcão, validada na borda.
 *
 * Nenhum destes schemas aceita `tenantId` ou `locationId`: os dois vêm do token
 * e do estado da barbearia. Aceitá-los da requisição deixaria a recepção de uma
 * barbearia operar o dia da outra — e a RLS só protege quem passa o tenant
 * certo.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const daySchema = z.object({
  // Ausente significa "hoje na barbearia", resolvido no servidor pelo fuso da
  // unidade — nunca pelo relógio do notebook do balcão.
  date: diaISO.optional(),
  professionalId: z.string().uuid().optional(),
});

/**
 * Do catálogo, nunca reescrita — e não havia laço de compilador nenhum ligando
 * as duas: o controller anotava o corpo à mão em vez de usar `z.infer`, então a
 * saída do zod era **afirmada**, não conferida. Uma nona ação em `ACOES` levava
 * 400 em silêncio; uma que existisse só aqui não daria erro de tipo tampouco.
 *
 * O comentário de `ACOES` no `core` documenta exatamente este defeito sendo
 * consertado — para a cópia do **web**, com os mesmos oito nomes. A da API ficou.
 */

export const attendanceSchema = z.object({
  action: z.enum(ACOES as unknown as [string, ...string[]]),
});

export const searchSchema = z.object({
  q: z.string().trim().min(1).max(60),
});

export const counterRangeSchema = z.object({
  serviceIds: z
    .string()
    .transform((valor) => valor.split(',').filter(Boolean))
    .pipe(z.array(z.string().uuid()).min(1).max(10)),
  professionalId: z.string().uuid().optional(),
  dateFrom: diaISO,
  dateTo: diaISO.optional(),
});

/**
 * Marcação pelo balcão.
 *
 * Duas formas de dizer para quem: o id de um cliente que a busca achou, ou nome
 * e celular de quem ainda não tem cadastro. Uma ou outra, nunca nenhuma — sem o
 * `refine` o agendamento nasceria sem dono, e ninguém no balcão saberia de quem
 * é o horário.
 *
 * O id não autoriza nada sozinho: o controller confirma que o cliente é desta
 * barbearia antes de gravar.
 */
export const counterBookingSchema = z
  .object({
    customerId: z.string().uuid().optional(),
    name: z.string().trim().min(2).max(80).optional(),
    phone: z.string().trim().min(8).max(24).optional(),
    professionalId: z.string().uuid(),
    serviceIds: z.array(z.string().uuid()).min(1).max(10),
    date: diaISO,
    start: z.string().regex(HHMM, 'horário inválido'),
    notes: z.string().trim().max(300).optional(),
  })
  .refine((corpo) => Boolean(corpo.customerId) || Boolean(corpo.name && corpo.phone), {
    message: 'informe o cliente ou nome e celular',
  });
