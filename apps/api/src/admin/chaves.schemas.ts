import { z } from 'zod';

/** Entrada das chaves de API (bloco 78). */
export const novaChaveSchema = z.object({
  nome: z.string().trim().min(2).max(80),
  escopos: z.array(z.string().min(1).max(60)).min(1).max(40),
});

export const revogacaoDaChaveSchema = z.object({
  motivo: z.string().trim().min(5).max(500),
});
