import { withTenant } from '@barbearia/db';
import {
  canCancel,
  canReschedule,
  ESTADOS_ANTES_DO_ATENDIMENTO,
  ESTADOS_EM_CURSO,
  minutesBetween,
  type ChangeRefusal,
} from '@barbearia/core';


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
      const active = (ESTADOS_ANTES_DO_ATENDIMENTO as readonly string[]).includes(row.status);
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
        /**
         * O prazo é o **da recusa que apareceu**, não o de cancelar sempre.
         *
         * A tela escreve "só até N horas antes" ao lado de `blockedReason`, e a
         * recusa pode vir da janela de remarcação — que a barbearia costuma
         * deixar mais folgada, porque remarcar preserva a receita e cancelar
         * não. Citando o prazo de cancelar, o cliente lia "remarque com até 2
         * horas" numa casa que exige 6, tentava às 3 e era recusado de novo.
         *
         * `canReschedule` já devolve o próprio `minHours`; ele estava sendo
         * descartado.
         */
        minHoursToChange:
          refused && !refused.allowed ? refused.minHours : row.cancel_min_hours,
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
 * `ESTADOS_EM_CURSO`, e não `ESTADOS_ANTES_DO_ATENDIMENTO`: aquele responde "ainda
 * dá para cancelar?" e por isso deixa `in_progress` de fora. Aqui a pergunta é
 * "esse horário ainda vale?", e um corte em andamento vale.
 *
 * A distinção estava certa e o conjunto estava escrito à mão. Agora as duas
 * perguntas têm cada uma a sua constante no domínio, e um estado novo entra nas
 * duas — ou em nenhuma — pela mesma derivação.
 */
const RECEIPT_ACTIVE: readonly string[] = ESTADOS_EM_CURSO;

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
        AND a.status = ANY(${[...ESTADOS_ANTES_DO_ATENDIMENTO]}::appointment_status[])
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
