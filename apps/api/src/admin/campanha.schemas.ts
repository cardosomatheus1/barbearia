import { z } from 'zod';
import { JANELA_MAXIMA_DIAS, TIPOS_DE_NOTIFICACAO } from '@barbearia/core';
import { FILTROS } from '@barbearia/crm';

/**
 * A borda da campanha (bloco 57).
 *
 * O que a borda garante é forma; que a célula fria precisa de dia **e** hora é
 * regra de domínio e mora em `criarCampanha` — repeti-la aqui criaria duas
 * listas para a mesma decisão.
 */
export const campanhaSchema = z.object({
  nome: z.string().trim().min(1).max(80),
  filtro: z.enum(FILTROS),
  valorDoFiltro: z.number().int().min(0).max(365).nullable(),
  diaDaSemana: z.number().int().min(0).max(6).nullable(),
  tipo: z.enum(TIPOS_DE_NOTIFICACAO),
  janelaDias: z.number().int().min(1).max(JANELA_MAXIMA_DIAS),
});
