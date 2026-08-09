import { randomUUID } from 'node:crypto';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { catchError, tap, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { DomainError } from './errors.js';
import { idDaRequisicao, montarLinha } from './log.js';

/**
 * Uma linha estruturada por requisição (SPEC §5.12).
 *
 * O que ela mede é o que não dá para saber olhando o código: qual rota está
 * lenta em produção, qual está devolvendo 500, e para qual barbearia. É a base
 * dos alertas de negócio — sem a linha, "a conversão caiu" não tem número.
 *
 * ## Duas decisões
 *
 * **JSON numa linha, `stdout`.** O processo não escolhe destino: quem coleta é
 * o orquestrador. Escrever arquivo daqui seria decidir, dentro da aplicação,
 * uma coisa que muda por ambiente.
 *
 * **O identificador volta no cabeçalho.** É o número que a pessoa cola no
 * chamado. Sem ele o suporte procura no log por nome do cliente e horário — que
 * é exatamente o que o log **não** guarda, de propósito (ver `log.ts`).
 */
@Injectable()
export class LogInterceptor implements NestInterceptor {
  intercept(contexto: ExecutionContext, proximo: CallHandler): Observable<unknown> {
    const http = contexto.switchToHttp();
    const requisicao = http.getRequest<Request>();
    const resposta = http.getResponse<Response>();

    const requisicaoId = idDaRequisicao(requisicao.headers['x-request-id'], randomUUID);
    resposta.setHeader('x-request-id', requisicaoId);

    const inicio = process.hrtime.bigint();
    const escrever = (status: number, erro?: string): void => {
      const linha = montarLinha({
        metodo: requisicao.method,
        url: requisicao.originalUrl,
        status,
        duracaoMs: Number(process.hrtime.bigint() - inicio) / 1e6,
        requisicaoId,
        // Posto pelo middleware de tenant quando o slug ou o token resolve.
        // Ausente é resposta legítima: rota pública antes de resolver.
        tenantId: (requisicao as { tenantId?: string }).tenantId,
        ...(erro ? { erro } : {}),
      });
      process.stdout.write(`${JSON.stringify(linha)}\n`);
    };

    return proximo.handle().pipe(
      tap(() => escrever(resposta.statusCode)),
      catchError((erro: unknown) => {
        // O filtro de exceção ainda não rodou, então o status da resposta
        // continua sendo o de sucesso. O código do erro vem do domínio; a
        // mensagem, não — ela pode carregar dado de cliente.
        const status = erro instanceof DomainError ? erro.status : 500;
        const codigo = erro instanceof DomainError ? erro.code : 'internal_error';
        escrever(status, codigo);
        return throwError(() => erro);
      }),
    );
  }
}
