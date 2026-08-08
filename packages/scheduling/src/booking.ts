import { createHash } from 'node:crypto';
import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  agendarAvisosDoAgendamento,
  agendarFalta,
  cancelarTarefasDoAgendamento,
} from '@barbearia/jobs';
import {
  canCancel,
  canReschedule,
  localToInstant,
  minutesBetween,
  parseHHMM,
  type ChangeDecision,
  type ChangeRefusal,
} from '@barbearia/core';
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
  | 'hold_expired'
  | 'too_late'
  | 'too_many_reschedules'
  | 'already_started';

/** Espelha o enum `appointment_source`. Valor fora da lista quebraria o INSERT
 *  com erro de banco em vez de recusa limpa. */
export type AppointmentSource =
  | 'website' | 'app' | 'whatsapp' | 'instagram' | 'google' | 'marketplace'
  | 'reception' | 'professional' | 'api' | 'recurrence' | 'waitlist';

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
export function pgCode(error: unknown): string | null {
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
  readonly source?: AppointmentSource;
  readonly notes?: string;
  readonly idempotencyKey?: string;
  readonly holdId?: string;
  readonly now?: Date;
  /**
   * Marcação pelo balcão: sem antecedência mínima e sem janela máxima.
   *
   * Só quem já está autenticado como equipe pode passar isto — nunca vem do
   * corpo de uma requisição do cliente, senão a guarda de autoatendimento seria
   * desligada por quem ela existe para conter.
   */
  readonly atCounter?: boolean;
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
    ...(request.atCounter ? { atCounter: true } : {}),
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

/**
 * Deriva a chave gravada a partir do tenant, do cliente e da chave bruta.
 *
 * A chave bruta vem do cliente e é livre — na prática as aplicações mandam
 * coisas como "1" ou um timestamp. Buscar só por ela dentro do tenant faria dois
 * clientes com a mesma string colidirem, e o segundo receberia de volta o
 * agendamento do primeiro: id, horário, preço. Com o id, cancelaria o horário
 * alheio.
 *
 * Derivar elimina a colisão sem exigir que a chave seja secreta.
 */
function scopedIdempotencyKey(
  tenantId: string,
  customerId: string | undefined,
  raw: string,
): string {
  return createHash('sha256')
    .update(`${tenantId}\u0000${customerId ?? ''}\u0000${raw}`)
    .digest('hex');
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

/**
 * Programa o que o agendamento recém-criado dispara sozinho: os avisos e a
 * falta.
 *
 * **Na mesma transação.** Se o corte entra, os lembretes entram; se a transação
 * volta atrás, eles somem junto. Enfileirar depois criaria a janela em que o
 * horário está marcado e nenhum lembrete foi programado — e o defeito só
 * apareceria no dia seguinte, como a falta que o lembrete existia para evitar.
 *
 * Cada aviso liga e desliga por conta própria na unidade: barbearia que acha o
 * de 2h intrusivo desliga só ele. A falta segue `no_show_after_minutes`, que
 * existe desde o bloco 11 — até aqui só o painel a mostrava correndo.
 */
async function programarTarefas(
  tx: TransactionClient,
  appointmentId: string,
  locationId: string,
  comecaEm: Date,
  agora: Date,
): Promise<void> {
  const linhas = await tx.$queryRaw<
    {
      timezone: string;
      notify_confirmation: boolean;
      notify_reminder_24h: boolean;
      notify_reminder_2h: boolean;
      no_show_after_minutes: number;
    }[]
  >`
    SELECT timezone, notify_confirmation, notify_reminder_24h, notify_reminder_2h,
           no_show_after_minutes
      FROM locations WHERE id = ${locationId}::uuid
  `;
  const unidade = linhas[0];
  if (!unidade) return;

  await agendarAvisosDoAgendamento(tx, {
    appointmentId,
    comecaEm,
    timeZone: unidade.timezone,
    agora,
    ligados: {
      confirmacao: unidade.notify_confirmation,
      lembrete_24h: unidade.notify_reminder_24h,
      lembrete_2h: unidade.notify_reminder_2h,
      sua_vez: false,
      senha_de_acesso: false,
      retorno: false,
    },
  });

  await agendarFalta(tx, {
    appointmentId,
    comecaEm,
    toleranciaMinutos: unidade.no_show_after_minutes,
  });
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

  await programarTarefas(tx, id, request.locationId, slot.serviceStart, request.now ?? new Date());

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
    const storedKey = request.idempotencyKey
      ? scopedIdempotencyKey(request.tenantId, request.customerId, request.idempotencyKey)
      : undefined;

    if (storedKey) {
      const existing = await findByIdempotencyKey(tx, storedKey);
      if (existing) return existing;
    }

    const slot = await resolveSlot(tx, request);

    let id: string;
    try {
      id = await insertAppointment(
        tx,
        { ...request, ...(storedKey ? { idempotencyKey: storedKey } : {}) },
        slot,
      );
    } catch (error) {
      const code = pgCode(error);
      if (code === EXCLUSION_VIOLATION) {
        // Outra requisição gravou o mesmo horário entre a validação e o INSERT.
        throw new BookingError(
          'slot_taken',
          'Este horário já não está mais disponível. Tente em um outro horário.',
        );
      }
      if (code === UNIQUE_VIOLATION && storedKey) {
        const existing = await findByIdempotencyKey(tx, storedKey);
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
  /**
   * Quando informado, só cancela se o agendamento for deste cliente.
   *
   * A RLS separa barbearias, mas não separa clientes **dentro** de uma. Sem
   * este filtro, qualquer cliente autenticado cancelaria o horário de qualquer
   * outro bastando o id. Obrigatório sempre que a ação partir do cliente.
   */
  readonly customerId?: string;
  /** Relógio por parâmetro: a janela de antecedência precisa ser testável. */
  readonly now?: Date;
}

/**
 * Cancela um agendamento.
 *
 * `cancelled_customer` e `cancelled_business` são separados de propósito: só o
 * primeiro afeta o reliability score. Punir cliente por cancelamento da
 * barbearia seria bug de produto (SPEC Parte 2 §2.11).
 */
interface ChangeContext {
  readonly serviceStartsAt: Date;
  readonly timesRescheduled: number;
  readonly cancelMinHours: number;
  readonly rescheduleMinHours: number;
  readonly maxReschedules: number;
}

/**
 * Reúne o que decide se o cliente ainda pode mexer no agendamento.
 *
 * Uma consulta só, dentro da mesma transação da alteração: ler a janela em
 * outra ida ao banco abriria espaço para a barbearia mudar a política entre a
 * leitura e a escrita.
 *
 * A corrente de remarcações é percorrida para trás por `rescheduled_from`. Cada
 * salto é busca por chave primária, e a profundidade é o próprio teto que se
 * quer aplicar — não há varredura.
 */
async function loadChangeContext(
  tx: TransactionClient,
  appointmentId: string,
  customerId: string | undefined,
): Promise<ChangeContext | null> {
  const rows = await tx.$queryRaw<
    {
      service_starts_at: Date;
      times_rescheduled: bigint;
      cancel_min_hours: number;
      reschedule_min_hours: number;
      max_reschedules: number;
    }[]
  >`
    WITH RECURSIVE corrente AS (
      SELECT id, rescheduled_from
      FROM appointments
      WHERE id = ${appointmentId}::uuid
        AND (${customerId ?? null}::uuid IS NULL OR customer_id = ${customerId ?? null}::uuid)
      UNION ALL
      SELECT anterior.id, anterior.rescheduled_from
      FROM appointments anterior
      JOIN corrente ON anterior.id = corrente.rescheduled_from
    )
    SELECT a.service_starts_at,
           (SELECT count(*) - 1 FROM corrente) AS times_rescheduled,
           l.cancel_min_hours, l.reschedule_min_hours, l.max_reschedules
    FROM appointments a
    JOIN locations l ON l.id = a.location_id
    WHERE a.id = ${appointmentId}::uuid
      AND (${customerId ?? null}::uuid IS NULL OR a.customer_id = ${customerId ?? null}::uuid)
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    serviceStartsAt: row.service_starts_at,
    // `count(*)` volta como bigint do Postgres; sem a conversão a comparação
    // com o teto seria entre BigInt e number e lançaria em runtime.
    timesRescheduled: Number(row.times_rescheduled),
    cancelMinHours: row.cancel_min_hours,
    rescheduleMinHours: row.reschedule_min_hours,
    maxReschedules: row.max_reschedules,
  };
}

/** Traduz a recusa do núcleo em erro de negócio, com o número na mensagem. */
function refuse(decision: ChangeDecision, verbo: 'cancelar' | 'remarcar'): void {
  if (decision.allowed) return;

  if (decision.refusal === 'already_started') {
    throw new BookingError('already_started', `Este horário já começou e não dá para ${verbo}.`);
  }
  if (decision.refusal === 'too_many_reschedules') {
    throw new BookingError(
      'too_many_reschedules',
      'Este horário já foi remarcado o máximo de vezes. Fale com a barbearia.',
    );
  }
  const horas = decision.minHours === 1 ? '1 hora' : `${decision.minHours} horas`;
  throw new BookingError('too_late', `É preciso ${verbo} com pelo menos ${horas} de antecedência.`);
}

export async function cancelAppointment(request: CancelRequest): Promise<void> {
  await withTenant(request.tenantId, async (tx) => {
    const status = request.by === 'customer' ? 'cancelled_customer' : 'cancelled_business';
    // Quem desmarcou não pode receber "não esqueça do seu horário". Esta é a
    // primeira defesa; o handler reconfere o estado na hora de enviar, que é o
    // que cobre o cancelamento acontecendo com a tarefa já em execução.
    await cancelarTarefasDoAgendamento(tx, request.appointmentId);

    // A janela de antecedência vale para o cliente, não para a barbearia: quem
    // atende precisa poder desmarcar em cima da hora quando o barbeiro adoece.
    // `by === 'business'` é chamada interna, já autorizada por papel.
    if (request.by === 'customer') {
      const context = await loadChangeContext(tx, request.appointmentId, request.customerId);
      if (context) {
        const now = request.now ?? new Date();
        refuse(canCancel(minutesBetween(now, context.serviceStartsAt), context), 'cancelar');
      }
    }

    const affected = await tx.$executeRaw`
      UPDATE appointments
      SET status = ${status}::appointment_status,
          notes = COALESCE(${request.reason ?? null}, notes),
          updated_at = now()
      WHERE id = ${request.appointmentId}::uuid
        AND status = ANY(${[...ACTIVE_STATUSES]}::appointment_status[])
        AND (${request.customerId ?? null}::uuid IS NULL
             OR customer_id = ${request.customerId ?? null}::uuid)
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
  /** Mesma razão de `CancelRequest.customerId`: a RLS não separa clientes. */
  readonly customerId?: string;
  /**
   * Recorte de permissão da equipe: a RLS também não separa profissionais.
   *
   * Quem não tem `appointments.view_all_professionals` só remarca o próprio
   * cliente. Sem isto, `appointments.reschedule` — que todo barbeiro tem por
   * padrão — permitia mover o cliente do colega, ou empurrá-lo para a cadeira
   * de um terceiro.
   */
  readonly onlyProfessionalId?: string | null;
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
        source: AppointmentSource;
        service_ids: string[];
      }[]
    >`
      SELECT a.id, a.location_id, a.customer_id, a.professional_id, a.status, a.source,
             array_agg(s.service_id::text ORDER BY s.position) AS service_ids
      FROM appointments a
      JOIN appointment_services s ON s.appointment_id = a.id
      WHERE a.id = ${request.appointmentId}::uuid
        AND (${request.customerId ?? null}::uuid IS NULL
             OR a.customer_id = ${request.customerId ?? null}::uuid)
        -- RLS separa barbearias, não profissionais dentro de uma. Sem este
        -- recorte, quem enxerga só a própria agenda remarcava o cliente do
        -- colega — bastava ter o id, e a lista de conflitos dava o id.
        AND (${request.onlyProfessionalId ?? null}::uuid IS NULL
             OR a.professional_id = ${request.onlyProfessionalId ?? null}::uuid)
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

    // Só quando parte do cliente: a recepção remarca em cima da hora, é o
    // trabalho dela. `customerId` é o que distingue os dois chamadores.
    if (request.customerId) {
      const context = await loadChangeContext(tx, request.appointmentId, request.customerId);
      if (context) {
        const now = request.now ?? new Date();
        refuse(
          canReschedule(
            minutesBetween(now, context.serviceStartsAt),
            context.timesRescheduled,
            context,
          ),
          'remarcar',
        );
      }
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

    // Os avisos do horário antigo saem junto. Sem isso o cliente receberia o
    // lembrete de um horário que deixou de existir — pior que não receber, e o
    // novo agendamento programa os seus logo abaixo, em `insertAppointment`.
    await cancelarTarefasDoAgendamento(tx, request.appointmentId);

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

export interface CustomerAppointment {
  readonly id: string;
  readonly state: ReceiptState;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: string;
  readonly professionalName: string;
  readonly services: readonly string[];
  /** Ids do catálogo: é com eles que a tela de remarcação consulta a grade. */
  readonly serviceIds: readonly string[];
  readonly professionalId: string;
  readonly priceCents: number;
  readonly canCancel: boolean;
  readonly canReschedule: boolean;
  /**
   * Por que o botão não está lá.
   *
   * Botão ausente sem explicação faz o cliente achar que o site quebrou e
   * ligar para a barbearia — que é exatamente o trabalho que este produto
   * existe para eliminar.
   */
  readonly blockedReason: ChangeRefusal | null;
  readonly minHoursToChange: number;
}

/**
 * Agendamentos de um cliente.
 *
 * Filtra por `customerId` além do tenant: a RLS separa barbearias, não separa
 * clientes dentro de uma. Sem esse filtro a listagem devolveria a agenda inteira
 * da barbearia para qualquer cliente autenticado.
 */
export async function listCustomerAppointments(params: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly includePast?: boolean;
  readonly now?: Date;
  readonly limit?: number;
}): Promise<readonly CustomerAppointment[]> {
  const now = params.now ?? new Date();
  const limit = Math.min(params.limit ?? 50, 100);

  return withTenant(params.tenantId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        service_starts_at: Date;
        service_ends_at: Date;
        status: string;
        professional_name: string;
        services: string[];
        service_ids: string[];
        professional_id: string;
        price_cents: number;
        times_rescheduled: bigint;
        cancel_min_hours: number;
        reschedule_min_hours: number;
        max_reschedules: number;
      }[]
    >`
      -- Uma consulta só, incluindo quantas vezes cada horário já foi remarcado.
      -- A recursão percorre todas as correntes do cliente de uma vez; contar
      -- por agendamento seria N+1 numa tela que lista dezenas (CLAUDE.md §3).
      WITH RECURSIVE cadeia AS (
        SELECT id AS raiz, rescheduled_from, 0 AS saltos
        FROM appointments
        WHERE customer_id = ${params.customerId}::uuid
        UNION ALL
        SELECT c.raiz, anterior.rescheduled_from, c.saltos + 1
        FROM appointments anterior
        JOIN cadeia c ON anterior.id = c.rescheduled_from
      ),
      remarcacoes AS (
        SELECT raiz, max(saltos) AS vezes FROM cadeia GROUP BY raiz
      )
      SELECT a.id, a.service_starts_at, a.service_ends_at, a.status,
             p.name AS professional_name,
             array_agg(s.name ORDER BY aps.position) AS services,
             array_agg(aps.service_id::text ORDER BY aps.position) AS service_ids,
             a.professional_id,
             a.price_cents,
             COALESCE(r.vezes, 0) AS times_rescheduled,
             l.cancel_min_hours, l.reschedule_min_hours, l.max_reschedules
      FROM appointments a
      JOIN professionals p ON p.id = a.professional_id
      JOIN locations l ON l.id = a.location_id
      JOIN appointment_services aps ON aps.appointment_id = a.id
      JOIN services s ON s.id = aps.service_id
      LEFT JOIN remarcacoes r ON r.raiz = a.id
      WHERE a.customer_id = ${params.customerId}::uuid
        AND (${params.includePast ?? false} OR a.service_ends_at >= ${now})
      GROUP BY a.id, p.name, r.vezes, l.cancel_min_hours, l.reschedule_min_hours,
               l.max_reschedules, a.professional_id
      ORDER BY a.service_starts_at DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => {
      const active = (ACTIVE_STATUSES as readonly string[]).includes(row.status);
      const minutes = minutesBetween(now, row.service_starts_at);
      const window = {
        cancelMinHours: row.cancel_min_hours,
        rescheduleMinHours: row.reschedule_min_hours,
        maxReschedules: row.max_reschedules,
      };

      // A mesma decisão que a API vai aplicar na hora de cancelar. Calcular a
      // permissão de um jeito aqui e de outro lá é como a tela acaba oferecendo
      // um botão que o servidor recusa.
      const cancel = active ? canCancel(minutes, window) : null;
      const reschedule = active
        ? canReschedule(minutes, Number(row.times_rescheduled), window)
        : null;

      const refused = [cancel, reschedule].find((d) => d && !d.allowed);

      return {
        id: row.id,
        state: receiptState(row.status),
        startsAt: row.service_starts_at.toISOString(),
        endsAt: row.service_ends_at.toISOString(),
        status: row.status,
        professionalName: row.professional_name,
        services: row.services,
        serviceIds: row.service_ids,
        professionalId: row.professional_id,
        priceCents: row.price_cents,
        canCancel: cancel?.allowed ?? false,
        canReschedule: reschedule?.allowed ?? false,
        blockedReason: refused && !refused.allowed ? refused.refusal : null,
        minHoursToChange: row.cancel_min_hours,
      };
    });
  });
}

/**
 * O que o comprovante precisa dizer, em três estados.
 *
 * O enum do banco tem dez valores e vai crescer; a tela não deve conhecê-los.
 * Traduzir aqui é o que impede a view de decidir regra de negócio — e de errar
 * ao inventar nome de status (`cancelled` não existe: são `cancelled_customer`
 * e `cancelled_business`).
 */
export type ReceiptState = 'active' | 'done' | 'cancelled' | 'rescheduled';

/**
 * Conjunto próprio, não `ACTIVE_STATUSES`: aquele responde "ainda dá para
 * cancelar?" e por isso deixa `in_progress` de fora. Aqui a pergunta é "esse
 * horário ainda vale?", e um corte em andamento vale.
 */
const RECEIPT_ACTIVE = ['pending', 'confirmed', 'checked_in', 'waiting', 'in_progress'];

function receiptState(status: string): ReceiptState {
  if (RECEIPT_ACTIVE.includes(status)) return 'active';
  if (status === 'completed') return 'done';
  // Separado de cancelado: o horário não sumiu, virou outro. Dizer "cancelado"
  // para quem acabou de remarcar faz o cliente achar que perdeu a vaga.
  if (status === 'rescheduled') return 'rescheduled';
  return 'cancelled';
}

export interface AppointmentReceipt {
  readonly id: string;
  readonly state: ReceiptState;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly professionalName: string;
  readonly services: readonly string[];
  readonly priceCents: number;
  readonly locationId: string;
}

/**
 * Comprovante de um agendamento, legível por quem tem o link.
 *
 * O id é UUID aleatório e funciona como a própria credencial — é o padrão de
 * link mágico de confirmação. Por isso o retorno traz só o que cabe num
 * comprovante: **nada do cliente**. Nome e celular ficariam expostos a quem
 * recebesse o link encaminhado, e a tela de confirmação não precisa deles.
 *
 * A separação entre barbearias é da RLS; aqui não há filtro por cliente porque
 * não há cliente autenticado. Cancelar e reagendar continuam exigindo sessão.
 */
export async function getAppointmentReceipt(
  tenantId: string,
  appointmentId: string,
): Promise<AppointmentReceipt | null> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        service_starts_at: Date;
        service_ends_at: Date;
        status: string;
        professional_name: string;
        services: string[];
        price_cents: number;
        location_id: string;
      }[]
    >`
      SELECT a.id, a.service_starts_at, a.service_ends_at, a.status,
             p.name AS professional_name,
             array_agg(s.name ORDER BY aps.position) AS services,
             a.price_cents, a.location_id
      FROM appointments a
      JOIN professionals p ON p.id = a.professional_id
      JOIN appointment_services aps ON aps.appointment_id = a.id
      JOIN services s ON s.id = aps.service_id
      WHERE a.id = ${appointmentId}::uuid
      GROUP BY a.id, p.name
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      state: receiptState(row.status),
      startsAt: row.service_starts_at.toISOString(),
      endsAt: row.service_ends_at.toISOString(),
      professionalName: row.professional_name,
      services: row.services,
      priceCents: row.price_cents,
      locationId: row.location_id,
    };
  });
}

/**
 * O agendamento de um cliente, para montar a grade de remarcação.
 *
 * Devolve `null` quando o agendamento não é deste cliente — sem distinguir de
 * "não existe", pela mesma razão de `cancelAppointment`.
 */
export async function getReschedulableAppointment(params: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly appointmentId: string;
}): Promise<{
  readonly locationId: string;
  readonly professionalId: string;
  readonly serviceIds: readonly string[];
} | null> {
  return withTenant(params.tenantId, async (tx) => {
    const rows = await tx.$queryRaw<
      { location_id: string; professional_id: string; service_ids: string[] }[]
    >`
      SELECT a.location_id, a.professional_id,
             array_agg(aps.service_id::text ORDER BY aps.position) AS service_ids
      FROM appointments a
      JOIN appointment_services aps ON aps.appointment_id = a.id
      WHERE a.id = ${params.appointmentId}::uuid
        AND a.customer_id = ${params.customerId}::uuid
        AND a.status = ANY(${[...ACTIVE_STATUSES]}::appointment_status[])
      GROUP BY a.id
    `;

    const row = rows[0];
    if (!row) return null;
    return {
      locationId: row.location_id,
      professionalId: row.professional_id,
      serviceIds: row.service_ids,
    };
  });
}

/** Política de identificação da unidade, para a API decidir se exige sessão. */
export async function bookingPolicy(
  tenantId: string,
  locationId: string,
): Promise<{ readonly requireOtpForBooking: boolean } | null> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<{ require_otp_for_booking: boolean }[]>`
      SELECT require_otp_for_booking FROM locations WHERE id = ${locationId}::uuid
    `;
    const row = rows[0];
    return row ? { requireOtpForBooking: row.require_otp_for_booking } : null;
  });
}
