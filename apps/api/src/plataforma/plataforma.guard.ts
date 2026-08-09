import {
  createParamDecorator,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  PlataformaError,
  resolverSessaoDaPlataforma,
  type AdminDaPlataforma,
} from '@barbearia/platform';
import { DomainError } from '../common/errors.js';

export interface RequisicaoDaPlataforma extends Request {
  admin?: AdminDaPlataforma;
}

const semSessao = (): DomainError => new DomainError('unauthorized', 401, 'Sessão inválida');

/**
 * A porta do Super Admin.
 *
 * Separada da `StaffGuard` por completo, e não é preciosismo: as duas resolvem
 * token contra tabelas diferentes, e um bug que fizesse uma aceitar o token da
 * outra daria a um gestor de barbearia o painel de todas elas. Nenhum código é
 * compartilhado entre as duas justamente para que não exista esse caminho.
 */
@Injectable()
export class PlataformaGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requisicao = context.switchToHttp().getRequest<RequisicaoDaPlataforma>();

    const token = /^Bearer (.+)$/.exec(requisicao.headers.authorization ?? '')?.[1];
    if (!token) throw semSessao();

    try {
      requisicao.admin = await resolverSessaoDaPlataforma(token);
    } catch (erro) {
      // Só sessão inválida vira 401. Queda de banco é 500 e vai para o log —
      // senão uma indisponibilidade se disfarça de "expirou".
      if (erro instanceof PlataformaError) throw semSessao();
      throw erro;
    }

    return true;
  }
}

export const Admin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminDaPlataforma => {
    const requisicao = context.switchToHttp().getRequest<RequisicaoDaPlataforma>();
    if (!requisicao.admin) throw semSessao();
    return requisicao.admin;
  },
);
