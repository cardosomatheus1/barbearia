import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { tap } from 'rxjs';
import type { Observable } from 'rxjs';
import { registrarAcesso } from '@barbearia/platform';
import { rotaGenerica, semConsulta } from '../common/log.js';
import type { StaffRequest } from './staff.guard.js';

/**
 * O "o que acessou" da impersonação auditada (SPEC Parte 1 §1.2).
 *
 * > O registro deve gravar quem impersonou, quando, por quanto tempo e o que
 * > acessou — e **o tenant deve poder consultar esse log**.
 *
 * "Quem", "quando" e "por quanto tempo" cabem no registro de abertura. **"O que
 * acessou" não cabe**: é uma linha por requisição, e ela precisa ir para a
 * trilha da barbearia — a que o dono lê —, não só para a nossa.
 *
 * ## As três decisões que fazem isto não virar um problema
 *
 * **Só grava sessão de suporte.** Em toda requisição normal do painel este
 * interceptador não faz nada além de ler um campo que a guarda já resolveu.
 *
 * **Grava a rota genérica e sem a consulta**, com `:id` no lugar do UUID — as
 * duas funções que o log estruturado já compõe na mesma ordem. O que o dono
 * precisa saber é "o suporte abriu fichas de cliente"; gravar **qual** ficha
 * faria a trilha de auditoria virar mais uma cópia de dado pessoal, que é o
 * oposto do que ela é.
 *
 * A primeira versão esquecia o `semConsulta` e a `/security-review` mostrou o
 * caminho inteiro: a busca de clientes é `GET /v1/admin/board/customers?q=...`,
 * e `rotaGenerica` sozinha mascara UUID e sequência de seis dígitos — nome
 * próprio e telefone com grupos curtos passavam limpos para dentro de uma
 * tabela que é append-only por `REVOKE`. Ou seja: cópia de dado pessoal que
 * nem um pedido de exclusão apaga.
 *
 * **Só grava o que deu certo.** Requisição que a guarda recusou não é acesso, e
 * inflar a trilha com tentativas barradas esconderia o que de fato foi visto.
 *
 * ## Por que a falha da gravação não derruba a requisição
 *
 * Derrubar seria pior: a leitura já aconteceu no servidor, então recusar a
 * resposta não desfaz o acesso — só esconde dele o registro **e** o resultado.
 * A falha vai para o log de erro, e a sessão de suporte continua limitada a
 * trinta minutos e a leitura.
 */
@Injectable()
export class SuporteInterceptor implements NestInterceptor {
  intercept(contexto: ExecutionContext, proximo: CallHandler): Observable<unknown> {
    const requisicao = contexto.switchToHttp().getRequest<StaffRequest>();

    return proximo.handle().pipe(
      tap(() => {
        const staff = requisicao.staff;
        if (!staff?.impersonatedBy) return;

        void registrarAcesso({
          tenantId: staff.tenantId,
          staffUserId: staff.staffUserId,
          adminId: staff.impersonatedBy,
          rota: `${requisicao.method} ${rotaGenerica(semConsulta(requisicao.originalUrl))}`,
        }).catch((erro: unknown) => {
          process.stderr.write(
            `${JSON.stringify({
              nivel: 'error',
              evento: 'trilha_de_suporte_falhou',
              erro: erro instanceof Error ? erro.message : String(erro),
            })}\n`,
          );
        });
      }),
    );
  }
}
