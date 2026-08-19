import { z } from 'zod';
import {
  GATILHOS,
  JANELA_MAXIMA_DIAS,
  OBJETIVOS,
  SEGMENTOS,
  TIPOS_DE_CAMPANHA,
} from '@barbearia/core';

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
  /**
   * Qual texto esta automação manda (bloco 94).
   *
   * Nulo é automação anterior ao bloco, que resolve por tipo como antes — e é
   * também o que a porta de ligar e desligar manda, porque ela não mexe no
   * texto. O `COALESCE` do domínio é quem preserva a escolha ali.
   */
  templateId: z.string().uuid().nullable().optional(),
  /**
   * Para quem esta automação manda (bloco 100).
   *
   * A lista sai de `SEGMENTOS`, nunca reescrita aqui: a borda é o pior lugar
   * para uma lista paralela, porque o sintoma é a rota recusando o que o
   * produto aceita. Foi o que já aconteceu com o toggle do Super Admin.
   *
   * `null` é "todo mundo" e **ausente** é "não mexa" — a distinção que a porta
   * de ligar e desligar precisa, porque ela não manda este campo.
   */
  publico: z.enum(SEGMENTOS).nullable().optional(),
  objetivo: z.enum(OBJETIVOS),
  janelaDias: z.number().int().min(1).max(JANELA_MAXIMA_DIAS),
  ativa: z.boolean(),
});

/**
 * Ligar e desligar: `id` e `ativa`, e nada mais.
 *
 * Um schema próprio, e é o ponto. A borda do formulário confere tipo, gatilho,
 * limiar e janela — e foi assim que uma automação criada antes do bloco 88
 * deixou de poder ser desligada: o botão reenviava o objeto inteiro e a
 * validação nova barrava o tipo antigo, com a linha continuando ligada.
 *
 * O freio não pode depender de o resto da linha ainda ser válido.
 */
export const estadoDaAutomacaoSchema = z.object({
  id: z.string().uuid(),
  ativa: z.boolean(),
});
