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

/**
 * O que o dono quer receber (bloco 33).
 *
 * Os três explícitos e sem padrão: um `optional` aqui faria o formulário com a
 * caixa desmarcada — que é como o navegador manda "desligado" — ser lido como
 * "não mexa nisso", e desligar um alerta deixaria de funcionar pela tela.
 */
export const preferenciasDeAlertaSchema = z.object({
  enviarCritico: z.boolean(),
  enviarAviso: z.boolean(),
  enviarRetencao: z.boolean(),
});
