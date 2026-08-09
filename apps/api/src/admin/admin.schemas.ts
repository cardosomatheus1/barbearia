import { z } from 'zod';
import { AMENITIES, PAYMENT_METHODS } from '@barbearia/onboarding';

/**
 * Entrada do painel, validada na borda.
 *
 * Os tetos existem porque estes campos vão para a página pública: nome de
 * serviço sem limite quebra o layout do cliente, e texto livre sem limite é
 * armazenamento gratuito para quem quiser abusar.
 */

const minutos = z.number().int().min(0).max(1440);

export const signUpSchema = z.object({
  name: z.string().trim().min(3).max(80),
  email: z.string().trim().email().max(160),
  // O piso combina com `MIN_PASSWORD` do domínio; aqui é só para recusar cedo.
  password: z.string().min(10).max(200),
  phone: z.string().min(8).max(24),
  businessName: z.string().trim().min(2).max(80),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(160),
  password: z.string().min(1).max(200),
});

export const businessSchema = z.object({
  name: z.string().trim().min(2).max(80),
  street: z.string().trim().max(160).optional(),
  district: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().length(2).optional(),
  postalCode: z.string().trim().max(12).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  phone: z.string().trim().max(20).optional(),
  whatsapp: z.string().trim().max(20).optional(),
  instagram: z.string().trim().max(80).optional(),
  about: z.string().trim().max(600).optional(),
  // O fuso vem da unidade, nunca do dispositivo (CLAUDE.md §2). Aqui ele é
  // escolhido explicitamente pelo dono, e é a única vez que isso acontece.
  timezone: z.string().trim().max(64).optional(),
  amenities: z.array(z.enum(AMENITIES)).max(AMENITIES.length).optional(),
});

const servicoSchema = z.object({
  key: z.string().trim().min(1).max(60),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  category: z.string().trim().min(1).max(40),
  durationMinutes: z.number().int().min(5).max(600),
  bufferAfterMinutes: z.number().int().min(0).max(120),
  priceCents: z.number().int().min(0).max(10_000_00),
  componentKeys: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
});

export const servicesSchema = z.object({
  services: z.array(servicoSchema).min(1).max(80),
});

export const professionalsSchema = z.object({
  professionals: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(80),
        bio: z.string().trim().max(300).optional(),
        phone: z.string().trim().max(20).optional(),
        schedule: z
          .array(
            z
              .object({
                weekday: z.number().int().min(0).max(6),
                startMinute: minutos,
                endMinute: minutos,
              })
              // Jornada invertida passaria pelo banco e produziria dia sem
              // horário nenhum, sem erro visível.
              .refine((d) => d.startMinute < d.endMinute, {
                message: 'início precisa ser antes do fim',
              }),
          )
          .max(21),
        serviceNames: z.array(z.string().trim().max(80)).max(80).optional(),
      }),
    )
    .min(1)
    .max(50),
});

export const paymentsSchema = z.object({
  methods: z.array(z.enum(PAYMENT_METHODS)).max(PAYMENT_METHODS.length),
});

export const changeWindowSchema = z.object({
  // O teto acompanha a CHECK do banco: 720 horas são 30 dias.
  cancelMinHours: z.number().int().min(0).max(720),
  rescheduleMinHours: z.number().int().min(0).max(720),
  maxReschedules: z.number().int().min(0).max(50),
  cancellationPolicy: z.string().trim().max(300).optional(),
  // Pontos-base inteiros, como toda alíquota do produto: 2000 é 20%. O teto do
  // schema acompanha a CHECK do banco.
  maxDiscountBps: z.number().int().min(0).max(10_000).optional(),
});

/**
 * Endereços de foto.
 *
 * A URL em si é validada pelo domínio (`imagemPublica`), que exige `https` e
 * recusa `javascript:` e `data:`. Aqui vale o formato e o teto — a string vazia
 * é aceita de propósito: é como a tela diz "tire esta foto".
 */
const enderecoDeFoto = z.string().trim().max(500);

export const photosSchema = z.object({
  coverUrl: enderecoDeFoto.optional(),
  logoUrl: enderecoDeFoto.optional(),
  professionals: z
    .array(z.object({ id: z.string().uuid(), photoUrl: enderecoDeFoto }))
    .max(50)
    .optional(),
  services: z
    .array(z.object({ id: z.string().uuid(), photoUrl: enderecoDeFoto }))
    .max(80)
    .optional(),
});
