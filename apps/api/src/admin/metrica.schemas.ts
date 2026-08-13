import { z } from 'zod';
import { DIMENSOES } from '@barbearia/core';

/**
 * A pergunta, validada na borda **antes** do domínio (bloco 63).
 *
 * A forma é conferida aqui; o **significado** — a métrica existe, aceita esta
 * dimensão, e quem pergunta pode vê-la — é conferido em `validarPergunta`, no
 * domínio. Duas camadas, e a de baixo não confia na de cima.
 *
 * A métrica entra como `string` de propósito: recusá-la aqui devolveria a mesma
 * mensagem de um período mal escrito, e o domínio tem uma frase própria para
 * "esta pergunta não está entre as que o produto sabe responder".
 */
export const perguntaSchema = z.object({
  metrica: z.string().min(1).max(64),
  dimensao: z.enum(DIMENSOES),
  de: z.string().min(1).max(10),
  ate: z.string().min(1).max(10),
});

/**
 * O texto da pergunta em português (bloco 64).
 *
 * Teto de 200 caracteres: uma pergunta do balcão não passa disso, e o que passa
 * é colagem — que não vira nada útil e só dá trabalho ao tradutor. O texto **não**
 * é sanitizado aqui de propósito: ele não chega perto de SQL nem de HTML, e o
 * que sai do tradutor é uma chave de união fechada.
 */
export const conversaSchema = z.object({
  texto: z.string().min(1).max(200),
});
