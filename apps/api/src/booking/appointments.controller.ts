import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  BookingError,
  bookingPolicy,
  cancelAppointment,
  createAppointment,
  listCustomerAppointments,
  rescheduleAppointment,
} from '@barbearia/scheduling';
import {
  OtpError,
  resolveGuestCustomer,
  resolveSession,
  type AuthenticatedCustomer,
} from '@barbearia/identity';
import { badRequest, DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Customer, CustomerGuard, TenantId } from '../auth/customer.guard.js';
import { TenantService } from '../tenant/tenant.service.js';
import {
  cancelSchema,
  createAppointmentSchema,
  rescheduleSchema,
} from '../auth/auth.schemas.js';
import { slugSchema } from './booking.schemas.js';

const BOOKING_STATUS: Record<string, number> = {
  unknown_location: 404,
  slot_not_available: 409,
  slot_taken: 409,
  appointment_not_found: 404,
  appointment_not_active: 409,
  hold_expired: 409,
};

const OTP_STATUS: Record<string, number> = {
  invalid_phone: 400,
  invalid_session: 401,
};

function toHttp(error: unknown): never {
  if (error instanceof BookingError) {
    throw new DomainError(error.code, BOOKING_STATUS[error.code] ?? 400, error.message);
  }
  if (error instanceof OtpError) {
    throw new DomainError(error.code, OTP_STATUS[error.code] ?? 400, error.message);
  }
  throw error;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string): string {
  if (!UUID.test(value)) throw badRequest('invalid_request', 'Identificador inválido');
  return value;
}

interface CreateBody {
  name?: string;
  phone?: string;
  locationId: string;
  professionalId: string;
  serviceIds: string[];
  date: string;
  start: string;
  holdId?: string;
  notes?: string;
}

/**
 * Criação de agendamento — **sessão opcional**.
 *
 * O fluxo padrão do mercado é escolher, informar nome e celular, confirmar. O
 * sistema analisado agenda exatamente assim: o payload dele leva o campo de
 * código vazio e a confirmação chega sem verificação alguma. Exigir código aqui
 * seria atrito que ninguém pratica.
 *
 * A unidade pode ligar `require_otp_for_booking` quando sofrer com reserva
 * falsa. O default acompanha o mercado.
 *
 * A fronteira fica no que vem **depois**: informar o telefone de outra pessoa
 * cria um agendamento em nome dela, mas ver histórico, cancelar e remarcar
 * continuam exigindo o código — é o mesmo limite que o concorrente traça.
 */
@Controller('v1/b/:slug/appointments')
export class CreateAppointmentController {
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  @Post()
  async create(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
    @Body(new ZodValidationPipe(createAppointmentSchema)) body: CreateBody,
    @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const tenantId = await this.tenants.resolve(slug);
    if (!tenantId) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');

    // Só teto: a chave é escopada por cliente antes de ser gravada, então uma
    // chave curta é inofensiva.
    if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > 128)) {
      throw badRequest('invalid_request', 'Idempotency-Key com tamanho inválido');
    }

    const policy = await bookingPolicy(tenantId, body.locationId);
    if (!policy) throw notFound('unknown_location', 'Unidade não encontrada');

    const customerId = await this.identify(tenantId, body, request, policy.requireOtpForBooking);

    try {
      const appointment = await createAppointment({
        tenantId,
        customerId,
        locationId: body.locationId,
        professionalId: body.professionalId,
        serviceIds: body.serviceIds,
        date: body.date,
        start: body.start,
        source: 'website',
        ...(body.holdId ? { holdId: body.holdId } : {}),
        ...(body.notes ? { notes: body.notes } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      return {
        id: appointment.id,
        startsAt: appointment.serviceStartsAt,
        endsAt: appointment.serviceEndsAt,
        professionalId: appointment.professionalId,
        status: appointment.status,
        priceCents: appointment.priceCents,
      };
    } catch (error) {
      return toHttp(error);
    }
  }

  /** Sessão quando houver; senão, nome e celular — se a unidade permitir. */
  private async identify(
    tenantId: string,
    body: CreateBody,
    request: Request,
    requireOtp: boolean,
  ): Promise<string> {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];

    if (token) {
      try {
        return (await resolveSession(tenantId, token)).customerId;
      } catch (error) {
        if (error instanceof OtpError) {
          throw new DomainError('unauthorized', 401, 'Sessão inválida');
        }
        throw error;
      }
    }

    if (requireOtp) {
      throw new DomainError(
        'otp_required',
        401,
        'Esta barbearia pede validação do número para agendar',
      );
    }

    if (!body.name || !body.phone) {
      throw badRequest('invalid_request', 'Informe nome e celular');
    }

    try {
      const guest = await resolveGuestCustomer({
        tenantId,
        name: body.name,
        phone: body.phone,
      });
      return guest.customerId;
    } catch (error) {
      return toHttp(error);
    }
  }
}

/**
 * Ver, cancelar e remarcar — **sessão obrigatória**.
 *
 * Aqui o código é indispensável: sem ele bastaria conhecer o telefone de alguém
 * para cancelar o horário dessa pessoa. É exatamente a fronteira que o
 * concorrente traça, com o fluxo "Ver/Cancelar agendamentos" pedindo o número e
 * enviando um código.
 *
 * Toda rota repassa o `customerId`: a RLS separa barbearias, não separa clientes
 * dentro de uma.
 */
@Controller('v1/b/:slug/appointments')
@UseGuards(CustomerGuard)
export class AppointmentsController {
  @Get()
  async list(@TenantId() tenantId: string, @Customer() customer: AuthenticatedCustomer) {
    const appointments = await listCustomerAppointments({
      tenantId,
      customerId: customer.customerId,
    });
    return { appointments };
  }

  @Post(':id/cancel')
  async cancel(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(cancelSchema)) body: { reason?: string },
  ) {
    try {
      await cancelAppointment({
        tenantId,
        appointmentId: requireUuid(id),
        by: 'customer',
        customerId: customer.customerId,
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return { cancelled: true };
    } catch (error) {
      return toHttp(error);
    }
  }

  @Post(':id/reschedule')
  async reschedule(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rescheduleSchema))
    body: { date: string; start: string; professionalId?: string },
  ) {
    try {
      const appointment = await rescheduleAppointment({
        tenantId,
        appointmentId: requireUuid(id),
        customerId: customer.customerId,
        date: body.date,
        start: body.start,
        ...(body.professionalId ? { professionalId: body.professionalId } : {}),
      });
      return {
        id: appointment.id,
        startsAt: appointment.serviceStartsAt,
        endsAt: appointment.serviceEndsAt,
        professionalId: appointment.professionalId,
      };
    } catch (error) {
      return toHttp(error);
    }
  }
}
