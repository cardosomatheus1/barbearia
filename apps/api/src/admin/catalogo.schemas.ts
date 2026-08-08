import { z } from 'zod';

/**
 * Entrada do CRUD do admin, validada na borda.
 *
 * Os tetos não são decoração. Duração e preço entram no motor de grade e no
 * cálculo do que o cliente paga: sem piso e teto aqui, um zero a mais no
 * formulário vira serviço de dezesseis horas que come a agenda inteira, e um
 * negativo vira desconto que ninguém pediu.
 */

export const idSchema = z.string().uuid();

/** Dinheiro em centavos inteiros — nunca float (CLAUDE.md). */
const centavos = z.number().int().min(0).max(10_000_000);

/**
 * Doze horas de teto e cinco minutos de piso.
 *
 * O piso existe porque `duration_minutes` é o passo da grade: um serviço de um
 * minuto geraria centenas de horários por dia e a página pública ficaria
 * inutilizável no celular.
 */
const duracao = z.number().int().min(5).max(720);

const buffer = z.number().int().min(0).max(120);

export const serviceSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).nullish(),
  categoryName: z.string().trim().min(1).max(60),
  priceCents: centavos,
  durationMinutes: duracao,
  bufferBeforeMinutes: buffer,
  bufferAfterMinutes: buffer,
  bookableOnline: z.boolean(),
  /**
   * Um combo tem ao menos duas partes. Uma parte só não é combo — é o mesmo
   * serviço com outro nome, e vira exatamente o tipo de catálogo duplicado que
   * o defeito D4 descreve.
   */
  componentIds: z.array(idSchema).max(10).optional(),
});

export const activeSchema = z.object({ active: z.boolean() });

export const professionalSchema = z.object({
  name: z.string().trim().min(2).max(80),
  bio: z.string().trim().max(600).nullish(),
  kind: z.enum(['professional', 'station', 'room']),
  bookableOnline: z.boolean(),
  dailyLimit: z.number().int().min(1).max(100).nullish(),
  serviceIds: z.array(idSchema).max(200).optional(),
});

/** Minuto local desde a meia-noite; 1440 é o fim do dia, não o começo do outro. */
const minuto = z.number().int().min(0).max(1440);

const faixaSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startMinute: minuto,
    endMinute: minuto,
    breaks: z
      .array(z.object({ start: minuto, end: minuto }).refine((i) => i.start < i.end))
      .max(6)
      .default([]),
  })
  .refine((faixa) => faixa.startMinute < faixa.endMinute, {
    message: 'A hora de entrada precisa ser antes da hora de saída.',
  })
  .refine(
    (faixa) =>
      faixa.breaks.every(
        (intervalo) =>
          intervalo.start >= faixa.startMinute && intervalo.end <= faixa.endMinute,
      ),
    { message: 'O intervalo precisa estar dentro da jornada do dia.' },
  );

export const scheduleSchema = z.object({
  faixas: z.array(faixaSchema).max(28),
  /**
   * Gravar mesmo deixando agendamento fora da jornada.
   *
   * A primeira chamada devolve os conflitos e não grava; a segunda, com este
   * campo, grava. O passo intermediário existe porque encolher a terça sem ver
   * quem já estava marcado às 15h é como o horário some da tela do balcão sem
   * ninguém ter cancelado nada.
   */
  confirmarConflitos: z.boolean().default(false),
});

export const resourcesSchema = z.object({
  pools: z
    .array(
      z.object({
        resourceType: z.string().trim().min(2).max(40),
        capacity: z.number().int().min(1).max(100),
      }),
    )
    .max(30),
});

export const serviceResourcesSchema = z.object({
  requirements: z
    .array(
      z.object({
        resourceType: z.string().trim().min(2).max(40),
        quantity: z.number().int().min(1).max(20),
      }),
    )
    .max(10),
});
