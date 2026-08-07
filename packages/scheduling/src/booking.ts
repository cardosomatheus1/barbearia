import { withTenant, type TransactionClient } from '@barbearia/db';
import { localToInstant, parseHHMM } from '@barbearia/core';
import { loadDayContext } from './repository.js';
import { computeFromContext } from './service.js';

/**
 * Operações de reserva.
 *
 * Duas defesas independentes, deliberadamente sobrepostas:
 *
 * 1. **Validade de negócio** — o horário pedido precisa constar da grade que o
 *    motor calcula: dentro da jornada, com recurso livre, respeitando buffer,
 *    limite diário e antecedência mínima.
 * 2. **Integridade sob concorrência** — a constraint de exclusão em
 *    `appointments` rejeita sobreposição no mesmo profissional. É o que segura
 *    duas requisições que passaram pela validação no mesmo instante.
 *
 * A primeira sozinha é insuficiente: entre calcular e gravar existe uma janela.
 * A segunda sozinha também: ela não sabe nada sobre expediente ou recurso, só
 * sobre colisão entre agendamentos.
 */

/** Códigos estáveis de falha. A API os traduz para HTTP sem reinterpretar. */
export type BookingFailure =
  | 'unknown_location'
  | 'slot_not_available'
  | 'slot_taken'
  | 'appointment_not_found'
  | 'appointment_not_active'
  | 'hold_expired';

export class BookingError extends Error {
  constructor(readonly code: BookingFailure, message: string) {
    super(message);
    this.name = 'BookingError';
  }
}

const EXCLUSION_VIOLATION = '23P01';
const UNIQUE_VIOLATION = '23505';

/**
 * Extrai o SQLSTATE do Postgres de um erro do Prisma.
 *
 * Consulta crua falha como `PrismaClientKnownRequestError` com `code: 'P2010'`
 * — o código do Prisma, não do banco. O SQLSTATE real fica em `meta.code`, e
 * como último recurso na mensagem. Ler só `error.code` devolveria sempre
 * 'P2010' e nenhuma violação seria reconhecida.
 */
function pgCode(error: unknown): string | null {
  const meta = (error as { meta?: { code?: unknown } })?.meta;
  if (typeof meta?.code === 'string') return meta.code;

  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && !/^P\d+$/.test(code)) return code;

  const message = error instanceof Error ? error.message : '';
  return /Code: `(\w+)`/.exec(message)?.[1] ?? null;
}

export interface AppointmentRef {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly serviceStartsAt: string;
  readonly serviceEndsAt: string;
  readonly professionalId: string;
  readonly status: string;
  readonly priceCents: number;
  /** Verdadeiro quando a chave de idempotência devolveu um registro já existente. */
  readonly deduplicated: boolean;
}

export interface CreateAppointmentRequest {
  readonly tenantId: string;
  readonly locationId: string;
  readonly professionalId: string;
  readonly serviceIds: readonly string[];
  /** Data local da unidade, YYYY-MM-DD. */
  readonly date: string;
  /** Início visível ao cliente, HH:mm local. */
  readonly start: string;
  readonly customerId?: string;
  readonly source?: string;
  readonly notes?: string;
  readonly idempotencyKey?: string;
  readonly holdId?: string;
  readonly now?: Date;
}

interface ResolvedSlot {
  readonly occupiedStart: Date;
  readonly occupiedEnd: Date;
  readonly serviceStart: Date;
  readonly serviceEnd: Date;
  readonly priceCents: number;
  readonly durations: ReadonlyMap<string, number>;
  readonly prices: ReadonlyMap<string, number>;
  readonly resources: readonly { resourceType: string; quantity: number }[];
}

/**
 * Confere que o horário pedido está de fato na grade e devolve a janela exata,
 * já com buffers, que será gravada.
 *
 * O cliente informa apenas data, profissional e início. Duração, buffers e
 * preço vêm do catálogo — nunca da requisição. Aceitar preço ou duração vindos
 * do cliente seria deixá-lo escolher quanto paga e quanto ocupa.
 */
async function resolveSlot(
  tx: TransactionClient,
  request: CreateAppointmentRequest,
  options: { readonly ignoreAppointmentId?: string } = {},
): Promise<ResolvedSlot> {
  const context = await loadDayContext(tx, {
    locationId: request.locationId,
    serviceIds: request.serviceIds,
    date: request.date,
    professionalId: request.professionalId,
    ...(request.holdId ? { ignoreHoldId: request.holdId } : {}),
    ...(options.ignoreAppointmentId
      ? { ignoreAppointmentId: options.ignoreAppointmentId }
      : {}),
  });

  if (!context) throw new BookingError('unknown_location', 'Unidade ou serviço não encontrado');

  const availability = computeFromContext(context, {
    date: request.date,
    ...(request.now ? { now: request.now } : {}),
  });

  const slot = availability.slots.find(
    (candidate) =>
      candidate.start === request.start && candidate.professionalId === request.professionalId,
  );
  if (!slot) {
    throw new BookingError(
      'slot_not_available',
      'Este horário já não está mais disponível. Tente em um outro horário.',
    );
  }

  const { timezone } = context.location;
  const professional = context.professionals.find((item) => item.id === request.professionalId);

  const durations = new Map<string, number>();
  const prices = new Map<string, number>();
  for (const service of context.services) {
    const override = professional?.overrides.get(service.id);
    durations.set(service.id, override?.durationMinutes ?? service.durationMinutes);
    prices.set(service.id, override?.priceCents ?? service.priceCents);
  }

  const resources = new Map<string, number>();
  for (const service of context.services) {
    for (const requirement of service.requiredResources) {
      // Máximo, não soma: corte e barba usam a mesma cadeira.
      const current = resources.get(requirement.resourceType) ?? 0;
      if (requirement.quantity > current) {
        resources.set(requirement.resourceType, requirement.quantity);
      }
    }
  }

  return {
    occupiedStart: localToInstant(timezone, request.date, parseHHMM(slot.occupiedStart)),
    occupiedEnd: localToInstant(timezone, request.date, parseHHMM(slot.occupiedEnd)),
    serviceStart: localToInstant(timezone, request.date, parseHHMM(slot.start)),
    serviceEnd: localToInstant(timezone, request.date, parseHHMM(slot.end)),
    priceCents: slot.price ?? 0,
    durations,
    prices,
    resources: [...resources].map(([resourceType, quantity]) => ({ resourceType, quantity })),
  };
}

async function findByIdempotencyKey(
  tx: TransactionClient,
  key: string,
): Promise<AppointmentRef | null> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      starts_at: Date;
      ends_at: Date;
      service_starts_at: Date;
      service_ends_at: Date;
      professional_id: string;
      status: string;
      price_cents: number;
    }[]
  >`
    SELECT id, starts_at, ends_at, service_starts_at, service_ends_at,
           professional_id, status, price_cents
    FROM appointments WHERE idempotency_key = ${key} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    serviceStartsAt: row.service_starts_at.toISOString(),
    serviceEndsAt: row.service_ends_at.toISOString(),
    professionalId: row.professional_id,
    status: row.status,
    priceCents: row.price_cents,
    deduplicated: true,
  };
}

async function insertAppointment(
  tx: TransactionClient,
  request: CreateAppointmentRequest,
  slot: ResolvedSlot,
): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO appointments (
      tenant_id, location_id, customer_id, professional_id,
      starts_at, ends_at, service_starts_at, service_ends_at,
      status, source, notes, price_cents, idempotency_key
    ) VALUES (
      ${request.tenantId}::uuid,
      ${request.locationId}::uuid,
      ${request.customerId ?? null}::uuid,
      ${request.professionalId}::uuid,
      ${slot.occupiedStart}, ${slot.occupiedEnd},
      ${slot.serviceStart}, ${slot.serviceEnd},
      'pending',
      ${request.source ?? 'website'}::appointment_source,
      ${request.notes ?? null},
      ${slot.priceCents},
      ${request.idempotencyKey ?? null}
    )
    RETURNING id
  `;

  const id = rows[0]?.id;
  if (!id) throw new BookingError('slot_taken', 'Não foi possível reservar o horário');

  for (const [index, serviceId] of request.serviceIds.entries()) {
    await tx.$executeRaw`
      INSERT INTO appointment_services
        (appointment_id, service_id, tenant_id, position, price_cents, duration_minutes)
      VALUES (
        ${id}::uuid, ${serviceId}::uuid, ${request.tenantId}::uuid, ${index},
        ${slot.prices.get(serviceId) ?? 0}, ${slot.durations.get(serviceId) ?? 1}
      )
    `;
  }

  // A exigência de recurso é gravada agora, não derivada do catálogo depois: o
  // catálogo muda, o passado não.
  for (const resource of slot.resources) {
    await tx.$executeRaw`
      INSERT INTO appointment_resources (appointment_id, resource_type, tenant_id, quantity)
      VALUES (${id}::uuid, ${resource.resourceType}, ${request.tenantId}::uuid, ${resource.quantity})
    `;
  }

  return id;
}

/**
 * Cria um agendamento.
 *
 * Idempotente por `idempotencyKey`: duplo toque em celular lento devolve o
 * mesmo agendamento em vez de criar dois (CLAUDE.md §2).
 */
export async function createAppointment(
  request: CreateAppointmentRequest,
): Promise<AppointmentRef> {
  return withTenant(request.tenantId, async (tx) => {
    if (request.idempotencyKey) {
      const existing = await findByIdempotencyKey(tx, request.idempotencyKey);
      if (existing) return existing;
    }

    const slot = await resolveSlot(tx, request);

    let id: string;
    try {
      id = await insertAppointment(tx, request, slot);
    } catch (error) {
      const code = pgCode(error);
      if (code === EXCLUSION_VIOLATION) {
        // Outra requisição gravou o mesmo horário entre a validação e o INSERT.
        throw new BookingError(
          'slot_taken',
          'Este horário já não está mais disponível. Tente em um outro horário.',
        );
      }
      if (code === UNIQUE_VIOLATION && request.idempotencyKey) {
        const existing = await findByIdempotencyKey(tx, request.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }

    if (request.holdId) {
      await tx.$executeRaw`DELETE FROM slot_holds WHERE id = ${request.holdId}::uuid`;
    }

    return {
      id,
      startsAt: slot.occupiedStart.toISOString(),
      endsAt: slot.occupiedEnd.toISOString(),
      serviceStartsAt: slot.serviceStart.toISOString(),
      serviceEndsAt: slot.serviceEnd.toISOString(),
      professionalId: request.professionalId,
      status: 'pending',
      priceCents: slot.priceCents,
      deduplicated: false,
    };
  });
}

export interface HoldRequest extends Omit<CreateAppointmentRequest, 'idempotencyKey' | 'holdId'> {
  readonly ttlSeconds?: number;
}

export interface HoldRef {
  readonly id: string;
  readonly expiresAt: string;
}

/** Reserva temporária enquanto o cliente paga o sinal (SPEC Parte 2 §2.15). */
export async function holdSlot(request: HoldRequest): Promise<HoldRef> {
  const ttl = request.ttlSeconds ?? 600;

  return withTenant(request.tenantId, async (tx) => {
    const slot = await resolveSlot(tx, request);

    const rows = await tx.$queryRaw<{ id: string; expires_at: Date }[]>`
      INSERT INTO slot_holds (tenant_id, professional_id, starts_at, ends_at, expires_at)
      VALUES (
        ${request.tenantId}::uuid, ${request.professionalId}::uuid,
        ${slot.occupiedStart}, ${slot.occupiedEnd},
        now() + make_interval(secs => ${ttl})
      )
      RETURNING id, expires_at
    `;

    const row = rows[0];
    if (!row) throw new BookingError('slot_taken', 'Não foi possível reservar o horário');
    return { id: row.id, expiresAt: row.expires_at.toISOString() };
  });
}

export async function releaseHold(tenantId: string, holdId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.$executeRaw`DELETE FROM slot_holds WHERE id = ${holdId}::uuid`;
  });
}

const ACTIVE_STATUSES = ['pending', 'confirmed', 'checked_in', 'waiting'] as const;

export interface CancelRequest {
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly by: 'customer' | 'business';
  readonly reason?: string;
}

/**
 * Cancela um agendamento.
 *
 * `cancelled_customer` e `cancelled_business` são separados de propósito: só o
 * primeiro afeta o reliability score. Punir cliente por cancelamento da
 * barbearia seria bug de produto (SPEC Parte 2 §2.11).
 */
export async function cancelAppointment(request: CancelRequest): Promise<void> {
  await withTenant(request.tenantId, async (tx) => {
    const status = request.by === 'customer' ? 'cancelled_customer' : 'cancelled_business';

    const affected = await tx.$executeRaw`
      UPDATE appointments
      SET status = ${status}::appointment_status,
          notes = COALESCE(${request.reason ?? null}, notes),
          updated_at = now()
      WHERE id = ${request.appointmentId}::uuid
        AND status = ANY(${[...ACTIVE_STATUSES]}::appointment_status[])
    `;

    if (affected === 0) {
      // Não distingue "não existe" de "não é seu": a RLS já tornou invisível o
      // que é de outro tenant, e diferenciar aqui viraria oráculo de existência.
      throw new BookingError(
        'appointment_not_found',
        'Agendamento não encontrado ou já encerrado',
      );
    }
  });
}

export interface RescheduleRequest {
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly date: string;
  readonly start: string;
  readonly professionalId?: string;
  readonly now?: Date;
}

/**
 * Reagenda de forma atômica.
 *
 * A SPEC exige "reserva o novo, só então libera o antigo" — se o novo falhar, o
 * antigo permanece intacto e o cliente nunca fica sem agendamento por erro do
 * sistema (Parte 2 §2.7). Aqui isso vem da transação: marcar o antigo como
 * `rescheduled` e inserir o novo acontecem juntos ou não acontecem.
 *
 * A ordem das instruções é o inverso da frase — o antigo é liberado primeiro,
 * senão a constraint de exclusão barraria o novo contra o próprio horário que
 * está saindo. A garantia vem do rollback, não da ordem.
 */
export async function rescheduleAppointment(
  request: RescheduleRequest,
): Promise<AppointmentRef> {
  return withTenant(request.tenantId, async (tx) => {
    const current = await tx.$queryRaw<
      {
        id: string;
        location_id: string;
        customer_id: string | null;
        professional_id: string;
        status: string;
        source: string;
        service_ids: string[];
      }[]
    >`
      SELECT a.id, a.location_id, a.customer_id, a.professional_id, a.status, a.source,
             array_agg(s.service_id::text ORDER BY s.position) AS service_ids
      FROM appointments a
      JOIN appointment_services s ON s.appointment_id = a.id
      WHERE a.id = ${request.appointmentId}::uuid
      GROUP BY a.id
    `;

    const appointment = current[0];
    if (!appointment) {
      throw new BookingError('appointment_not_found', 'Agendamento não encontrado');
    }
    if (!(ACTIVE_STATUSES as readonly string[]).includes(appointment.status)) {
      throw new BookingError(
        'appointment_not_active',
        'Somente agendamento ativo pode ser remarcado',
      );
    }

    const professionalId = request.professionalId ?? appointment.professional_id;

    const target: CreateAppointmentRequest = {
      tenantId: request.tenantId,
      locationId: appointment.location_id,
      professionalId,
      serviceIds: appointment.service_ids,
      date: request.date,
      start: request.start,
      ...(appointment.customer_id ? { customerId: appointment.customer_id } : {}),
      source: appointment.source,
      ...(request.now ? { now: request.now } : {}),
    };

    // O horário que está saindo não pode bloquear a si mesmo na validação.
    const slot = await resolveSlot(tx, target, {
      ignoreAppointmentId: request.appointmentId,
    });

    await tx.$executeRaw`
      UPDATE appointments SET status = 'rescheduled', updated_at = now()
      WHERE id = ${request.appointmentId}::uuid
    `;

    let id: string;
    try {
      id = await insertAppointment(tx, target, slot);
    } catch (error) {
      if (pgCode(error) === EXCLUSION_VIOLATION) {
        // Rollback devolve o agendamento original ao estado ativo.
        throw new BookingError(
          'slot_taken',
          'Este horário já não está mais disponível. Tente em um outro horário.',
        );
      }
      throw error;
    }

    await tx.$executeRaw`
      UPDATE appointments SET rescheduled_from = ${request.appointmentId}::uuid
      WHERE id = ${id}::uuid
    `;

    return {
      id,
      startsAt: slot.occupiedStart.toISOString(),
      endsAt: slot.occupiedEnd.toISOString(),
      serviceStartsAt: slot.serviceStart.toISOString(),
      serviceEndsAt: slot.serviceEnd.toISOString(),
      professionalId,
      status: 'pending',
      priceCents: slot.priceCents,
      deduplicated: false,
    };
  });
}
