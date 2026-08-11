import { z } from 'zod';
import { MINIMO_DE_MOTIVO } from '@barbearia/crm';

/**
 * A borda do sinal (bloco 37).
 *
 * O valor recebido entra em centavos inteiros e é conferido contra o exigido
 * pelo domínio — o schema aqui só garante que ele é um inteiro plausível. O
 * teto é o mesmo do resto do dinheiro deste produto: cem mil reais num sinal de
 * barbearia é erro de digitação, não operação.
 */
export const sinalRecebidoSchema = z.object({
  valorCents: z.number().int().positive().max(10_000_000),
});

/**
 * O override do score.
 *
 * `score` nulo devolve o cliente à fórmula, e o motivo continua obrigatório:
 * tirar alguém do override é uma decisão sobre dinheiro tanto quanto colocá-lo
 * — quem estava dispensado do sinal volta a pagá-lo.
 *
 * O piso do motivo é o mesmo do domínio e da CHECK do banco. Três lugares, e é
 * de propósito: a borda devolve erro legível, o domínio vale para quem chamar
 * de outro caminho, e a CHECK vale para o SQL escrito à mão.
 */
export const confiancaSchema = z.object({
  score: z.number().int().min(0).max(100).nullable(),
  motivo: z.string().trim().min(MINIMO_DE_MOTIVO).max(300),
});

/**
 * A barbearia liga ou desliga a exigência de segundo fator no financeiro.
 *
 * Um booleano e nada mais: a tela manda o estado desejado, nunca "alterne".
 * Alternar depende de saber o estado atual, e com duas abas abertas as duas
 * mandariam a mesma alternância sobre leituras diferentes — a segunda desfaria
 * a primeira sem ninguém pedir.
 */
export const politicaDeMfaSchema = z.object({
  exigir: z.boolean(),
});
