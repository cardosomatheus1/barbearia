import { z } from 'zod';
import { ISS_MAXIMO_BPS, REGIMES_FISCAIS } from '@barbearia/core';
import { diaISO } from '../common/data.js';

/**
 * A borda do fiscal (bloco 53).
 *
 * Os limites repetem os `CHECK` da migração 0056, e a repetição é deliberada:
 * o banco é a garantia, a borda é a mensagem. Sem ela, digitar 50% de ISS
 * devolveria erro de constraint em vez de "o ISS vai de 0 a 5%".
 */


export const configuracaoFiscalSchema = z.object({
  /** Aceita pontuação e normaliza no domínio: o balcão digita como no cartão CNPJ. */
  cnpj: z.string().trim().min(14).max(18),
  regime: z.enum(REGIMES_FISCAIS),
  codigoDeServico: z.string().trim().min(2).max(20),
  issBps: z.number().int().min(0).max(ISS_MAXIMO_BPS),
  municipioIbge: z.string().regex(/^\d{7}$/, 'Código IBGE tem 7 dígitos'),
  inscricaoMunicipal: z.string().trim().max(30).nullable().optional(),
  emitirAutomaticamente: z.boolean(),
});

export const cancelamentoDeNotaSchema = z.object({
  motivo: z.string().trim().min(3).max(300),
});

/** O período das notas tem teto nas duas pontas, como o do DRE. */
export const periodoDasNotasSchema = z
  .object({ de: diaISO, ate: diaISO })
  .refine((p) => p.ate >= p.de, { message: 'O fim vem antes do início.' })
  .refine(
    (p) => Date.parse(`${p.ate}T00:00:00Z`) - Date.parse(`${p.de}T00:00:00Z`) <= 400 * 86_400_000,
    { message: 'O período não passa de um ano.' },
  );

/**
 * O documento do tomador, como o balcão digita.
 *
 * Aceita pontuação e vazio: o campo é opcional na tela, e limpar é uma operação
 * legítima — o cliente pode pedir que o CPF saia do cadastro. O que a borda
 * garante é tamanho e forma; o dígito verificador é conferido no domínio, com
 * a conta que mora em `packages/core`.
 *
 * `null` e string vazia significam a mesma coisa e viram `null`: um formulário
 * HTML manda campo vazio como `""`, e tratar os dois diferente faria "apagar o
 * CPF" funcionar pela API e não pela tela.
 */
export const documentoDoTomadorSchema = z.object({
  documento: z
    .string()
    .trim()
    .max(20)
    .nullable()
    .transform((valor) => (valor && valor.length > 0 ? valor : null)),
});
