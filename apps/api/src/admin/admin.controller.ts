import { Body, Controller, Get, HttpCode, Inject, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  revokeStaffSession,
  signUpOwner,
  StaffError,
  staffLogin,
  type AuthenticatedStaff,
} from '@barbearia/identity';
import {
  getOnboardingState,
  OnboardingError,
  publish,
  saveBusiness,
  saveChangeWindow,
  savePayments,
  saveProfessionals,
  saveServices,
  templatesForOnboarding,
} from '@barbearia/onboarding';
import { DomainError, notFound } from '../common/errors.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import {
  businessSchema,
  changeWindowSchema,
  loginSchema,
  paymentsSchema,
  professionalsSchema,
  servicesSchema,
  signUpSchema,
} from './admin.schemas.js';

const STAFF_STATUS: Record<string, number> = {
  invalid_credentials: 401,
  invalid_session: 401,
  slug_taken: 409,
  invalid_phone: 400,
  weak_password: 400,
};

const ONBOARDING_STATUS: Record<string, number> = {
  unknown_tenant: 404,
  invalid_catalog: 422,
  nothing_to_publish: 409,
  slug_taken: 409,
};

function toHttp(error: unknown): never {
  if (error instanceof StaffError) {
    throw new DomainError(error.code, STAFF_STATUS[error.code] ?? 400, error.message);
  }
  if (error instanceof OnboardingError) {
    // O detalhe diz **qual** combo está errado. Sem ele a tela só conseguiria
    // dizer "dados inválidos", e o dono não saberia o que corrigir.
    throw new DomainError(
      error.code,
      ONBOARDING_STATUS[error.code] ?? 400,
      error.message,
      error.detail,
    );
  }
  throw error;
}

/**
 * Criar conta e entrar — **sem sessão**, por definição.
 *
 * As duas rotas mais atacadas do painel. O limitador global cobre a rajada; o
 * que este código garante é que a resposta não distingue conta existente de
 * inexistente, nem no código nem no tempo (ver `staffLogin`).
 */
@Controller('v1/admin')
export class StaffAuthController {
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  /**
   * Cria a conta.
   *
   * **Responde igual para e-mail livre e e-mail já cadastrado**, e nunca devolve
   * sessão. Um 409 "e-mail já existe" contra um 201 seria oráculo de quem é dono
   * de barbearia na plataforma — a lista que o HMAC em `staff_directory` existe
   * para proteger, entregue por HTTP e sem precisar de dump nenhum.
   *
   * O custo é um login logo em seguida. Quem acabou de criar entra com a senha
   * que escolheu; quem já tinha conta entra com a que já tinha. Nos dois casos a
   * tela seguinte é a mesma, e nenhuma delas conta nada sobre a outra.
   */
  @Post('signup')
  @HttpCode(202)
  async signup(
    @Body(new ZodValidationPipe(signUpSchema))
    body: { name: string; email: string; password: string; phone: string; businessName: string },
    @Req() request: Request,
  ) {
    try {
      const resultado = await signUpOwner({
        ...body,
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
        ...(request.ip ? { ip: request.ip } : {}),
      });

      if (resultado.created) {
        // O slug nasceu agora. Se alguém o consultou antes, o cache guarda a
        // ausência e a página responderia 404 por um minuto.
        this.tenants.forget(resultado.session.slug);
      }

      return { next: 'login' };
    } catch (error) {
      return toHttp(error);
    }
  }

  @Post('login')
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: { email: string; password: string },
    @Req() request: Request,
  ) {
    try {
      return await staffLogin({
        ...body,
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
        ...(request.ip ? { ip: request.ip } : {}),
      });
    } catch (error) {
      return toHttp(error);
    }
  }
}

/**
 * Onboarding e configuração — **sessão obrigatória**.
 *
 * Nenhuma rota recebe `tenantId`: ele vem do token, sempre. Aceitá-lo do corpo
 * ou da URL deixaria um gestor tentar administrar a barbearia do vizinho, e a
 * RLS só protege quem lembra de passar o tenant certo.
 */
@Controller('v1/admin')
@UseGuards(StaffGuard)
export class OnboardingController {
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  @Post('logout')
  async logout(@Staff() staff: AuthenticatedStaff) {
    await revokeStaffSession(staff.tenantId, staff.sessionId);
    return { revoked: true };
  }

  @Get('state')
  async state(@Staff() staff: AuthenticatedStaff) {
    const estado = await getOnboardingState(staff.tenantId);
    if (!estado) throw notFound('unknown_tenant', 'Barbearia não encontrada');
    return { ...estado, staff: { name: staff.name, role: staff.role } };
  }

  /** Catálogo sugerido, com duração e buffer coerentes — D4 na origem. */
  @Get('templates')
  templates() {
    return { templates: templatesForOnboarding() };
  }

  @Put('business')
  async business(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(businessSchema)) body: Record<string, unknown>,
  ) {
    try {
      return await saveBusiness({ tenantId: staff.tenantId, ...body } as Parameters<
        typeof saveBusiness
      >[0]);
    } catch (error) {
      return toHttp(error);
    }
  }

  @Put('services')
  async services(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(servicesSchema)) body: { services: Parameters<typeof saveServices>[1] },
  ) {
    try {
      return await saveServices(staff.tenantId, body.services);
    } catch (error) {
      return toHttp(error);
    }
  }

  @Put('professionals')
  async professionals(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(professionalsSchema))
    body: { professionals: Parameters<typeof saveProfessionals>[2] },
  ) {
    const estado = await getOnboardingState(staff.tenantId);
    if (!estado) throw notFound('unknown_tenant', 'Barbearia não encontrada');

    try {
      return await saveProfessionals(staff.tenantId, estado.locationId, body.professionals);
    } catch (error) {
      return toHttp(error);
    }
  }

  @Put('payments')
  async payments(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(paymentsSchema)) body: { methods: Parameters<typeof savePayments>[1] },
  ) {
    await savePayments(staff.tenantId, body.methods);
    return { saved: true };
  }

  @Post('publish')
  async publicar(@Staff() staff: AuthenticatedStaff) {
    try {
      const publicado = await publish(staff.tenantId);
      this.tenants.forget(publicado.slug);
      return publicado;
    } catch (error) {
      return toHttp(error);
    }
  }

  @Put('change-window')
  async changeWindow(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(changeWindowSchema))
    body: Parameters<typeof saveChangeWindow>[1],
  ) {
    await saveChangeWindow(staff.tenantId, body);
    return { saved: true };
  }
}
