import { z } from 'zod';
import { ORDENS_DA_BUSCA, RAIO_MAXIMO_KM, RAIO_PADRAO_KM } from '@barbearia/core';

/**
 * O que a busca do marketplace aceita (bloco 70, SPEC §5.2).
 *
 * Coordenada é validada na borda porque ela vem do **aparelho**, e este produto
 * não confia em nada que venha de lá — é a mesma regra que faz o fuso vir da
 * unidade. Latitude fora de −90..90 não é um usuário curioso, é uma consulta que
 * varreria a tabela inteira sem casar com nada.
 *
 * O raio tem teto no schema **e** no domínio: aqui para recusar cedo com motivo
 * legível, lá porque quem apara é quem calcula a caixa de coordenadas.
 */
export const buscaNaVitrineSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  raioKm: z.coerce.number().positive().max(RAIO_MAXIMO_KM).default(RAIO_PADRAO_KM),
  ordem: z.enum(ORDENS_DA_BUSCA).default('distancia'),
  notaMinimaBps: z.coerce.number().int().min(100).max(500).optional(),
  precoMaximoCents: z.coerce.number().int().positive().max(1_000_000).optional(),
  /**
   * Comodidade é lista fechada desde o bloco 7, e a borda não a reabre.
   *
   * O comentário daquela migração já dizia que texto livre "impossibilitaria
   * filtro no marketplace" — este é o filtro, e ele casa contra o que o cadastro
   * grava. Um valor inventado aqui não quebra nada: ele simplesmente não casa, e
   * a busca devolve vazio em vez de erro.
   */
  comodidades: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .pipe(z.array(z.string().max(40)).max(8))
    .optional(),
  clube: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .transform((v) => v === true || v === 'true')
    .optional(),
});
