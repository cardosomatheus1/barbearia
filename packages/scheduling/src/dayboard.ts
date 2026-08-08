import { withTenant } from '@barbearia/db';
import {
  allowedActions,
  canApply,
  formatHHMM,
  instantToLocal,
  punctuality,
  realDuration,
  statusAfter,
  type AppointmentStatus,
  type AttendanceAction,
  type Punctuality,
} from '@barbearia/core';

/**
 * O dia da barbearia, do ponto de vista de quem está no balcão.
 *
 * Até aqui nenhuma tela lia a agenda: o dono terminava o onboarding e abria a
 * página do cliente para adivinhar o que estava marcado. Este é o dado que essa
 * tela consome.
 *
 * O faturamento do dia **não** está aqui, e a ausência é deliberada: ele é
 * `finance.view`, que a recepção e o barbeiro não têm. Entregá-lo sob
 * `appointments.view` daria o número a todo mundo com acesso ao balcão. Ele
 * volta no bloco 18, junto com o caixa e com o segundo fator que o `CLAUDE.md`
 * exige de quem enxerga dinheiro.
 *
 * Tudo em **uma consulta**. O painel fica aberto o dia inteiro e recarrega a
 * cada poucos minutos; um laço com ida ao banco por agendamento (para pegar
 * serviços, cliente ou profissional) seria N+1 na tela mais usada do produto.
 */

export type BoardFailure =
  | 'appointment_not_found'
  | 'transition_not_allowed'
  | 'slot_taken';

export class BoardError extends Error {
  constructor(readonly code: BoardFailure, message: string) {
    super(message);
    this.name = 'BoardError';
  }
}

export interface BoardEntry {
  readonly id: string;
  readonly status: AppointmentStatus;
  /** Início do serviço no fuso da unidade, HH:mm. */
  readonly start: string;
  readonly end: string;
  readonly startsAt: string;
  readonly professionalId: string;
  readonly professionalName: string;
  readonly customerName: string | null;
  /** Só os quatro últimos dígitos: a tela do balcão fica virada para o salão. */
  readonly customerPhoneTail: string | null;
  readonly customerId: string | null;
  readonly services: readonly string[];
  readonly priceCents: number;
  /** Quanto o atendimento levou de fato. Nulo enquanto não terminou. */
  readonly realDurationMinutes: number | null;
  /** Há quanto tempo esta pessoa está esperando, em minutos. */
  readonly waitingMinutes: number | null;
  readonly punctuality: Punctuality | null;
  readonly actions: readonly AttendanceAction[];
}

export interface DayBoard {
  readonly date: string;
  readonly timezone: string;
  readonly noShowAfterMinutes: number;
  readonly professionals: readonly { readonly id: string; readonly name: string }[];
  readonly entries: readonly BoardEntry[];
  readonly totals: {
    readonly esperados: number;
    readonly chegaram: number;
    readonly atendendo: number;
    readonly concluidos: number;
    readonly faltaram: number;
    readonly cancelados: number;
  };
}

const ATIVOS: readonly AppointmentStatus[] = [
  'pending',
  'confirmed',
  'checked_in',
  'waiting',
  'in_progress',
];

/** Últimos quatro dígitos, para conferir identidade sem expor o número. */
function tail(phone: string | null): string | null {
  return phone ? phone.slice(-4) : null;
}

export async function getDayBoard(params: {
  readonly tenantId: string;
  readonly locationId: string;
  /** Data local da unidade, YYYY-MM-DD. */
  readonly date: string;
  /**
   * Recorta o dia para uma agenda só.
   *
   * Quem **não** tem `appointments.view_all_professionals` enxerga apenas a
   * própria. O recorte é na consulta e vem da sessão, nunca de parâmetro da
   * requisição: filtrar depois de ler já teria trazido o dia inteiro para a
   * memória do processo, e aceitar da requisição seria pedir ao barbeiro que
   * escolhesse o que ele pode ver.
   */
  readonly onlyProfessionalId?: string | null;
  readonly now?: Date;
}): Promise<DayBoard> {
  const now = params.now ?? new Date();

  return withTenant(params.tenantId, async (tx) => {
    const unidades = await tx.$queryRaw<
      { timezone: string; no_show_after_minutes: number }[]
    >`
      SELECT timezone, no_show_after_minutes FROM locations
      WHERE id = ${params.locationId}::uuid
    `;
    const unidade = unidades[0];
    if (!unidade) {
      return {
        date: params.date,
        timezone: 'UTC',
        noShowAfterMinutes: 0,
        professionals: [],
        entries: [],
        totals: {
          esperados: 0, chegaram: 0, atendendo: 0, concluidos: 0,
          faltaram: 0, cancelados: 0,
        },
      };
    }

    const equipe = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM professionals
      WHERE location_id = ${params.locationId}::uuid AND active
        AND (${params.onlyProfessionalId ?? null}::uuid IS NULL
             OR id = ${params.onlyProfessionalId ?? null}::uuid)
      ORDER BY name
    `;

    // A faixa é o dia local convertido para instante. Comparar `date` com uma
    // coluna `timestamptz` no fuso do servidor traria o dia errado sempre que o
    // servidor não estiver no fuso da barbearia — que é o caso normal.
    const linhas = await tx.$queryRaw<
      {
        id: string;
        status: AppointmentStatus;
        service_starts_at: Date;
        service_ends_at: Date;
        professional_id: string;
        professional_name: string;
        customer_id: string | null;
        customer_name: string | null;
        customer_phone: string | null;
        services: string[];
        price_cents: number;
        checked_in_at: Date | null;
        started_at: Date | null;
        completed_at: Date | null;
      }[]
    >`
      SELECT a.id, a.status, a.service_starts_at, a.service_ends_at,
             a.professional_id, p.name AS professional_name,
             a.customer_id, c.name AS customer_name, c.phone_e164 AS customer_phone,
             array_agg(s.name ORDER BY aps.position) AS services,
             a.price_cents, a.checked_in_at, a.started_at, a.completed_at
      FROM appointments a
      JOIN professionals p ON p.id = a.professional_id
      LEFT JOIN customers c ON c.id = a.customer_id
      JOIN appointment_services aps ON aps.appointment_id = a.id
      JOIN services s ON s.id = aps.service_id
      WHERE a.location_id = ${params.locationId}::uuid
        AND (${params.onlyProfessionalId ?? null}::uuid IS NULL
             OR a.professional_id = ${params.onlyProfessionalId ?? null}::uuid)
        AND a.service_starts_at >= (${params.date}::date::timestamp AT TIME ZONE ${unidade.timezone})
        AND a.service_starts_at < ((${params.date}::date + 1)::timestamp AT TIME ZONE ${unidade.timezone})
      GROUP BY a.id, p.name, c.name, c.phone_e164
      ORDER BY a.service_starts_at, p.name
    `;

    const entries: BoardEntry[] = linhas.map((linha) => {
      const minutosDesdeInicio = Math.floor(
        (now.getTime() - linha.service_starts_at.getTime()) / 60000,
      );
      const ativo = ATIVOS.includes(linha.status);
      const aguardando = linha.status === 'checked_in' || linha.status === 'waiting';

      return {
        id: linha.id,
        status: linha.status,
        start: formatHHMM(instantToLocal(unidade.timezone, linha.service_starts_at).minutes),
        end: formatHHMM(instantToLocal(unidade.timezone, linha.service_ends_at).minutes),
        startsAt: linha.service_starts_at.toISOString(),
        professionalId: linha.professional_id,
        professionalName: linha.professional_name,
        customerName: linha.customer_name,
        customerPhoneTail: tail(linha.customer_phone),
        customerId: linha.customer_id,
        services: linha.services,
        priceCents: linha.price_cents,
        realDurationMinutes: realDuration(linha.started_at, linha.completed_at),
        waitingMinutes:
          aguardando && linha.checked_in_at
            ? Math.floor((now.getTime() - linha.checked_in_at.getTime()) / 60000)
            : null,
        // Só quem ainda não chegou tem pontualidade: depois do check-in a
        // pergunta deixa de ser "cadê" e passa a ser "há quanto tempo espera".
        punctuality:
          ativo && !aguardando && linha.status !== 'in_progress'
            ? punctuality(minutosDesdeInicio, unidade.no_show_after_minutes)
            : null,
        actions: allowedActions(linha.status),
      };
    });

    const conta = (predicado: (e: BoardEntry) => boolean): number =>
      entries.filter(predicado).length;

    return {
      date: params.date,
      timezone: unidade.timezone,
      noShowAfterMinutes: unidade.no_show_after_minutes,
      professionals: equipe,
      entries,
      totals: {
        esperados: conta((e) => ATIVOS.includes(e.status)),
        chegaram: conta((e) => e.status === 'checked_in' || e.status === 'waiting'),
        atendendo: conta((e) => e.status === 'in_progress'),
        concluidos: conta((e) => e.status === 'completed'),
        faltaram: conta((e) => e.status === 'no_show'),
        cancelados: conta(
          (e) => e.status === 'cancelled_customer' || e.status === 'cancelled_business',
        ),
      },
    };
  });
}

const CARIMBO: Partial<Record<AttendanceAction, 'checked_in_at' | 'started_at' | 'completed_at'>> = {
  check_in: 'checked_in_at',
  start: 'started_at',
  complete: 'completed_at',
};

const EXCLUSION_VIOLATION = '23P01';

function pgCode(error: unknown): string | null {
  const meta = (error as { meta?: { code?: unknown } })?.meta;
  if (typeof meta?.code === 'string') return meta.code;
  const message = error instanceof Error ? error.message : '';
  return /Code: `(\w+)`/.exec(message)?.[1] ?? null;
}

/**
 * Move um atendimento de estado, pelo balcão.
 *
 * Lê o estado atual e decide na mesma transação: entre ler e escrever, duas
 * pessoas no balcão podem tocar o mesmo cartão, e a segunda não pode desfazer o
 * que a primeira fez.
 *
 * Sem `customerId` de propósito — quem opera é a barbearia, e a janela de
 * antecedência que vale para o cliente não vale aqui: a recepção precisa
 * cancelar em cima da hora quando o barbeiro adoece.
 */
export async function applyAttendance(params: {
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly action: AttendanceAction;
  /**
   * Restringe a uma agenda só, pela mesma razão de `getDayBoard`.
   *
   * Sem isto, quem enxerga apenas a própria agenda ainda conseguia marcar falta
   * no cliente do colega — bastava ter o id, e a lista de ontem já o dava.
   */
  readonly onlyProfessionalId?: string | null;
  readonly now?: Date;
}): Promise<{ readonly status: AppointmentStatus }> {
  const now = params.now ?? new Date();

  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ status: AppointmentStatus }[]>`
      SELECT status FROM appointments
      WHERE id = ${params.appointmentId}::uuid
        AND (${params.onlyProfessionalId ?? null}::uuid IS NULL
             OR professional_id = ${params.onlyProfessionalId ?? null}::uuid)
      FOR UPDATE
    `;
    const atual = linhas[0];
    if (!atual) {
      throw new BoardError('appointment_not_found', 'Agendamento não encontrado');
    }

    if (!canApply(atual.status, params.action)) {
      throw new BoardError(
        'transition_not_allowed',
        'Este atendimento já mudou de estado. Atualize a tela.',
      );
    }

    const destino = statusAfter(params.action);
    const carimbo = CARIMBO[params.action];

    try {
      await tx.$executeRaw`
        UPDATE appointments
        SET status = ${destino}::appointment_status,
            checked_in_at = CASE WHEN ${carimbo === 'checked_in_at'} THEN ${now}
                                 ELSE checked_in_at END,
            started_at    = CASE WHEN ${carimbo === 'started_at'} THEN ${now}
                                 ELSE started_at END,
            completed_at  = CASE WHEN ${carimbo === 'completed_at'} THEN ${now}
                                 ELSE completed_at END,
            updated_at = now()
        WHERE id = ${params.appointmentId}::uuid
      `;
    } catch (error) {
      // Desfazer uma falta devolve o horário à constraint de exclusão, que o
      // ignorava enquanto era `no_show`. Se a vaga já foi dada a outro cliente,
      // o banco recusa — e é bom que recuse, senão a barbearia teria dois
      // clientes no mesmo horário por causa de um toque.
      if (pgCode(error) === EXCLUSION_VIOLATION) {
        throw new BoardError(
          'slot_taken',
          'Este horário já foi dado a outro cliente. Marque um novo.',
        );
      }
      throw error;
    }

    return { status: destino };
  });
}

/**
 * A unidade da barbearia e o dia que é **nela** agora.
 *
 * O balcão nunca informa qual unidade opera: ele opera a sua. E o dia que a
 * tela abre é o da barbearia, não o do notebook — um atendente que viaja, ou um
 * navegador com relógio errado, abriria a agenda do dia errado (defeito D2).
 *
 * Multiunidade entra no bloco 58; até lá a unidade primária é a mais antiga.
 */
export async function primaryLocation(
  tenantId: string,
  now: Date = new Date(),
): Promise<{ readonly id: string; readonly timezone: string; readonly today: string } | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string; timezone: string }[]>`
      SELECT id, timezone FROM locations ORDER BY created_at LIMIT 1
    `;
    const linha = linhas[0];
    if (!linha) return null;
    return {
      id: linha.id,
      timezone: linha.timezone,
      today: instantToLocal(linha.timezone, now).date,
    };
  });
}
