import { z } from 'zod';
import { serviceIds } from '../booking/booking.schemas.js';

/**
 * Entrada da API pública (bloco 78).
 *
 * As mesmas regras da borda de sempre: nada de id, data ou valor confiado do
 * cliente, e a janela tem teto nas **duas** pontas — só o começo conferido
 * deixaria "de hoje até 2099" passar, e isso nunca expira.
 */

const diaSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'data inexistente');

/**
 * A lista de serviços é a **mesma** da página pública.
 *
 * `serviceIds=a,b` e `serviceIds=a&serviceIds=b`, e o parser vem de
 * `booking.schemas.ts` em vez de ser reescrito aqui: duas noções de "como se
 * manda uma lista" divergiriam no primeiro ajuste, e a API pública passaria a
 * aceitar o que a página recusa. É a sexta lista paralela que este repositório
 * evita de propósito.
 */
export const disponibilidadePublicaSchema = z
  .object({
    locationId: z.string().uuid(),
    serviceIds,
    professionalId: z.string().uuid().optional(),
    de: diaSchema,
    ate: diaSchema.optional(),
  })
  .refine((q) => (q.ate ?? q.de) >= q.de, { message: 'o início não pode ser depois do fim' })
  .refine(
    (q) =>
      (Date.parse(`${q.ate ?? q.de}T00:00:00Z`) - Date.parse(`${q.de}T00:00:00Z`)) / 86_400_000 <=
      31,
    { message: 'a janela vai até 31 dias' },
  );

/**
 * `professionalId` obrigatório aqui, e opcional na consulta de grade.
 *
 * A grade responde "quem atende às 15h"; o agendamento precisa saber **qual
 * cadeira**. Deixá-lo opcional faria a API escolher por conta própria uma
 * pessoa que o integrador não pediu — e a escolha de barbeiro é a decisão mais
 * pessoal que um cliente de barbearia toma.
 */
export const agendamentoPublicoSchema = z.object({
  locationId: z.string().uuid(),
  serviceIds,
  professionalId: z.string().uuid(),
  date: diaSchema,
  start: z.string().regex(/^\d{2}:\d{2}$/),
  /** O cliente é identificado por telefone E.164, a chave de deduplicação daqui. */
  telefone: z.string().regex(/^\+[1-9]\d{7,14}$/),
  nome: z.string().trim().min(2).max(120),
  notes: z.string().trim().max(500).optional(),
});
