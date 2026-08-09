import {
  createParamDecorator,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  resolveStaffSession,
  StaffError,
  type AuthenticatedStaff,
} from '@barbearia/identity';
import { DomainError } from '../common/errors.js';

export interface StaffRequest extends Request {
  staff?: AuthenticatedStaff;
  /**
   * Lido pelo log estruturado (`common/log.interceptor.ts`).
   *
   * Fica na requisição, e não só em `staff`, porque a `CustomerGuard` preenche
   * o mesmo campo pelo outro caminho: quem lê o log não precisa saber por qual
   * porta a pessoa entrou para descobrir de que barbearia era o incidente.
   */
  tenantId?: string;
}

const unauthorized = (): DomainError => new DomainError('unauthorized', 401, 'Sessão inválida');

/**
 * Exige sessão de gestor.
 *
 * Diferente do `CustomerGuard`: não há slug na rota. O tenant vem **do token**,
 * que o carrega no prefixo — o gestor administra a própria barbearia e nada
 * mais, então deixá-lo escolher o tenant pela URL só abriria caminho para
 * tentar o do vizinho.
 */
@Injectable()
export class StaffGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<StaffRequest>();

    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    if (!token) throw unauthorized();

    try {
      request.staff = await resolveStaffSession(token);
      request.tenantId = request.staff.tenantId;
    } catch (error) {
      // Só sessão inválida vira 401; queda de banco precisa virar 500 e ser
      // registrada, senão uma indisponibilidade parece "expirou para todo
      // mundo" e ninguém é avisado.
      if (error instanceof StaffError) throw unauthorized();
      throw error;
    }

    return true;
  }
}

export const Staff = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedStaff => {
    const request = context.switchToHttp().getRequest<StaffRequest>();
    if (!request.staff) throw unauthorized();
    return request.staff;
  },
);
