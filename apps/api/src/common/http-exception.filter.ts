import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from './errors.js';

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail?: unknown;
  };
}

/**
 * Único ponto de saída de erro da API.
 *
 * Erro inesperado vira 500 genérico: o detalhe vai para o log, não para o
 * cliente. Vazar mensagem de banco numa resposta é como um atacante descobre o
 * schema (CLAUDE.md §2).
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainError) {
      response.status(exception.status).json({
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.detail !== undefined ? { detail: exception.detail } : {}),
        },
      } satisfies ErrorBody);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string }).message ?? 'Requisição inválida');
      response.status(status).json({
        error: { code: status === 429 ? 'rate_limited' : 'request_failed', message },
      } satisfies ErrorBody);
      return;
    }

    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(500).json({
      error: { code: 'internal_error', message: 'Erro interno' },
    } satisfies ErrorBody);
  }
}
