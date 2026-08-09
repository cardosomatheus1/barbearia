import { Body, Controller, Get, HttpCode, Inject, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  revokeStaffSession,
  signUpOwner,
  StaffError,
  staffLogin,
  type AuthenticatedStaff,
} from '@barbearia/identity';
import { imagemPublica } from '@barbearia/core';
import {
  getOnboardingState,
  getPhotoTargets,
  OnboardingError,
  publish,
  saveBusiness,
  saveChangeWindow,
  getPolicies,
  savePayments,
  saveProfessionals,
  savePhotos,
  saveServices,
  templatesForOnboarding,
} from '@barbearia/onboarding';
import { DomainError, notFound } from '../common/errors.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { contaBloqueada, Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import {
  businessSchema,
  changeWindowSchema,
  loginSchema,
  paymentsSchema,
  photosSchema,
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
      const sessao = await staffLogin({
        ...body,
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
        ...(request.ip ? { ip: request.ip } : {}),
      });

      // Depois de conferir a senha, e de propósito: recusar antes diria "esta
      // barbearia está bloqueada" a quem só chutou um e-mail, o que entrega à
      // internet a lista de quem está inadimplente na plataforma.
      const bloqueio = await this.tenants.bloqueio(sessao.tenantId);
      if (bloqueio.bloqueada) throw contaBloqueada(bloqueio.motivo);

      return sessao;
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
@UseGuards(StaffGuard, PermissaoGuard)
export class OnboardingController {
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  @Exige()
  @Post('logout')
  async logout(@Staff() staff: AuthenticatedStaff) {
    await revokeStaffSession(staff.tenantId, staff.sessionId);
    return { revoked: true };
  }

  @Exige('appointments.view')
  @Get('state')
  async state(@Staff() staff: AuthenticatedStaff) {
    const estado = await getOnboardingState(staff.tenantId);
    if (!estado) throw notFound('unknown_tenant', 'Barbearia não encontrada');
    // As permissões saem daqui, resolvidas do papel na mesma consulta da
    // sessão: a tela mostra o que a API aplica, nunca uma cópia da lista
    // (CLAUDE.md). E é uma ida ao banco a menos que uma rota `/me` por página.
    return {
      ...estado,
      staff: {
        name: staff.name,
        role: staff.role,
        permissions: staff.permissions,
        // A tela do barbeiro precisa saber que ele **é** um barbeiro para se
        // desviar até ela. O recorte por profissional continua sendo decidido
        // no servidor, a partir da sessão — isto aqui só decide para onde ir.
        professionalId: staff.professionalId,
        /**
         * Sessão de suporte da plataforma (bloco 26).
         *
         * A tela precisa saber para **avisar**. As duas se parecem — mesmo
         * tema, mesmos componentes —, e um funcionário nosso que esquece em
         * qual conta está lê o número de outra barbearia como se fosse o do
         * cliente com quem está falando ao telefone.
         */
        suporte: staff.impersonatedBy !== null,
      },
    };
  }

  /** Catálogo sugerido, com duração e buffer coerentes — D4 na origem. */
  @Exige('settings.manage')
  @Get('templates')
  templates() {
    return { templates: templatesForOnboarding() };
  }

  @Exige('settings.manage')
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

  @Exige('settings.manage')
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

  @Exige('settings.manage')
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

  @Exige('settings.manage')
  @Put('payments')
  async payments(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(paymentsSchema)) body: { methods: Parameters<typeof savePayments>[1] },
  ) {
    await savePayments(staff.tenantId, body.methods);
    return { saved: true };
  }

  @Exige('settings.manage')
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

  /**
   * O que a barbearia pode ilustrar, com o que já está preenchido.
   *
   * A tela precisa da lista para montar um campo por profissional e por
   * serviço — sem ela o dono teria que descobrir os ids sozinho.
   */
  @Exige('settings.manage')
  @Get('photos')
  async photos(@Staff() staff: AuthenticatedStaff) {
    const alvos = await getPhotoTargets(staff.tenantId);
    if (!alvos) throw notFound('unknown_tenant', 'Barbearia não encontrada');
    return alvos;
  }

  /**
   * Grava os endereços de foto.
   *
   * `imagemPublica` decide o que entra: só `https`, e nunca `javascript:` ou
   * `data:`. O que não passa vira `null` em vez de erro — a foto é opcional, e
   * uma URL ruim num campo não pode impedir de salvar os outros oito. A tela
   * mostra o campo vazio de volta, que é a resposta honesta.
   *
   * Campo **ausente** é diferente de campo **vazio**: ausente não é tocado,
   * vazio apaga. Sem essa distinção, salvar a foto de um barbeiro apagaria a
   * dos outros.
   */
  @Exige('settings.manage')
  @Put('photos')
  async savePhotos(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(photosSchema))
    body: {
      coverUrl?: string;
      logoUrl?: string;
      professionals?: { id: string; photoUrl: string }[];
      services?: { id: string; photoUrl: string }[];
    },
  ) {
    const resultado = await savePhotos(staff.tenantId, {
      ...(body.coverUrl !== undefined ? { coverUrl: imagemPublica(body.coverUrl) } : {}),
      ...(body.logoUrl !== undefined ? { logoUrl: imagemPublica(body.logoUrl) } : {}),
      ...(body.professionals
        ? {
            professionals: body.professionals.map((p) => ({
              id: p.id,
              photoUrl: imagemPublica(p.photoUrl),
            })),
          }
        : {}),
      ...(body.services
        ? {
            services: body.services.map((s) => ({
              id: s.id,
              photoUrl: imagemPublica(s.photoUrl),
            })),
          }
        : {}),
    });

    // A barbearia precisa saber que a URL foi recusada. Devolver o estado real
    // deixa a tela comparar com o que foi enviado sem inventar mensagem.
    return { ...resultado, photos: await getPhotoTargets(staff.tenantId) };
  }

  /**
   * As políticas da casa, preenchidas.
   *
   * Existe porque o bloco 30 acrescentou o teto de desconto, e um campo que a
   * tela não sabe ler começa vazio a cada visita — o dono muda para 30%, volta
   * na semana seguinte e vê 20% escrito, sem ter mudado nada.
   */
  @Exige('settings.manage')
  @Get('policies')
  async policies(@Staff() staff: AuthenticatedStaff) {
    const politicas = await getPolicies(staff.tenantId);
    if (!politicas) throw notFound('unknown_tenant', 'Barbearia não encontrada');
    return politicas;
  }

  @Exige('settings.manage')
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
