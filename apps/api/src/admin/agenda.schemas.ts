import { z } from 'zod';
import { TIPOS_DE_EXCECAO } from '@barbearia/core';
import { diaISO } from '../common/data.js';

/**
 * Entrada da agenda do admin, validada na borda.
 *
 * Nenhum campo aceita fuso: as datas são **locais da unidade** e a conversão
 * acontece no servidor, com o fuso que a unidade declarou. Aceitar deslocamento
 * do cliente é o defeito D2 — o mesmo que fazia o concorrente mostrar a grade
 * torta para quem estava viajando.
 */

const dataLocal = diaISO;

export const agendaQuerySchema = z.object({
  /**
   * Ausente significa **hoje na barbearia**.
   *
   * O padrão não pode vir do cliente: o "hoje" do navegador é o do dispositivo,
   * e é exatamente o defeito D2. Quem resolve é o servidor, com o fuso da
   * unidade — e assim a tela abre com uma consulta, não com uma sonda para
   * descobrir a data e outra para buscar o dia.
   */
  from: dataLocal.optional(),
  to: dataLocal.optional(),
  /** Filtro da tela. O recorte de permissão é outra coisa e vem do token. */
  professionalId: z.string().uuid().optional(),
});

/** Minuto local desde a meia-noite; 1440 é o fim do dia, não o começo do outro. */
const minuto = z.number().int().min(0).max(1440);

export const excecaoSchema = z
  .object({
    kind: z.enum(TIPOS_DE_EXCECAO),
    date: dataLocal,
    startMinute: minuto.nullish(),
    endMinute: minuto.nullish(),
    /** Ausente significa "a barbearia toda". */
    professionalId: z.string().uuid().optional(),
    reason: z.string().trim().max(200).optional(),
    /**
     * Grava mesmo com gente marcada dentro.
     *
     * Sem isto, a primeira chamada devolve os nomes e não grava. Bloquear as
     * 14h de sexta com três clientes ali é operação legítima; fazê-lo sem ver
     * quem são não é.
     */
    confirmarConflitos: z.boolean().default(false),
  })
  .refine(
    (excecao) =>
      excecao.startMinute === null ||
      excecao.startMinute === undefined ||
      excecao.endMinute === null ||
      excecao.endMinute === undefined ||
      excecao.startMinute < excecao.endMinute,
    { message: 'A hora de fim precisa ser depois da de início.' },
  );

export const excecaoIdSchema = z.string().uuid();

/**
 * Mover um agendamento na agenda.
 *
 * É o que o "arrastar" da SPEC §2.14 faz por baixo. O alvo é sempre data,
 * hora e (opcionalmente) profissional — nunca uma duração ou um preço, que
 * continuam vindo do catálogo.
 */
export const moverSchema = z.object({
  date: dataLocal,
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:mm'),
  professionalId: z.string().uuid().optional(),
});
