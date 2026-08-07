import { z } from 'zod';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato esperado YYYY-MM-DD');

/** Máximo de serviços numa visita. Teto explícito evita payload abusivo. */
const MAX_SERVICES = 10;

/** Aceita `serviceIds=a&serviceIds=b` e `serviceIds=a,b`. */
const serviceIds = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : value.split(',')))
  .pipe(z.array(uuid).min(1).max(MAX_SERVICES));

export const availabilityQuerySchema = z.object({
  locationId: uuid,
  serviceIds,
  dateFrom: isoDate,
  dateTo: isoDate.optional(),
  professionalId: uuid.optional(),
  anyProfessional: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const slugSchema = z
  .string()
  .min(1)
  .max(80)
  // Slug entra em consulta e em URL: restringir o alfabeto elimina uma classe
  // inteira de entrada hostil na origem.
  .regex(/^[a-z0-9][a-z0-9-]*$/i, 'slug inválido');

/** O id do agendamento é a credencial do comprovante; precisa ser UUID de fato. */
export const appointmentIdSchema = uuid;
