import { createHash } from 'node:crypto';
import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  agendarAvisosDoAgendamento,
  agendarFalta,
  agendarOfertaDaVaga,
  cancelarTarefasDoAgendamento,
  registrarEventoDeWebhook,
} from '@barbearia/jobs';
import {
  POLITICA_SEM_SINAL,
  canCancel,
  canReschedule,
  decidirReembolso,
  localToInstant,
  minutesBetween,
  parseHHMM,
  repartirPreco,
  type ChangeDecision,
  type ChangeRefusal,
  type DecisaoDeReembolso,
  type DecisaoDeSinal,
  type MotivoDoSinal,
} from '@barbearia/core';
import { loadDayContext } from './repository.js';
import { computeFromContext } from './service.js';
import { avaliarSinalEm, conferirMarcacaoOnline, registrarRecusaOnline } from './confianca.js';
import {
  fecharEsperasAtendidas,
  quemQuerAVagaLiberada,
  vagaDoCancelamento,
  type CandidatoDaVaga,
} from './espera.js';

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
  | 'already_started'
  /** Bloco 60: score baixo não marca sozinho em hora cheia. Só a recepção. */
  | 'score_no_pico';

/** Espelha o enum `appointment_source`. Valor fora da lista quebraria o INSERT
 *  com erro de banco em vez de recusa limpa. */
export type AppointmentSource =
  | 'website' | 'app' | 'whatsapp' | 'instagram' | 'google' | 'marketplace'
  | 'reception' | 'professional' | 'api' | 'recurrence' | 'waitlist';

/**
 * Os canais em que quem marca é **a casa**, e não o cliente sozinho.
 *
 * A SPEC §2.13 escreve *"só recepção"*, e a lista existe para que um canal novo
 * nasça do lado certo: quem for acrescentado sem pensar cai no lado do cliente,
 * que é o conservador — a regra vale, e alguém repara.
 *
 * `recurrence` entra porque a recorrência foi criada por alguém do balcão uma
 * vez e se repete sozinha; recusá-la faria a série morrer no meio sem que o
 * cliente tenha feito nada. `waitlist` entra porque a vaga foi **oferecida**
 * pela casa: convidar e depois recusar é o pior desfecho possível.
 */
const PELO_BALCAO = new Set<AppointmentSource>(['reception', 'professional', 'recurrence', 'waitlist']);

/**
 * A recusa carrega o score e o limiar para o registro ser feito depois.
 *
 * Fora da transação, porque a transação voltou atrás: `registrarRecusaOnline`
 * abre a sua. Uma falha ao registrar não pode transformar uma recusa explicada
 * num erro genérico na tela de quem está com o telefone na mão.
 */
export class BookingRecusadoPorScore extends Error {
  readonly code = 'score_no_pico' as const;
  constructor(
    readonly score: number,
    readonly limiar: number,
    readonly comecaEm: Date,
  ) {
    super('Este horário só pode ser marcado pela recepção.');
    this.name = 'BookingRecusadoPorScore';
  }
}

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
  /**
   * Sinal exigido na criação, em centavos. Zero quando não foi exigido.
   *
   * Congelado aqui e não recalculado na leitura: a política da unidade e o
   * histórico do cliente mudam, e o que ele combinou de pagar não muda com
   * eles. Ler de novo faria a recepção cobrar um valor e a tela mostrar outro.
   */
  readonly depositRequiredCents: number;
  /** Por que o sinal foi exigido. Nulo quando não foi. */
  readonly depositReason: MotivoDoSinal | null;
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

  /**
   * Quem assina o clube nunca paga acréscimo, e é **aqui** que isso é decidido.
   *
   * A grade pública é anônima e mostra o preço cheio; quem grava é esta função,
   * que já sabe o cliente. É o preço dela que fica congelado em
   * `appointments.price_cents` — *"preço mostrado ao cliente é travado no
   * momento da reserva"* (SPEC §4.20).
   *
   * A leitura só acontece quando a unidade tem faixa cadastrada: sem faixa a
   * resposta não muda nada, e este é o caminho mais chamado do produto.
   */
  const assinante =
    context.faixasDePreco.length > 0 && request.customerId
      ? await clienteAssina(tx, request.customerId)
      : false;

  const availability = computeFromContext(context, {
    date: request.date,
    assinante,
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
  const base = new Map<string, number>();
  for (const service of context.services) {
    const override = professional?.overrides.get(service.id);
    durations.set(service.id, override?.durationMinutes ?? service.durationMinutes);
    base.set(service.id, override?.priceCents ?? service.priceCents);
  }

  /**
   * O ajuste da faixa desce até o item, não para no total do agendamento.
   *
   * A comanda nasce de `appointment_services` (bloco 18), então um desconto que
   * ficasse só em `appointments.price_cents` apareceria na tela do cliente e
   * sumiria na hora de pagar — e a comissão de cada serviço iria junto no erro.
   * A soma das partes é o total, ao centavo.
   */
  const totalBase = [...base.values()].reduce((soma, v) => soma + v, 0);
  const prices =
    slot.price !== undefined && slot.price !== totalBase
      ? repartirPreco(base, slot.price)
      : base;

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
 * Esta pessoa assina o clube?
 *
 * Inadimplente conta junto de ativa, como no resto do produto: o cartão que
 * falhou na terça costuma passar na quinta, e cobrar acréscimo de quem está em
 * atraso é a punição que a SPEC §4.6 manda evitar. É o mesmo predicado do termo
 * assinante do score (bloco 45) — e ele mora aqui pela mesma razão: `scheduling`
 * não depende de `finance`, e perguntar "esta pessoa assina?" é ler uma tabela,
 * não operar uma assinatura.
 */
async function clienteAssina(tx: TransactionClient, customerId: string): Promise<boolean> {
  const linhas = await tx.$queryRaw<{ assina: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM club_subscriptions s
       WHERE s.customer_id = ${customerId}::uuid
         AND s.status IN ('ativa', 'inadimplente')
    ) AS assina
  `;
  return linhas[0]?.assina === true;
}

/** O fuso da unidade, para converter a janela ocupada em dia e minutos locais. */
async function fusoDaUnidade(
  tx: TransactionClient,
  locationId: string,
): Promise<string | null> {
  const linhas = await tx.$queryRaw<{ timezone: string }[]>`
    SELECT timezone FROM locations WHERE id = ${locationId}::uuid
  `;
  return linhas[0]?.timezone ?? null;
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
      deposit_required_cents: number;
      deposit_reason: string | null;
    }[]
  >`
    SELECT id, starts_at, ends_at, service_starts_at, service_ends_at,
           professional_id, status, price_cents,
           deposit_required_cents, deposit_reason
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
    // O sinal vem gravado, não recalculado. A repetição da mesma chave é o
    // mesmo agendamento, e ele não pode passar a exigir outro valor porque o
    // histórico do cliente mudou entre os dois toques.
    depositRequiredCents: row.deposit_required_cents,
    depositReason: (row.deposit_reason as MotivoDoSinal | null) ?? null,
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
  sinal: DecisaoDeSinal,
): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO appointments (
      tenant_id, location_id, customer_id, professional_id,
      starts_at, ends_at, service_starts_at, service_ends_at,
      status, source, notes, price_cents, idempotency_key,
      deposit_required_cents, deposit_reason
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
      ${request.idempotencyKey ?? null},
      ${sinal.valorCents}, ${sinal.motivo}
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
  try {
    return await criarDentroDaTransacao(request);
  } catch (erro) {
    /**
     * O registro da recusa acontece **depois** da transação, e por isso o
     * `catch` está aqui.
     *
     * A transação voltou atrás — foi ela que recusou —, então não há onde
     * gravar de dentro. E uma falha no registro não pode virar erro genérico na
     * tela de quem está com o telefone na mão: a recusa é explicada, e é isso
     * que o cliente precisa ler.
     */
    if (erro instanceof BookingRecusadoPorScore && request.customerId) {
      try {
        await registrarRecusaOnline({
          tenantId: request.tenantId,
          locationId: request.locationId,
          customerId: request.customerId,
          score: erro.score,
          limiar: erro.limiar,
          comecaEm: erro.comecaEm,
        });
      } catch {
        // O rastro é para o dono medir a regra; perdê-lo não muda a resposta ao
        // cliente, e transformá-lo em 500 sim.
      }
    }
    throw erro;
  }
}

async function criarDentroDaTransacao(
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

    /**
     * A recusa por score, **antes** do sinal e dentro da mesma transação
     * (bloco 60, SPEC §2.13).
     *
     * Antes porque decidir o sinal de um agendamento que vai ser recusado é
     * trabalho jogado fora; dentro da transação pela mesma razão do sinal — a
     * grade de pico é derivada do movimento, e entre a leitura e o `INSERT` a
     * hora pode virar de cheia.
     *
     * `PELO_BALCAO` é o que traduz *"só recepção"* da SPEC: o canal decide, e a
     * pessoa continua sendo atendida por quem estiver no balcão.
     */
    const online = await conferirMarcacaoOnline(tx, {
      locationId: request.locationId,
      customerId: request.customerId ?? null,
      comecaEm: slot.serviceStart,
      peloBalcao: PELO_BALCAO.has(request.source ?? 'website'),
      now: request.now ?? new Date(),
    });
    if (!online.pode) {
      throw new BookingRecusadoPorScore(
        online.score,
        online.limiar,
        slot.serviceStart,
      );
    }

    // O sinal é decidido com o ticket que acabou de ser resolvido, e não com o
    // que o cliente mandou: preço vem do catálogo, como duração e buffer.
    // Aceitar o valor da requisição deixaria o cliente escolher o próprio
    // limiar de ticket e escapar do sinal informando R$ 1.
    const sinal = await avaliarSinalEm(tx, {
      tenantId: request.tenantId,
      locationId: request.locationId,
      customerId: request.customerId ?? null,
      serviceIds: request.serviceIds,
      ticketCents: slot.priceCents,
      now: request.now ?? new Date(),
    });

    let id: string;
    try {
      id = await insertAppointment(
        tx,
        { ...request, ...(storedKey ? { idempotencyKey: storedKey } : {}) },
        slot,
        sinal,
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

    /**
     * Quem conseguiu marcar sai da lista de espera (bloco 38, SPEC §2.9).
     *
     * Na mesma transação: se o horário entra, a espera fecha. Sem isto,
     * `booked` seria um estado que nada escreve — a pessoa marcaria o sábado
     * pelo site, continuaria na lista do sábado, e seria chamada para uma vaga
     * que já não quer.
     *
     * Fecha só o que **este** horário satisfaz: quem esperava a manhã e marcou
     * a tarde continua esperando a manhã.
     */
    if (request.customerId) {
      await fecharEsperasAtendidas(tx, {
        customerId: request.customerId,
        locationId: request.locationId,
        appointmentId: id,
        vaga: vagaDoCancelamento({
          timezone: (await fusoDaUnidade(tx, request.locationId)) ?? 'UTC',
          inicio: slot.occupiedStart,
          fim: slot.occupiedEnd,
          professionalId: request.professionalId,
        }),
      });
    }

    /**
     * O aviso ao sistema do cliente nasce **dentro** desta transação (bloco 79).
     *
     * Depois do commit existe a janela em que o horário foi marcado e o ERP da
     * barbearia não sabe — e é nela que o processo cai. Mesma razão da comissão,
     * da nota fiscal e do lembrete.
     *
     * O corpo carrega id e fato, nunca dado pessoal: quem quer o detalhe busca
     * na API pública, com chave e escopo. E sem endpoint cadastrado isto não
     * grava nada — que é o caso da esmagadora maioria das barbearias.
     */
    await registrarEventoDeWebhook(tx, {
      tenantId: request.tenantId,
      evento: 'appointment.created',
      objetoId: id,
      locationId: request.locationId,
      quando: request.now ?? new Date(),
    });

    return {
      id,
      startsAt: slot.occupiedStart.toISOString(),
      endsAt: slot.occupiedEnd.toISOString(),
      serviceStartsAt: slot.serviceStart.toISOString(),
      serviceEndsAt: slot.serviceEnd.toISOString(),
      professionalId: request.professionalId,
      status: 'pending',
      priceCents: slot.priceCents,
      depositRequiredCents: sinal.valorCents,
      depositReason: sinal.motivo,
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

/**
 * O que fazer com o sinal deste cancelamento.
 *
 * Devolvido pelo cancelamento porque é ali que a informação é útil: a recepção
 * precisa dizer ao cliente, na hora, se o dinheiro volta. Perguntar depois seria
 * uma segunda tela e uma segunda decisão, e as duas discordariam no dia em que
 * a barbearia mudasse o prazo entre uma e outra.
 *
 * Nulo quando não há sinal pago — que é o caso da esmagadora maioria dos
 * cancelamentos, e não merece uma frase na tela.
 */
export interface DesfechoDoSinalNoCancelamento extends DecisaoDeReembolso {
  readonly valorCents: number;
}

/**
 * O que o cancelamento deixa para trás.
 *
 * As duas coisas que a recepção precisa saber no instante em que desmarca: o
 * que fazer com o sinal, e quem quer o horário que acabou de vagar. Devolver as
 * duas juntas é o que evita a segunda tela — e a lista de espera só serve
 * **agora**, antes de outro cliente marcar pelo site.
 */
export interface DesfechoDoCancelamento {
  readonly sinal: DesfechoDoSinalNoCancelamento | null;
  readonly esperando: readonly CandidatoDaVaga[];
}

export async function cancelAppointment(
  request: CancelRequest,
): Promise<DesfechoDoCancelamento> {
  return withTenant(request.tenantId, async (tx) => {
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

    // O carimbo é o que separa quem avisou de quem avisou em cima da hora — no
    // score e no reembolso do sinal. `updated_at` não serve: qualquer edição
    // posterior o move, e o cliente que cancelou com dois dias viraria
    // cancelamento em cima da hora porque alguém corrigiu uma anotação.
    const agora = request.now ?? new Date();

    const affected = await tx.$executeRaw`
      UPDATE appointments
      SET status = ${status}::appointment_status,
          notes = COALESCE(${request.reason ?? null}, notes),
          cancelled_at = ${agora},
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

    const sinal = await decidirDestinoDoSinal(tx, request.appointmentId, request.by, agora);
    const esperando = await quemQuerAVagaLiberada(tx, request.appointmentId, agora);

    /**
     * A vaga vai à fila por prioridade (bloco 39).
     *
     * A **tarefa** entra na transação; a oferta sai fora dela. Oferecer manda
     * mensagem, e segurar a transação que desmarca o horário enquanto se espera
     * o provedor travaria a tela de quem cancelou.
     *
     * Só quando há alguém: uma tarefa por cancelamento numa barbearia sem lista
     * de espera seria trabalho para descobrir que não há trabalho.
     */
    if (esperando.length > 0) await agendarOfertaDestaVaga(tx, request.appointmentId, agora);

    return { sinal, esperando };
  });
}


/**
 * Enfileira a oferta da vaga que este cancelamento abriu.
 *
 * Dentro da transação, como todo trabalho fora de requisição neste produto: se
 * o cancelamento volta atrás, a oferta não acontece. A janela de silêncio é
 * aplicada por `agendarOfertaDaVaga`, no fuso da unidade.
 */
async function agendarOfertaDestaVaga(
  tx: TransactionClient,
  appointmentId: string,
  agora: Date,
): Promise<void> {
  const linhas = await tx.$queryRaw<
    {
      location_id: string;
      professional_id: string;
      starts_at: Date;
      ends_at: Date;
      timezone: string;
    }[]
  >`
    SELECT a.location_id, a.professional_id, a.starts_at, a.ends_at, l.timezone
      FROM appointments a
      JOIN locations l ON l.id = a.location_id
     WHERE a.id = ${appointmentId}::uuid
  `;
  const linha = linhas[0];
  if (!linha) return;

  await agendarOfertaDaVaga(tx, {
    locationId: linha.location_id,
    professionalId: linha.professional_id,
    inicio: linha.starts_at,
    fim: linha.ends_at,
    timezone: linha.timezone,
    agora,
  });
}

/**
 * Lê o sinal pago e aplica a política de reembolso da unidade.
 *
 * Roda **depois** do UPDATE e na mesma transação, de propósito: antes, o
 * agendamento ainda não tem `cancelled_at`, e a antecedência sairia de um
 * carimbo que este mesmo cancelamento acabou de escrever.
 */
async function decidirDestinoDoSinal(
  tx: TransactionClient,
  appointmentId: string,
  by: 'customer' | 'business',
  agora: Date,
): Promise<DesfechoDoSinalNoCancelamento | null> {
  const linhas = await tx.$queryRaw<
    { deposit_paid_cents: number; service_starts_at: Date; deposit_refund_hours: number }[]
  >`
    SELECT a.deposit_paid_cents, a.service_starts_at, l.deposit_refund_hours
      FROM appointments a
      JOIN locations l ON l.id = a.location_id
     WHERE a.id = ${appointmentId}::uuid
  `;
  const linha = linhas[0];
  if (!linha || linha.deposit_paid_cents <= 0) return null;

  const horas = (linha.service_starts_at.getTime() - agora.getTime()) / 3_600_000;
  const decisao = decidirReembolso({
    politica: { ...POLITICA_SEM_SINAL, horasParaReembolso: linha.deposit_refund_hours },
    quem: by === 'business' ? 'casa' : 'cliente',
    horasDeAntecedencia: horas,
  });

  return { ...decisao, valorCents: linha.deposit_paid_cents };
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
        deposit_required_cents: number;
        deposit_paid_cents: number;
        deposit_reason: string | null;
      }[]
    >`
      SELECT a.id, a.location_id, a.customer_id, a.professional_id, a.status, a.source,
             a.deposit_required_cents, a.deposit_paid_cents, a.deposit_reason,
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

    /**
     * O sinal **sai** da linha antiga na mesma instrução que a encerra.
     *
     * Um sinal pago é um só, e ele segue o agendamento. Copiá-lo para a linha
     * nova sem zerar aqui o deixaria positivo nas duas — e em três, depois de
     * duas remarcações. `devolverSinal` só exige `deposit_paid_cents > 0` e
     * recebe um id: com a linha velha ainda carregando o valor, o id do
     * primeiro e-mail de confirmação e o id do horário atual devolveriam **o
     * mesmo dinheiro duas vezes**, cada uma com sua entrada na trilha e nada
     * que as distinguisse de dois reembolsos legítimos.
     *
     * Achado da `/security-review` deste bloco.
     */
    await tx.$executeRaw`
      UPDATE appointments
         SET status = 'rescheduled', deposit_paid_cents = 0, updated_at = now()
       WHERE id = ${request.appointmentId}::uuid
    `;

    /**
     * A recusa por score vale **também na remarcação** (bloco 60).
     *
     * Sem isto, o interruptor não bloqueava nada: o cliente marcava uma hora
     * vazia, remarcava para a cheia, e ficava com ela. Dois cliques pelo caminho
     * normal da tela, sem requisição forjada — e a lista de recusas mostrava
     * "duas" enquanto as mesmas pessoas ocupavam o pico.
     *
     * O raciocínio do sinal **não** transfere. Lá existe uma decisão congelada
     * sendo carregada adiante; aqui não há nada a carregar — o controle
     * simplesmente nunca rodava. Remarcar não é marcar de novo, mas ocupar a
     * hora cheia é ocupar a hora cheia.
     *
     * `request.customerId` é o que esta função já usa para distinguir "o cliente
     * fez" de "o balcão fez" — ausente é o balcão, e o balcão remarca para quem
     * quiser.
     *
     * Achado da `/security-review` do bloco 60.
     */
    const online = await conferirMarcacaoOnline(tx, {
      locationId: appointment.location_id,
      customerId: request.customerId ?? null,
      comecaEm: slot.serviceStart,
      peloBalcao: !request.customerId || PELO_BALCAO.has(appointment.source as AppointmentSource),
      now: request.now ?? new Date(),
    });
    if (!online.pode) {
      throw new BookingRecusadoPorScore(online.score, online.limiar, slot.serviceStart);
    }

    /**
     * O sinal atravessa a remarcação inteiro, e **não** é recalculado.
     *
     * Recalcular seria errado nos dois sentidos. Se já foi pago, o novo
     * agendamento nasceria sem sinal e o dinheiro do cliente sumiria do
     * registro. Se ainda não foi, o cliente que remarca escaparia da cobrança
     * bastando remarcar uma vez — e quem mais remarca é justamente quem o sinal
     * existe para conter.
     *
     * Remarcar não é marcar de novo: é o mesmo compromisso em outro horário.
     */
    const sinal: DecisaoDeSinal = {
      exigido: appointment.deposit_required_cents > 0,
      motivo: (appointment.deposit_reason as MotivoDoSinal | null) ?? null,
      valorCents: appointment.deposit_required_cents,
    };

    let id: string;
    try {
      id = await insertAppointment(tx, target, slot, sinal);
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
      UPDATE appointments
         SET rescheduled_from = ${request.appointmentId}::uuid,
             deposit_paid_cents = ${appointment.deposit_paid_cents}
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
      depositRequiredCents: sinal.valorCents,
      depositReason: sinal.motivo,
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
  /**
   * O sinal deste horário, quando ele existe (bloco 37).
   *
   * O comprovante é a única tela que o cliente volta a abrir, e ele precisa
   * dizer que falta pagar — senão o cliente descobre no balcão, na frente de
   * outras pessoas. O **motivo** não vem: "seu histórico de faltas" é uma frase
   * sobre a pessoa, e a SPEC §2.13 regra 5 manda o score nunca chegar a ela.
   * O que ele vê é o valor e se já está pago.
   */
  readonly deposit: {
    readonly exigidoCents: number;
    readonly pagoCents: number;
  } | null;
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
        deposit_required_cents: number;
        deposit_paid_cents: number;
      }[]
    >`
      SELECT a.deposit_required_cents, a.deposit_paid_cents,
             a.id, a.service_starts_at, a.service_ends_at, a.status,
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
      deposit:
        row.deposit_required_cents > 0
          ? {
              exigidoCents: row.deposit_required_cents,
              pagoCents: row.deposit_paid_cents,
            }
          : null,
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

/**
 * O cliente confirmando presença (bloco 55).
 *
 * Nasce com o botão "Confirmar" da mensagem, e não existia antes: até aqui
 * `confirmed` era estado que só o balcão escrevia. O que ele muda é a leitura
 * do dia — a recepção vê quem respondeu — e não a grade: `pending` e `confirmed`
 * ocupam o horário igualmente, então confirmar nunca libera nem toma vaga de
 * ninguém.
 *
 * `customerId` é **obrigatório**, ao contrário do cancelamento, em que ele é
 * opcional porque a barbearia também cancela. Aqui quem confirma é sempre a
 * pessoa: a RLS separa barbearias e não separa clientes dentro de uma, e o
 * toque no botão chega por um endereço público.
 *
 * Só avança a partir de `pending`. Um horário já cancelado, atendido ou
 * remarcado não volta a `confirmed` porque alguém tocou num botão de uma
 * mensagem antiga — e a contagem de linhas é o que separa "confirmei" de "não
 * havia o que confirmar".
 */
export async function confirmAppointment(request: {
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly customerId: string;
}): Promise<boolean> {
  return withTenant(request.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE appointments
         SET status = 'confirmed', updated_at = now()
       WHERE id = ${request.appointmentId}::uuid
         AND customer_id = ${request.customerId}::uuid
         AND status = 'pending'
    `;
    return afetadas === 1;
  });
}
