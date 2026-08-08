import { z } from 'zod';

/**
 * Entrada da fila presencial, validada na borda.
 *
 * Nenhum campo aqui carrega horário: a fila é ordem de chegada, e a hora é a do
 * servidor. Aceitar `joinedAt` do cliente deixaria a recepção — ou qualquer
 * requisição — furar a fila reescrevendo a própria chegada.
 */

export const queueEntryIdSchema = z.string().uuid();

export const joinQueueSchema = z.object({
  /** Cliente já cadastrado. Quando ausente, nome e telefone criam o cadastro. */
  customerId: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(80).optional(),
  phone: z.string().trim().min(8).max(24).optional(),
  serviceIds: z.array(z.string().uuid()).min(1).max(6),
  /** Preferência de profissional. Ausente é "qualquer um". */
  professionalId: z.string().uuid().optional(),
  notes: z.string().trim().max(500).optional(),
});

/**
 * Para onde mover a entrada.
 *
 * `in_service` está fora da lista de propósito: sentar cria um agendamento e
 * precisa saber em qual cadeira, então tem rota própria. Aceitá-lo aqui
 * gravaria um estado que a constraint do banco recusa, e o erro chegaria à tela
 * como falha de banco em vez de regra.
 */
export const moveQueueSchema = z.object({
  para: z.enum(['waiting', 'called', 'done', 'gave_up']),
});

export const seatQueueSchema = z.object({
  professionalId: z.string().uuid(),
});

export const fitQuerySchema = z.object({
  serviceIds: z
    .string()
    .transform((valor) => valor.split(',').map((id) => id.trim()).filter(Boolean))
    .pipe(z.array(z.string().uuid()).min(1).max(6)),
});

/**
 * Token do link de acompanhamento.
 *
 * 32 bytes em base64url dão 43 caracteres. A faixa é estreita de propósito:
 * qualquer coisa fora dela é recusada antes de tocar o banco.
 */
export const queueTokenSchema = z
  .string()
  .trim()
  .min(20)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
