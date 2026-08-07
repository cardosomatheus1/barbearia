import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';
import { badRequest } from './errors.js';

/**
 * Validação de entrada externa na borda (CLAUDE.md §2).
 *
 * Nada entra no domínio sem passar por um schema: id, data, fuso e quantidade
 * vindos do cliente são todos hostis até prova em contrário.
 */
@Injectable()
export class ZodValidationPipe<Output, Input = unknown>
  implements PipeTransform<unknown, Output>
{
  // `Input` separado de `Output` porque schemas com `transform` mudam o tipo
  // entre a entrada crua da query string e o valor tipado do domínio.
  constructor(private readonly schema: ZodType<Output, ZodTypeDef, Input>) {}

  transform(value: unknown): Output {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const first = result.error.issues[0];
    const where = first?.path.join('.');
    throw badRequest(
      'invalid_request',
      where ? `Parâmetro inválido: ${where}` : 'Requisição inválida',
    );
  }
}
