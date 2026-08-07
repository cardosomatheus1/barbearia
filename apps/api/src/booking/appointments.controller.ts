import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import {
  BookingError,
  cancelAppointment,
  createAppointment,
  listCustomerAppointments,
  rescheduleAppointment,
} from '@barbearia/scheduling';
import type { AuthenticatedCustomer } from '@barbearia/identity';
import { badRequest, DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Customer, CustomerGuard, TenantId } from '../auth/customer.guard.js';
import {
  cancelSchema,
  createAppointmentSchema,
  rescheduleSchema,
} from '../auth/auth.schemas.js';

const BOOKING_STATUS: Record<string, number> = {
  unknown_location: 404,
  slot_not_available: 409,
  slot_taken: 409,
  appointment_not_found: 404,
  appointment_not_active: 409,
  hold_expired: 409,
};

function toHttp(error: unknown): never {
  if (error instanceof BookingError) {
    throw new DomainError(error.code, BOOKING_STATUS[error.code] ?? 400, error.message);
  }
  throw error;
}

const uuidSchema = { safeParse: (v: unknown) => ({ success: /^[0-9a-f-]{36}$/i.test(String(v)) }) };

/**
 * Agendamentos do cliente autenticado.
 *
 * Toda rota exige sessão e **passa o `customerId` adiante**: a RLS separa
 * barbearias, não separa clientes dentro de uma. Sem esse repasse, qualquer
 * cliente autenticado alcançaria o agendamento de qualquer outro.
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

  @Post()
  async create(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
    @Body(new ZodValidationPipe(createAppointmentSchema))
    body: {
      locationId: string;
      professionalId: string;
      serviceIds: string[];
      date: string;
      start: string;
      holdId?: string;
      notes?: string;
    },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // Só teto: a chave é escopada por cliente antes de ser gravada, então uma
    // chave curta é inofensiva — exigir tamanho mínimo rejeitaria clientes que
    // usam um contador simples, sem ganhar nada.
    if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > 128)) {
      throw badRequest('invalid_request', 'Idempotency-Key com tamanho inválido');
    }

    try {
      const appointment = await createAppointment({
        tenantId,
        customerId: customer.customerId,
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

  @Post(':id/cancel')
  async cancel(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(cancelSchema)) body: { reason?: string },
  ) {
    if (!uuidSchema.safeParse(id).success) {
      throw badRequest('invalid_request', 'Identificador inválido');
    }
    try {
      await cancelAppointment({
        tenantId,
        appointmentId: id,
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
    if (!uuidSchema.safeParse(id).success) {
      throw badRequest('invalid_request', 'Identificador inválido');
    }
    try {
      const appointment = await rescheduleAppointment({
        tenantId,
        appointmentId: id,
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
