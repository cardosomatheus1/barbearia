import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  applyAttendance,
  BoardError,
  createAppointment,
  findCustomer,
  getAvailabilityRange,
  getCounterCatalog,
  getDayBoard,
  MAX_RANGE_DAYS,
  searchCustomers,
} from '@barbearia/scheduling';
import { pode, type AttendanceAction } from '@barbearia/core';
import { OtpError, resolveGuestCustomer, type AuthenticatedStaff } from '@barbearia/identity';
import { badRequest, DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { traduzirReserva } from '../common/booking-http.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { appointmentIdSchema } from '../booking/booking.schemas.js';
import { unidadeDoBalcao } from './unidade.js';
import {
  attendanceSchema,
  counterBookingSchema,
  counterRangeSchema,
  daySchema,
  searchSchema,
} from './board.schemas.js';

const BOARD_STATUS: Record<string, number> = {
  appointment_not_found: 404,
  // 409, não 403: quem está do outro lado tem permissão; o atendimento é que já
  // mudou de estado. A tela precisa recarregar, não pedir outra credencial.
  transition_not_allowed: 409,
  slot_taken: 409,
};

function toHttp(error: unknown): never {
  if (error instanceof BoardError) {
    throw new DomainError(error.code, BOARD_STATUS[error.code] ?? 400, error.message);
  }
  traduzirReserva(error);
  if (error instanceof OtpError) {
    throw new DomainError(error.code, error.code === 'invalid_phone' ? 400 : 401, error.message);
  }
  throw error;
}

/**
 * O balcão — **sessão de gestor obrigatória**.
 *
 * A terceira superfície do produto, ao lado da página do cliente e do painel de
 * configuração: é o que fica aberto no notebook da recepção o dia inteiro. Tudo
 * aqui responde a "quem está aí agora e o que faço com essa pessoa".
 *
 * Duas escolhas valem por toda a classe:
 *
 * - **Nenhuma rota aceita `locationId`.** Ele vem do tenant do token. Aceitá-lo
 *   da requisição transformaria um id vazado em chave para operar o dia de
 *   outra barbearia — a RLS barraria a leitura, mas o desenho não deve depender
 *   disso.
 * - **Toda rota declara a permissão que exige.** A guarda recusa por padrão o
 *   que não declara nada: rota sem `@Exige` não é rota liberada, é rota que
 *   esqueceu — e esquecimento tem que virar erro no primeiro teste, não brecha.
 * - **Quem não tem `appointments.view_all_professionals` só enxerga a própria
 *   agenda.** O recorte sai de `staff.professionalId`, nunca do parâmetro da
 *   requisição — aceitar da URL seria pedir ao barbeiro que escolhesse o que
 *   ele pode ver.
 * - **Nenhuma rota devolve o telefone completo.** A tela fica virada para o
 *   salão; quem passa na frente do notebook não precisa levar a base de
 *   contatos junto.
 */
@Controller('v1/admin')
@UseGuards(StaffGuard, PermissaoGuard)
export class BoardController {
  /**
   * A qual agenda esta sessão está limitada, ou `null` para o dia inteiro.
   *
   * `appointments.view_all_professionals` estava no catálogo, era negada ao
   * barbeiro e não decidia nada: o painel devolvia a agenda da casa inteira sob
   * `appointments.view`, que todo papel tem. A tela de equipe ainda prometia "a
   * própria agenda" para esse papel — permissão que não decide é promessa que a
   * tela quebra.
   */
  private recorte(staff: AuthenticatedStaff): string | null {
    return pode(staff.permissions, 'appointments.view_all_professionals')
      ? null
      : staff.professionalId;
  }
  /** O dia da barbearia. Uma consulta, aberta o dia inteiro e recarregada. */
  @Exige('appointments.view')
  @Get('day')
  async day(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(daySchema)) query: { date?: string; professionalId?: string },
  ) {
    const unidade = await unidadeDoBalcao(staff);

    const board = await getDayBoard({
      tenantId: staff.tenantId,
      locationId: unidade.id,
      date: query.date ?? unidade.today,
      onlyProfessionalId: this.recorte(staff),
    });

    // O filtro da tela é aplicado aqui, não na consulta: o dia já veio numa ida
    // ao banco, e os totais que a recepção olha ao fechar são os do que ela
    // enxerga, não os do barbeiro selecionado no filtro. O **recorte de
    // permissão** é outra coisa e vai na consulta, acima.
    const entries = query.professionalId
      ? board.entries.filter((e) => e.professionalId === query.professionalId)
      : board.entries;

    return { ...board, entries, today: unidade.today };
  }

  /**
   * Move um atendimento: chegou, começou, terminou, faltou.
   *
   * A decisão de o que é permitido é do domínio (`packages/core`), tomada
   * dentro da transação que escreve. Se a tela oferecer um botão que não vale
   * mais — porque outra pessoa no balcão já tocou o cartão —, a resposta é 409
   * e não uma sobrescrita silenciosa.
   */
  @Exige('appointments.attend')
  @Post('appointments/:id/attendance')
  async attendance(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(appointmentIdSchema)) id: string,
    @Body(new ZodValidationPipe(attendanceSchema)) body: { action: AttendanceAction },
  ) {
    const unidade = await unidadeDoBalcao(staff);
    try {
      return await applyAttendance({
        tenantId: staff.tenantId,
        appointmentId: id,
        action: body.action,
        // A loja em que este balcão está. Sem ela, um operador escopado à
        // filial marcava falta num atendimento da matriz com o id na mão — a
        // RLS separa barbearias e não separa lojas dentro de uma.
        locationId: unidade.id,
        /**
         * Cancelar devolve quem espera pela vaga, com nome e telefone — e
         * identidade de cliente é `customers.view` nesta casa.
         *
         * Conferida com a mesma função que a guarda aplica, e **não** declarada
         * na rota: `@Exige` é conjuntivo, então somá-la aqui tiraria de quem só
         * atende o direito de marcar presença. Quem não a tem recebe a
         * contagem; quem a tem, os nomes.
         */
        podeVerCliente: pode(staff.permissions, 'customers.view'),
        // Sem isto, quem enxerga só a própria agenda ainda marcava falta no
        // cliente do colega: bastava ter o id, e a lista de ontem já o dava.
        onlyProfessionalId: this.recorte(staff),
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  /** Serviços e equipe, para montar a marcação pelo balcão. */
  @Exige('appointments.create')
  @Get('catalog')
  async catalog(@Staff() staff: AuthenticatedStaff) {
    const unidade = await unidadeDoBalcao(staff);
    return { ...(await getCounterCatalog(staff.tenantId, unidade.id)), timezone: unidade.timezone };
  }

  /**
   * Acha quem já é cliente.
   *
   * Existe para não criar o terceiro cadastro da mesma pessoa — que é como uma
   * base de clientes deixa de valer alguma coisa. O piso de três caracteres e o
   * teto de resultados estão no domínio: a rota não pode virar exportação da
   * base uma página por vez.
   */
  @Exige('customers.view')
  @Get('customers')
  async customers(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(searchSchema)) query: { q: string },
  ) {
    return { customers: await searchCustomers({ tenantId: staff.tenantId, query: query.q }) };
  }

  /** Grade para marcar alguém pelo balcão. */
  @Exige('appointments.create')
  @Get('availability')
  async availability(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(counterRangeSchema))
    query: { serviceIds: string[]; professionalId?: string; dateFrom: string; dateTo?: string },
  ) {
    const unidade = await unidadeDoBalcao(staff);

    try {
      const range = await getAvailabilityRange({
        tenantId: staff.tenantId,
        locationId: unidade.id,
        serviceIds: query.serviceIds,
        ...(query.professionalId ? { professionalId: query.professionalId } : {}),
        collapse: !query.professionalId,
        // A grade tem que ser a mesma que a gravação vai aceitar; caso
        // contrário o operador escolhe um horário e leva 409 de volta.
        atCounter: true,
        dateFrom: query.dateFrom,
        ...(query.dateTo ? { dateTo: query.dateTo } : {}),
      });
      return { timezone: range.timezone, days: range.days };
    } catch (error) {
      if (error instanceof RangeError) {
        throw badRequest('invalid_range', `Intervalo inválido (máximo ${MAX_RANGE_DAYS} dias)`);
      }
      throw error;
    }
  }

  /**
   * Marca alguém pelo balcão.
   *
   * `source: 'reception'` separa no relatório o que a casa marcou do que o
   * cliente marcou sozinho — é o número que diz se o autoatendimento está
   * funcionando.
   *
   * `atCounter` desliga a antecedência mínima da unidade, e só aqui: a rota
   * está sob a guarda de equipe, e o cliente está de pé na frente da
   * recepcionista.
   */
  @Exige('appointments.create')
  @Post('appointments')
  async book(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(counterBookingSchema))
    body: {
      customerId?: string;
      name?: string;
      phone?: string;
      professionalId: string;
      serviceIds: string[];
      date: string;
      start: string;
      notes?: string;
    },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > 128)) {
      throw badRequest('invalid_request', 'Idempotency-Key com tamanho inválido');
    }

    const unidade = await unidadeDoBalcao(staff);

    try {
      const customerId = await this.identificar(staff.tenantId, body);

      const agendamento = await createAppointment({
        tenantId: staff.tenantId,
        locationId: unidade.id,
        customerId,
        professionalId: body.professionalId,
        serviceIds: body.serviceIds,
        date: body.date,
        start: body.start,
        source: 'reception',
        atCounter: true,
        ...(body.notes ? { notes: body.notes } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });

      return {
        id: agendamento.id,
        startsAt: agendamento.serviceStartsAt,
        endsAt: agendamento.serviceEndsAt,
        professionalId: agendamento.professionalId,
        priceCents: agendamento.priceCents,
      };
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * De quem é o horário.
   *
   * O id vindo da tela é conferido contra a RLS antes de ir para o `INSERT`. A
   * chave estrangeira de `appointments.customer_id` não conhece tenant, e a
   * checagem de integridade do Postgres não passa pela política — sem esta
   * consulta, um id de cliente de outra barbearia seria gravado sem erro, e o
   * nome dele apareceria no painel de quem não devia vê-lo.
   */
  private async identificar(
    tenantId: string,
    body: { customerId?: string; name?: string; phone?: string },
  ): Promise<string> {
    if (body.customerId) {
      const cliente = await findCustomer(tenantId, body.customerId);
      if (!cliente) throw notFound('customer_not_found', 'Cliente não encontrado');
      return cliente.id;
    }

    if (!body.name || !body.phone) {
      throw badRequest('invalid_request', 'Informe o cliente ou nome e celular');
    }

    const novo = await resolveGuestCustomer({
      tenantId,
      name: body.name,
      phone: body.phone,
    });
    return novo.customerId;
  }
}
