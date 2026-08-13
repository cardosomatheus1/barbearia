import { z } from 'zod';

/**
 * A faixa de preço vinda da tela (bloco 68, SPEC §4.20).
 *
 * A borda recusa o que o banco também recusaria — mas antes, e com motivo
 * legível: `CHECK` violado devolve 500 genérico, e "erro interno" sobre um
 * horário que a pessoa digitou é o defeito de borda que este código cataloga.
 *
 * O teto de `deltaBps` aqui é o do schema (±50%), não o da marca: quem apara
 * pela política é `precoDoHorario`, e aparar na borda faria a tela mostrar um
 * número diferente do que foi salvo.
 */
export const faixaDePrecoSchema = z
  .object({
    diaDaSemana: z.number().int().min(0).max(6),
    inicioMinuto: z.number().int().min(0).max(1440),
    fimMinuto: z.number().int().min(0).max(1440),
    deltaBps: z.number().int().min(-5000).max(5000).refine((v) => v !== 0, {
      message: 'Uma faixa de 0% não muda nada.',
    }),
  })
  .refine((f) => f.inicioMinuto < f.fimMinuto, {
    message: 'O fim tem que ser depois do começo.',
  });

export const precoPorFaixaSchema = z.object({ ligado: z.boolean() });
