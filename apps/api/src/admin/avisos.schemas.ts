import { z } from 'zod';

/**
 * Preferências de aviso.
 *
 * O piso e o teto de `diasParaRetorno` acompanham a CHECK da migração 0020, e
 * não são estética: sete dias é o menor intervalo que ainda parece lembrete, e
 * abaixo disso a mensagem vira perseguição a quem cortou o cabelo anteontem.
 */
export const preferenciasDeAvisoSchema = z.object({
  confirmacao: z.boolean(),
  lembrete24h: z.boolean(),
  lembrete2h: z.boolean(),
  retorno: z.boolean(),
  diasParaRetorno: z.number().int().min(7).max(365),
});
