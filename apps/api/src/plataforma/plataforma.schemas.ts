import { z } from 'zod';

/**
 * Validação na borda, como toda entrada externa (CLAUDE.md §2).
 *
 * A do Super Admin não é mais frouxa por ser interna: é a superfície que mexe
 * no estado de todas as barbearias de uma vez, e a única com esse alcance.
 */

export const loginDaPlataformaSchema = z.object({
  email: z.string().trim().email().max(320),
  senha: z.string().min(1).max(200),
});

export const tenantIdSchema = z.string().uuid();

export const trocaDePlanoSchema = z.object({
  planoCode: z
    .string()
    .trim()
    .min(1)
    .max(40)
    // O código é chave de catálogo, não texto livre: casar com o formato aqui
    // evita que um erro de digitação chegue ao banco como "plano inexistente".
    .regex(/^[a-z0-9_-]+$/, 'código de plano inválido'),
});

export const bloqueioSchema = z.object({
  /**
   * O motivo é obrigatório no schema, no domínio e no `CHECK` do banco.
   *
   * Três vezes de propósito: é ele que o suporte lê quando o dono liga, e uma
   * conta bloqueada sem motivo escrito vira discussão sem registro.
   */
  motivo: z.string().trim().min(3).max(500),
});

export const trilhaQuerySchema = z.object({
  limite: z.coerce.number().int().min(1).max(500).default(100),
});

export type TrocaDePlano = z.infer<typeof trocaDePlanoSchema>;
export type Bloqueio = z.infer<typeof bloqueioSchema>;
export type TrilhaQuery = z.infer<typeof trilhaQuerySchema>;

/**
 * A janela das métricas.
 *
 * `ate` é opcional e cai no dia anterior — o último que a apuração garante
 * completo em todos os fusos do Brasil (ver `apuracaoPendente` em
 * `@barbearia/jobs`). Aceitar hoje por padrão mostraria um dia pela metade e
 * faria toda comparação com ontem parecer queda.
 */
export const janelaSchema = z.object({
  ate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'formato esperado YYYY-MM-DD')
    // O formato sozinho aceita `0000-00-00`, que atravessa a borda e só quebra
    // lá dentro, na aritmética de data — virando 500 sobre uma entrada que era
    // do cliente. A borda é onde isso vira 400.
    .refine((valor) => !Number.isNaN(Date.parse(`${valor}T00:00:00Z`)), 'data inexistente')
    .optional(),
  dias: z.coerce.number().int().min(1).max(365).default(30),
});

export type Janela = z.infer<typeof janelaSchema>;

/** O recurso a ligar ou desligar. Fechado no tipo e conferido na borda. */
export const recursoSchema = z.object({
  code: z.enum(['fila', 'importacao', 'avisos']),
  ligado: z.boolean(),
});

export const codigoSchema = z.object({
  /** Seis dígitos do TOTP ou um código de recuperação. */
  codigo: z.string().trim().min(6).max(20),
});

export const suporteSchema = z.object({
  /**
   * Por que precisa entrar na conta de um cliente.
   *
   * Obrigatório, como o motivo do bloqueio — e pelo mesmo motivo, agravado: aqui
   * o que se acessa é a base de clientes de outra empresa, e "estava
   * investigando" sem número de chamado não é resposta que se dê a um titular
   * de dado perguntando por que olharam a ficha dele.
   */
  motivo: z.string().trim().min(3).max(500),
});

export type EntradaDeRecurso = z.infer<typeof recursoSchema>;
export type EntradaDeCodigo = z.infer<typeof codigoSchema>;
export type EntradaDeSuporte = z.infer<typeof suporteSchema>;
