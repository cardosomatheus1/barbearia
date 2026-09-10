import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ConsentimentoCadastroError, lerConsentimentoCadastro, confirmarConsentimentoCadastro } from '@barbearia/crm';
import type { AuthenticatedCustomer } from '@barbearia/identity';
import { Customer, CustomerGuard, TenantId } from './customer.guard.js';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
const schema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
function erro(e: unknown): never { if (e instanceof ConsentimentoCadastroError) throw new DomainError(e.code, e.status, e.message); throw e; }
@Controller('v1/b/:slug/auth/whatsapp-cadastro')
@UseGuards(CustomerGuard)
export class ConsentimentoCadastroController {
  @Post('consultar')
  async consultar(@TenantId() tenantId: string, @Customer() customer: AuthenticatedCustomer,
    @Body(new ZodValidationPipe(schema)) body: { token: string }) {
    try { return await lerConsentimentoCadastro({ tenantId, customerId: customer.customerId, token: body.token, agora: new Date() }); } catch (e) { return erro(e); }
  }
  @Post('confirmar')
  async confirmar(@TenantId() tenantId: string, @Customer() customer: AuthenticatedCustomer,
    @Body(new ZodValidationPipe(schema)) body: { token: string }, @Req() req: Request) {
    try { return await confirmarConsentimentoCadastro({ tenantId, customerId: customer.customerId, token: body.token, ip: req.ip ?? null, agora: new Date() }); } catch (e) { return erro(e); }
  }
}
