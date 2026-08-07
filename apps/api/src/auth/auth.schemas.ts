import { z } from 'zod';

export const requestOtpSchema = z.object({
  phone: z.string().min(8).max(24),
  // Nome vem antes do código no fluxo da SPEC (P5 -> P6) e vira o cadastro.
  name: z.string().trim().min(3).max(80).optional(),
});

export const verifyOtpSchema = z.object({
  phone: z.string().min(8).max(24),
  code: z.string().regex(/^\d{6}$/, 'código de 6 dígitos'),
});

export const createAppointmentSchema = z.object({
  // Sem sessão: nome e celular no corpo. É o fluxo do mercado — escolher,
  // informar, confirmar. Com sessão, estes campos são ignorados.
  name: z.string().trim().min(3).max(80).optional(),
  phone: z.string().min(8).max(24).optional(),
  locationId: z.string().uuid(),
  professionalId: z.string().uuid(),
  serviceIds: z.array(z.string().uuid()).min(1).max(10),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  holdId: z.string().uuid().optional(),
  // Teto explícito: campo livre sem limite vira armazenamento gratuito.
  notes: z.string().max(500).optional(),
});

export const rescheduleSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  professionalId: z.string().uuid().optional(),
});

export const cancelSchema = z.object({
  reason: z.string().max(300).optional(),
});
