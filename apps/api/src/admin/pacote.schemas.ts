import { z } from 'zod';

/**
 * A borda dos pacotes (bloco 42).
 *
 * Os limites repetem os `CHECK` da migração 0045, e a repetição é deliberada:
 * o banco é a garantia, a borda é a mensagem. Sem ela, digitar um pacote de uma
 * unidade devolveria erro de constraint em vez de "pacote começa em dois".
 */
export const pacoteDoCatalogoSchema = z.object({
  nome: z.string().trim().min(2).max(80),
  serviceId: z.string().uuid(),
  /**
   * Dois é o piso, e é regra do produto: "1 corte por R$ 50" é um corte, não um
   * pacote — ele viraria um item de catálogo paralelo ao serviço, com preço
   * próprio e sem aparecer na agenda.
   */
  quantidade: z.number().int().min(2).max(100),
  precoCents: z.number().int().positive().max(10_000_000),
  /** Nulo é "não vence", e é escolha legítima da barbearia. */
  validadeDias: z.number().int().min(7).max(3650).nullable(),
  transferivel: z.boolean(),
  ativo: z.boolean(),
});
