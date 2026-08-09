import { Body, Controller, Get, Inject, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  OtpError,
  requestOtp,
  revokeSession,
  verifyOtp,
  type AuthenticatedCustomer,
  type MessagingProvider,
} from '@barbearia/identity';
import { DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { TenantService } from '../tenant/tenant.service.js';
import { slugSchema } from '../booking/booking.schemas.js';
import { Customer, CustomerGuard, TenantId } from './customer.guard.js';
import {
  consentimentoDoTitularSchema,
  pedidoDoTitularSchema,
  requestOtpSchema,
  verifyOtpSchema,
} from './auth.schemas.js';
import {
  abrirPedidoDoTitular,
  consentimentosDoCliente,
  registrarConsentimento,
} from '@barbearia/crm';
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

/**
 * Sair.
 *
 * Apagar o cookie no navegador não basta: o token continuaria aceito por quem
 * o tivesse capturado, e "Sair" num aparelho compartilhado — a situação comum
 * numa barbearia — precisa realmente encerrar a sessão.
 *
 * Rota separada porque exige a guarda: revogar sessão pede saber qual é.
 */
@Controller('v1/b/:slug/auth')
@UseGuards(CustomerGuard)
export class SessionController {
  @Post('logout')
  async logout(@TenantId() tenantId: string, @Customer() customer: AuthenticatedCustomer) {
    await revokeSession(tenantId, customer.sessionId);
    return { revoked: true };
  }

  /**
   * O que o titular decidiu, dito por ele mesmo (bloco 31).
   *
   * ## Por que aqui e não no agendamento
   *
   * Consentimento de marketing precisa ser **informado e separado** do
   * necessário para executar o serviço (SPEC §1.8, regra 1). Enfiá-lo no fluxo
   * de agendar produz o aceite que ninguém leu — a pessoa está tentando marcar
   * um horário, não decidindo sobre comunicação. Aqui ela já entrou, já se
   * identificou, e a decisão é o único assunto da tela.
   *
   * ## E por que isso é o bloco inteiro, não um detalhe
   *
   * `accepts_marketing` existia desde o bloco 20 e **nada no produto o
   * escrevia**: o importador entra com falso por regra, o agendamento não
   * pergunta, e o admin não tinha tela. A varredura de retorno — que a SPEC §1
   * chama do recurso de maior retorno — filtrava por uma coluna que era falsa
   * para todo mundo, para sempre. Campo que o motor aceita e ninguém preenche,
   * e o sintoma era silêncio.
   */
  @Get('consentimento')
  async ler(@TenantId() tenantId: string, @Customer() customer: AuthenticatedCustomer) {
    const { atuais } = await consentimentosDoCliente(tenantId, customer.customerId);
    return {
      marketing: atuais.marketing?.concedido ?? false,
      decididoEm: atuais.marketing?.decididoEm?.toISOString() ?? null,
    };
  }

  @Put('consentimento')
  async decidir(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
    @Body(new ZodValidationPipe(consentimentoDoTitularSchema))
    corpo: { marketing: boolean; versaoDoTexto: string },
    @Req() requisicao: Request,
  ) {
    const decisao = await registrarConsentimento({
      tenantId,
      customerId: customer.customerId,
      finalidade: 'marketing',
      concedido: corpo.marketing,
      versaoDoTexto: corpo.versaoDoTexto,
      // Sem `registradoPor`: foi o próprio titular. A distinção fica gravada e
      // é o que responde "quem clicou?" numa contestação.
      ip: requisicao.ip ?? null,
    });
    return { marketing: decisao.concedido, decididoEm: decisao.decididoEm.toISOString() };
  }

  /**
   * O titular pedindo uma cópia dos próprios dados (SPEC §1.8.4).
   *
   * ## Por que existe, se a recepção já registra pela ficha
   *
   * Porque o caminho da recepção depende de alguém lembrar. O pedido chega por
   * WhatsApp num sábado cheio, e o prazo de 15 dias começa a correr da conversa
   * — não de quando o balcão anotar. Um botão na tela de quem já está
   * autenticado tira a obrigação legal da memória de terceiros.
   *
   * ## O que ele **não** faz
   *
   * Não devolve os dados. Abrir o pedido é o registro de que ele chegou; a
   * resposta sai pela barbearia, que é a controladora e a única que sabe por
   * qual canal aquela pessoa quer receber. Entregar o arquivo aqui também
   * mandaria dado pessoal por uma rota que só prova posse de um celular.
   *
   * ## O tipo vem do corpo, e o pedido de exclusão **não** apaga nada aqui
   *
   * Desde o bloco 32 o titular também pede a exclusão por esta rota — era a
   * lacuna declarada. O que ela faz continua sendo registrar: quem apaga é a
   * barbearia, com `customers.anonymize`, depois de conferir se alguma
   * obrigação legal de guarda impede. Apagar direto no clique tiraria dela a
   * decisão que a lei lhe dá — e daria a qualquer pessoa com o celular do
   * titular na mão o poder de destruir o cadastro.
   */
  @Post('pedido-de-dados')
  async pedirDados(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
    @Body(new ZodValidationPipe(pedidoDoTitularSchema)) corpo: { tipo: 'export' | 'deletion' },
  ) {
    const pedido = await abrirPedidoDoTitular({
      tenantId,
      customerId: customer.customerId,
      tipo: corpo.tipo,
    });
    // Reenviar devolve o mesmo pedido, com o mesmo vencimento: o segundo toque
    // do botão não pode reiniciar a contagem do prazo.
    return { id: pedido.id, tipo: pedido.tipo, venceEm: pedido.venceEm.toISOString() };
  }
}
