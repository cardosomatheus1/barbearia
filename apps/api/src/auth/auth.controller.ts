import { Body, Controller, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { OtpError, requestOtp, verifyOtp, type MessagingProvider } from '@barbearia/identity';
import { DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { TenantService } from '../tenant/tenant.service.js';
import { slugSchema } from '../booking/booking.schemas.js';
import { requestOtpSchema, verifyOtpSchema } from './auth.schemas.js';
import { MESSAGING_PROVIDER } from './messaging.token.js';

/** Falhas do OTP e o status HTTP correspondente. */
const OTP_STATUS: Record<string, number> = {
  invalid_phone: 400,
  resend_too_soon: 429,
  too_many_sends: 429,
  no_challenge: 401,
  code_expired: 401,
  too_many_attempts: 429,
  code_mismatch: 401,
  invalid_session: 401,
};

function toHttp(error: unknown): never {
  if (error instanceof OtpError) {
    throw new DomainError(error.code, OTP_STATUS[error.code] ?? 400, error.message);
  }
  throw error;
}

@Controller('v1/b/:slug/auth')
export class AuthController {
  constructor(
    @Inject(TenantService) private readonly tenants: TenantService,
    @Inject(MESSAGING_PROVIDER) private readonly messaging: MessagingProvider,
  ) {}

  private async resolve(slug: string): Promise<{ tenantId: string; name: string }> {
    const tenantId = await this.tenants.resolve(slug);
    if (!tenantId) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');
    return { tenantId, name: await this.tenants.nameOf(tenantId) };
  }

  @Post('otp')
  async requestCode(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
    @Body(new ZodValidationPipe(requestOtpSchema)) body: { phone: string; name?: string },
  ) {
    const { tenantId, name } = await this.resolve(slug);
    try {
      return await requestOtp(
        {
          tenantId,
          establishmentName: name,
          phone: body.phone,
          ...(body.name ? { name: body.name } : {}),
        },
        this.messaging,
      );
    } catch (error) {
      return toHttp(error);
    }
  }

  @Post('verify')
  async verify(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
    @Body(new ZodValidationPipe(verifyOtpSchema)) body: { phone: string; code: string },
    @Req() request: Request,
  ) {
    const { tenantId } = await this.resolve(slug);
    try {
      const session = await verifyOtp({
        tenantId,
        phone: body.phone,
        code: body.code,
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
        ...(request.ip ? { ip: request.ip } : {}),
      });
      return {
        token: session.token,
        expiresAt: session.expiresAt,
        customer: { id: session.customerId, name: session.customerName },
      };
    } catch (error) {
      return toHttp(error);
    }
  }
}
