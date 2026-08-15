import { z } from 'zod';
import { GATILHOS, JANELA_MAXIMA_DIAS, OBJETIVOS, TIPOS_DE_CAMPANHA } from '@barbearia/core';

/**
 * A borda da automação (bloco 56).
 *
 * Os limites repetem os `CHECK` da migração 0059: o banco é a garantia, a borda
 * é a mensagem. Sem ela, uma janela de dois anos devolveria erro de constraint
 * em vez de "a janela vai de 1 a 90 dias".
 */
export const automacaoSchema = z.object({
  id: z.string().uuid().optional(),
  nome: z.string().trim().min(1).max(80),
  gatilho: z.enum(GATILHOS),
  /**
   * Nulo é legítimo: metade dos gatilhos não pede número. Quais pedem é decisão
   * de domínio, e ela mora em `validarAutomacao` — repeti-la aqui criaria duas
   * listas para a mesma regra.
   */
  limiar: z.number().int().positive().nullable(),
  atrasoMinutos: z.number().int().min(0).max(10_080),
  /**
   * A mesma lista fechada da campanha, e pela mesma razão.
   *
   * Com os seis tipos, a automação escolhia `lembrete_24h` — transacional, que
   * ignora o opt-out de marketing — e disparava sozinha para quem revogou o
   * consentimento. E `senha_de_acesso` é credencial.
   */
  tipo: z.enum(TIPOS_DE_CAMPANHA),
  objetivo: z.enum(OBJETIVOS),
  janelaDias: z.number().int().min(1).max(JANELA_MAXIMA_DIAS),
  ativa: z.boolean(),
});
