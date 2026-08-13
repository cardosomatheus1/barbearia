import { z } from 'zod';

/**
 * A janela do relatório de crescimento, validada na borda.
 *
 * Teto nas **duas** pontas, e a segunda foi achado de revisão no bloco 41: só o
 * começo conferido deixa "de hoje até 2099" passar. Aqui isso não é só custo de
 * consulta — `serieParaTela` monta um ponto por dia, e uma janela de setenta anos
 * seria um vetor de vinte e cinco mil pontos para desenhar num SVG.
 */
/**
 * O formato **e** a data de verdade.
 *
 * Só a expressão regular deixa `0000-01-01` e `2026-02-31` passarem: os dois têm
 * a forma certa e não são dias que existem. O primeiro chega ao Postgres e
 * estoura em `${de}::date`, e entrada malformada que devolve 500 é defeito de
 * borda — sempre. O certo é 400 com o motivo, e é o que este `refine` faz.
 *
 * A conferência é ida e volta: `Date.parse` aceita 31 de fevereiro e devolve 3
 * de março, então comparar o `toISOString` com o texto original é o que pega o
 * dia que não existe.
 */
const dia = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD.')
  .refine((d) => {
    const instante = Date.parse(`${d}T00:00:00Z`);
    return !Number.isNaN(instante) && new Date(instante).toISOString().slice(0, 10) === d;
  }, 'Este dia não existe no calendário.');

export const JANELA_MAXIMA_DE_CRESCIMENTO_DIAS = 366;

export const janelaSchema = z
  .object({ de: dia, ate: dia })
  .refine((j) => j.de <= j.ate, { message: 'O começo da janela vem antes do fim.' })
  .refine(
    (j) =>
      (Date.parse(`${j.ate}T00:00:00Z`) - Date.parse(`${j.de}T00:00:00Z`)) / 86_400_000 <
      JANELA_MAXIMA_DE_CRESCIMENTO_DIAS,
    { message: 'A janela vai até um ano.' },
  );
