import {
  createParamDecorator,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { OtpError, resolveSession, type AuthenticatedCustomer } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { TenantService } from '../tenant/tenant.service.js';
import { slugSchema } from '../booking/booking.schemas.js';

export interface AuthenticatedRequest extends Request {
  tenantId?: string;
  customer?: AuthenticatedCustomer;
}

const unauthorized = (): DomainError =>
  new DomainError('unauthorized', 401, 'Sessão inválida');

/**
 * Exige sessão de cliente válida **para a barbearia da rota**.
 *
 * Resolve o slug e o token juntos de propósito: um token emitido por uma
 * barbearia não pode valer em outra, mesmo sendo do mesmo telefone. Separar as
 * duas checagens deixaria essa brecha aberta por omissão.
 *
 * Todas as recusas devolvem a mesma resposta — distinguir "slug não existe" de
 * "token inválido" revelaria quais barbearias existem.
 */
@Injectable()
export class CustomerGuard implements CanActivate {
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const slug = slugSchema.safeParse(request.params['slug']);
    if (!slug.success) throw unauthorized();

    const tenantId = await this.tenants.resolve(slug.data);
    if (!tenantId) throw unauthorized();

    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    if (!token) throw unauthorized();

    try {
      request.customer = await resolveSession(tenantId, token);
    } catch (error) {
      // Só sessão inválida vira 401. Queda de banco precisa virar 500 e ser
      // registrada — engolir tudo faria uma indisponibilidade parecer "a sessão
      // de todo mundo expirou", sem alerta e sem rastro.
      if (error instanceof OtpError) throw unauthorized();
      throw error;
    }

    request.tenantId = tenantId;
    return true;
  }
}

/** Cliente autenticado, já resolvido pelo guard. */
export const Customer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedCustomer => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.customer) throw unauthorized();
    return request.customer;
  },
);

/** Tenant da rota, já resolvido pelo guard. */
export const TenantId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.tenantId) throw unauthorized();
    return request.tenantId;
  },
);
