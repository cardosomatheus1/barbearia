import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  BookingError,
  bookingPolicy,
  cancelAppointment,
  createAppointment,
  getAppointmentReceipt,
  getAvailabilityRange,
  getReschedulableAppointment,
  listCustomerAppointments,
  MAX_RANGE_DAYS,
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
import { appointmentIdSchema, rescheduleRangeSchema, slugSchema } from './booking.schemas.js';

const BOOKING_STATUS: Record<string, number> = {
  unknown_location: 404,
  slot_not_available: 409,
  slot_taken: 409,
  appointment_not_found: 404,
  appointment_not_active: 409,
  hold_expired: 409,
  // 409, não 403: a regra é sobre o estado do agendamento no tempo, não sobre
  // quem está pedindo. O mesmo cliente podia ontem e não pode agora.
  too_late: 409,
  too_many_reschedules: 409,
  already_started: 409,
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
export class GuestAppointmentsController {
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

  /**
   * Comprovante do agendamento — **sem sessão**.
   *
   * Quem agendou como visitante não tem sessão, então exigir uma aqui deixaria
   * a própria tela de confirmação inacessível. O UUID aleatório na URL é a
   * credencial, como em qualquer link de confirmação enviado por mensagem.
   *
   * Ler é tudo que essa rota permite, e o retorno não traz dado nenhum do
   * cliente: quem receber o link encaminhado vê o horário, não a pessoa.
   * Cancelar e remarcar continuam no controller com guarda.
   */
  @Get(':id')
  async receipt(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
    @Param('id', new ZodValidationPipe(appointmentIdSchema)) id: string,
  ) {
    const tenantId = await this.tenants.resolve(slug);
    if (!tenantId) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');

    const receipt = await getAppointmentReceipt(tenantId, id);
    if (!receipt) throw notFound('appointment_not_found', 'Agendamento não encontrado');
    return receipt;
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
    @Param('id', new ZodValidationPipe(appointmentIdSchema)) id: string,
    @Body(new ZodValidationPipe(cancelSchema)) body: { reason?: string },
  ) {
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

  /**
   * Grade para remarcar **este** agendamento.
   *
   * Existe separada de `/availability` porque precisa ignorar o próprio
   * horário do cliente na ocupação. Com a estratégia `anchored` a diferença
   * não é cosmética: o horário atual ancora a grade, e a rota pública ofereceria
   * horários que a gravação — que o ignora — recusaria um por um.
   *
   * Sob a guarda, e o agendamento é buscado pelo `customerId` da sessão: o id
   * na URL não autoriza nada sozinho.
   */
  @Get(':id/availability')
  async rescheduleOptions(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
    @Param('id', new ZodValidationPipe(appointmentIdSchema)) id: string,
    @Query(new ZodValidationPipe(rescheduleRangeSchema))
    query: { dateFrom: string; dateTo?: string; professionalId?: string },
  ) {
    const atual = await getReschedulableAppointment({
      tenantId,
      customerId: customer.customerId,
      appointmentId: id,
    });
    if (!atual) throw notFound('appointment_not_found', 'Agendamento não encontrado');

    try {
      // `any` abre a agenda da equipe e colapsa em um horário por linha; um id
      // concreto filtra. Sem parâmetro, mantém quem já atende — o caso de quem
      // só quer trocar de horário.
      const equipe = query.professionalId === 'any';
      const escolhido = equipe ? undefined : (query.professionalId ?? atual.professionalId);

      const range = await getAvailabilityRange({
        tenantId,
        locationId: atual.locationId,
        // Os serviços vêm do agendamento, nunca da URL: aceitar da requisição
        // deixaria remarcar para um serviço mais caro pelo preço do antigo.
        serviceIds: atual.serviceIds,
        ...(escolhido ? { professionalId: escolhido } : {}),
        collapse: equipe,
        ignoreAppointmentId: id,
        dateFrom: query.dateFrom,
        ...(query.dateTo ? { dateTo: query.dateTo } : {}),
      });

      return {
        timezone: range.timezone,
        currentProfessionalId: atual.professionalId,
        days: range.days.map((day) => ({
          date: day.date,
          unavailableReason: day.unavailableReason,
          slots: day.slots.map((slot) => ({
            start: slot.start,
            end: slot.end,
            professionalId: slot.professionalId,
          })),
        })),
      };
    } catch (error) {
      if (error instanceof RangeError) {
        throw badRequest('invalid_range', `Intervalo inválido (máximo ${MAX_RANGE_DAYS} dias)`);
      }
      throw error;
    }
  }

  @Post(':id/reschedule')
  async reschedule(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
    @Param('id', new ZodValidationPipe(appointmentIdSchema)) id: string,
    @Body(new ZodValidationPipe(rescheduleSchema))
    body: { date: string; start: string; professionalId?: string },
  ) {
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
