import { z } from 'zod';

/**
 * A frase do cliente (bloco 65).
 *
 * Teto de 300 caracteres: uma mensagem de WhatsApp de agendamento não passa
 * disso. O texto **não** é sanitizado — ele não chega perto de SQL nem de HTML, e
 * o que sai do intérprete é um conjunto de campos tipados casados contra o
 * catálogo desta barbearia.
 */
export const conversaDoClienteSchema = z.object({
  texto: z.string().min(1).max(300),
});
