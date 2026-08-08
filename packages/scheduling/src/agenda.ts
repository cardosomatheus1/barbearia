import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  conflitaComExcecao,
  formatHHMM,
  instantToLocal,
  localToInstant,
  validarExcecao,
  type AppointmentStatus,
  type TipoDeExcecao,
} from '@barbearia/core';

/**
 * A agenda do admin: o intervalo inteiro numa consulta, e a escrita das
 * exceções que o motor sempre soube ler.
 *
 * Duas coisas moram aqui porque são a mesma tela. O que a recepção faz ao ver
 * um buraco é bloqueá-lo; o que ela faz ao ver um conflito é mover. Separar em
 * dois módulos obrigaria a tela a costurar o que o domínio já entende junto.
 *
 * **Uma consulta por tipo de coisa, nunca por dia.** A semana são sete dias
 * vezes N profissionais; um laço com ida ao banco por dia seria N+1 na tela que
 * o gestor abre para planejar.
 */

export type AgendaFailure =
  | 'appointment_not_found'
  | 'exception_not_found'
  | 'invalid_exception'
  | 'unknown_professional'
  | 'kind_not_allowed';

export class AgendaError extends Error {
  constructor(
    readonly code: AgendaFailure,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'AgendaError';
  }
}

/** Teto do intervalo pedido. Sem ele, `from=2020&to=2030` varre a base. */
export const MAX_DIAS_DA_AGENDA = 31;

export interface AgendaEntry {
  readonly id: string;
  readonly professionalId: string;
  readonly status: AppointmentStatus;
  /** Início visível ao cliente, HH:mm no fuso da unidade. */
  readonly start: string;
  readonly end: string;
  /**
   * Janela ocupada, com buffers. A SPEC §2.14 pede o buffer renderizado
   * distinto da execução: é ele que explica por que o horário seguinte não
   * está livre mesmo o corte tendo acabado.
   */
  readonly occupiedStart: string;
  readonly occupiedEnd: string;
  readonly customerName: string | null;
  readonly services: readonly string[];
  readonly priceCents: number;
}

export interface AgendaException {
  readonly id: string;
  readonly kind: TipoDeExcecao;
  /** `null` quando vale para a unidade inteira. */
  readonly professionalId: string | null;
  /** `null` em exceção de dia inteiro. */
  readonly start: string | null;
  readonly end: string | null;
  readonly reason: string | null;
}

export interface AgendaDay {
  readonly date: string;
  readonly weekday: number;
  readonly entries: readonly AgendaEntry[];
  readonly exceptions: readonly AgendaException[];
}

export interface Agenda {
  readonly timezone: string;
  readonly from: string;
  readonly to: string;
  readonly professionals: readonly { readonly id: string; readonly name: string }[];
  readonly days: readonly AgendaDay[];
}

/** Status que ocupam espaço na grade. Cancelado e falta deixam de ocupar. */
const OCUPAM: readonly string[] = ['pending', 'confirmed', 'checked_in', 'waiting', 'in_progress'];

function diasEntre(from: string, to: string): string[] {
  const dias: string[] = [];
  const fim = new Date(`${to}T12:00:00Z`);
  for (
    let dia = new Date(`${from}T12:00:00Z`);
    dia <= fim && dias.length <= MAX_DIAS_DA_AGENDA;
    dia.setUTCDate(dia.getUTCDate() + 1)
  ) {
    dias.push(dia.toISOString().slice(0, 10));
  }
  return dias;
}

const hhmm = (timezone: string, quando: Date): string =>
  formatHHMM(instantToLocal(timezone, quando).minutes);

/**
 * A agenda de um intervalo.
 *
 * Três consultas: profissionais, agendamentos e exceções. O agrupamento por dia
 * acontece em memória sobre dados já carregados — o contrário seria uma ida ao
 * banco por dia da semana.
 */
export async function getAgenda(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly timezone: string;
  readonly from: string;
  readonly to: string;
  /** Recorte de permissão: quem não vê a casa toda passa o próprio id. */
  readonly onlyProfessionalId?: string | null;
}): Promise<Agenda> {
  const dias = diasEntre(params.from, params.to);
  if (dias.length === 0 || dias.length > MAX_DIAS_DA_AGENDA) {
    throw new RangeError(`Intervalo inválido (máximo ${MAX_DIAS_DA_AGENDA} dias)`);
  }

  const primeiro = dias[0] ?? params.from;
  const ultimo = dias[dias.length - 1] ?? params.to;
  const recorte = params.onlyProfessionalId ?? null;

  return withTenant(params.tenantId, async (tx) => {
    const profissionais = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM professionals
       WHERE location_id = ${params.locationId}::uuid
         AND active
         AND (${recorte}::uuid IS NULL OR id = ${recorte}::uuid)
       ORDER BY name
    `;

    const linhas = await tx.$queryRaw<
      {
        id: string;
        professional_id: string;
        status: AppointmentStatus;
        starts_at: Date;
        ends_at: Date;
        service_starts_at: Date;
        service_ends_at: Date;
        customer_name: string | null;
        service_names: string[] | null;
        price_cents: number;
      }[]
    >`
      SELECT a.id, a.professional_id, a.status,
             a.starts_at, a.ends_at, a.service_starts_at, a.service_ends_at,
             c.name AS customer_name, a.price_cents,
             (SELECT array_agg(s.name ORDER BY aps.position)
                FROM appointment_services aps
                JOIN services s ON s.id = aps.service_id
               WHERE aps.appointment_id = a.id) AS service_names
        FROM appointments a
        JOIN professionals p ON p.id = a.professional_id
        LEFT JOIN customers c ON c.id = a.customer_id
       WHERE p.location_id = ${params.locationId}::uuid
         AND (${recorte}::uuid IS NULL OR a.professional_id = ${recorte}::uuid)
         AND a.status = ANY(${[...OCUPAM]}::appointment_status[])
         AND a.service_starts_at >= ${localMeiaNoite(params.timezone, primeiro)}
         AND a.service_starts_at < ${localMeiaNoite(params.timezone, ultimo, 1)}
       ORDER BY a.service_starts_at
    `;

    const excecoes = await tx.$queryRaw<
      {
        id: string;
        kind: TipoDeExcecao;
        professional_id: string | null;
        location_id: string | null;
        on_date: Date;
        start_minute: number | null;
        end_minute: number | null;
        reason: string | null;
      }[]
    >`
      SELECT e.id, e.kind, e.professional_id, e.location_id, e.on_date,
             e.start_minute, e.end_minute, e.reason
        FROM schedule_exceptions e
        LEFT JOIN professionals p ON p.id = e.professional_id
       WHERE e.on_date >= ${primeiro}::date
         AND e.on_date <= ${ultimo}::date
         AND (e.location_id = ${params.locationId}::uuid
              OR p.location_id = ${params.locationId}::uuid)
       ORDER BY e.on_date, e.start_minute NULLS FIRST
    `;

    const porDia = new Map<string, AgendaEntry[]>();
    for (const linha of linhas) {
      const data = instantToLocal(params.timezone, linha.service_starts_at).date;
      const doDia = porDia.get(data) ?? [];
      doDia.push({
        id: linha.id,
        professionalId: linha.professional_id,
        status: linha.status,
        start: hhmm(params.timezone, linha.service_starts_at),
        end: hhmm(params.timezone, linha.service_ends_at),
        occupiedStart: hhmm(params.timezone, linha.starts_at),
        occupiedEnd: hhmm(params.timezone, linha.ends_at),
        customerName: linha.customer_name,
        services: linha.service_names ?? [],
        priceCents: linha.price_cents,
      });
      porDia.set(data, doDia);
    }

    const excecoesPorDia = new Map<string, AgendaException[]>();
    for (const linha of excecoes) {
      const data = linha.on_date.toISOString().slice(0, 10);
      const doDia = excecoesPorDia.get(data) ?? [];
      doDia.push({
        id: linha.id,
        kind: linha.kind,
        professionalId: linha.professional_id,
        start: linha.start_minute === null ? null : formatHHMM(linha.start_minute),
        end: linha.end_minute === null ? null : formatHHMM(linha.end_minute),
        reason: linha.reason,
      });
      excecoesPorDia.set(data, doDia);
    }

    return {
      timezone: params.timezone,
      from: primeiro,
      to: ultimo,
      professionals: profissionais,
      days: dias.map((date) => ({
        date,
        weekday: new Date(`${date}T12:00:00Z`).getUTCDay(),
        entries: porDia.get(date) ?? [],
        exceptions: excecoesPorDia.get(date) ?? [],
      })),
    };
  });
}

/**
 * Meia-noite local da unidade, como instante.
 *
 * O recorte da consulta é por instante e a agenda é por **dia da barbearia**.
 * Comparar `service_starts_at` com a data crua traria o dia do servidor — que
 * pode estar em UTC —, e em América/Bahia isso desloca a agenda em três horas:
 * o corte das 22h de terça apareceria na quarta.
 *
 * A conversão é a de `core/zone.ts`, que já trata horário de verão e é testada
 * sob `TZ=UTC` e `TZ=Asia/Tokyo`. Recalculá-la aqui seria a terceira cópia da
 * mesma aritmética, e a primeira a errar.
 */
function localMeiaNoite(timezone: string, data: string, somaDias = 0): Date {
  const base = new Date(`${data}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + somaDias);
  return localToInstant(timezone, base.toISOString().slice(0, 10), 0);
}

// -- Exceções: a escrita que faltava ------------------------------------------

export interface ForaDaExcecao {
  readonly appointmentId: string;
  readonly start: string;
  readonly customerName: string | null;
  readonly professionalName: string;
}

/**
 * Quem já está marcado dentro do que se quer bloquear.
 *
 * Roda **antes** de gravar e não impede nada: bloquear as 14h de sexta com três
 * clientes marcados ali é operação legítima — o dentista existe —, mas fazê-lo
 * sem ver os nomes é como o cliente descobre no dia. Mesmo desenho de dois
 * tempos da jornada: a primeira chamada devolve a lista e não grava.
 */
async function conflitosDaExcecao(
  tx: TransactionClient,
  params: {
    readonly timezone: string;
    readonly locationId: string;
    readonly data: string;
    readonly startMinute: number | null;
    readonly endMinute: number | null;
    readonly professionalId: string | null;
    /**
     * Recorte de permissão de quem pediu.
     *
     * Sem ele esta função vira oráculo: a primeira chamada devolve os conflitos
     * e **não grava**, então quem só enxerga a própria agenda pedia um bloqueio
     * do dia inteiro e recebia de volta o livro da casa — nome de cliente, hora
     * e id de todo mundo. É a mesma fronteira que `applyAttendance` respeita.
     */
    readonly onlyProfessionalId: string | null;
  },
): Promise<ForaDaExcecao[]> {
  const linhas = await tx.$queryRaw<
    {
      id: string;
      service_starts_at: Date;
      service_ends_at: Date;
      customer_name: string | null;
      professional_name: string;
    }[]
  >`
    SELECT a.id, a.service_starts_at, a.service_ends_at,
           c.name AS customer_name, p.name AS professional_name
      FROM appointments a
      JOIN professionals p ON p.id = a.professional_id
      LEFT JOIN customers c ON c.id = a.customer_id
     WHERE p.location_id = ${params.locationId}::uuid
       AND a.status = ANY(${[...OCUPAM]}::appointment_status[])
       AND a.service_starts_at >= ${localMeiaNoite(params.timezone, params.data)}
       AND a.service_starts_at < ${localMeiaNoite(params.timezone, params.data, 1)}
       AND (${params.professionalId}::uuid IS NULL
            OR a.professional_id = ${params.professionalId}::uuid)
       AND (${params.onlyProfessionalId}::uuid IS NULL
            OR a.professional_id = ${params.onlyProfessionalId}::uuid)
     ORDER BY a.service_starts_at
  `;

  return linhas
    .filter((linha) =>
      conflitaComExcecao({
        agendamento: {
          startMinute: instantToLocal(params.timezone, linha.service_starts_at).minutes,
          endMinute: instantToLocal(params.timezone, linha.service_ends_at).minutes,
        },
        excecao: { startMinute: params.startMinute, endMinute: params.endMinute },
      }),
    )
    .map((linha) => ({
      appointmentId: linha.id,
      start: hhmm(params.timezone, linha.service_starts_at),
      customerName: linha.customer_name,
      professionalName: linha.professional_name,
    }));
}

export interface NovaExcecao {
  readonly tenantId: string;
  readonly locationId: string;
  readonly timezone: string;
  readonly kind: TipoDeExcecao;
  readonly date: string;
  readonly startMinute?: number | null;
  readonly endMinute?: number | null;
  /** `null` vale para a unidade inteira. */
  readonly professionalId?: string | null;
  readonly reason?: string | null;
  /** Grava mesmo com gente marcada dentro. */
  readonly confirmarConflitos?: boolean;
  /** Recorte de permissão de quem pediu. Ver `conflitosDaExcecao`. */
  readonly onlyProfessionalId?: string | null;
}

/**
 * Cria a exceção — e é a primeira escrita que essa tabela recebe.
 *
 * Sem ela, `schedule_exceptions` era um campo que o motor aceitava e ninguém
 * preenchia: o barbeiro não tinha como avisar que ia faltar na sexta, e a
 * barbearia não tinha como fechar no feriado. Oito blocos de motor com teste
 * verde e nenhuma porta de entrada.
 */
export async function createException(
  params: NovaExcecao,
): Promise<
  | { readonly saved: true; readonly id: string; readonly conflitos: readonly ForaDaExcecao[] }
  | { readonly saved: false; readonly conflitos: readonly ForaDaExcecao[] }
> {
  const alvoProfissional = params.professionalId ?? null;

  const falha = validarExcecao({
    tipo: params.kind,
    data: params.date,
    startMinute: params.startMinute ?? null,
    endMinute: params.endMinute ?? null,
    professionalId: alvoProfissional,
    // O alvo é exclusivo: quem não informa profissional está falando da unidade.
    locationId: alvoProfissional ? null : params.locationId,
  });
  if (falha) throw new AgendaError('invalid_exception', 'Exceção inválida.', falha);

  return withTenant(params.tenantId, async (tx) => {
    if (alvoProfissional) {
      // A chave estrangeira do Postgres ignora row security por definição — sem
      // esta conferência, um id de outra barbearia entraria sem erro.
      const pro = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM professionals
         WHERE id = ${alvoProfissional}::uuid AND location_id = ${params.locationId}::uuid
      `;
      if (!pro[0]) throw new AgendaError('unknown_professional', 'Profissional não encontrado.');
    }

    const conflitos = await conflitosDaExcecao(tx, {
      timezone: params.timezone,
      locationId: params.locationId,
      data: params.date,
      startMinute: params.startMinute ?? null,
      endMinute: params.endMinute ?? null,
      professionalId: alvoProfissional,
      onlyProfessionalId: params.onlyProfessionalId ?? null,
    });

    if (conflitos.length > 0 && !params.confirmarConflitos) {
      return { saved: false, conflitos };
    }

    const criada = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO schedule_exceptions
        (tenant_id, professional_id, location_id, on_date, kind,
         start_minute, end_minute, reason)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${alvoProfissional}::uuid,
        ${alvoProfissional ? null : params.locationId}::uuid,
        ${params.date}::date,
        ${params.kind}::schedule_exception_type,
        ${params.startMinute ?? null}, ${params.endMinute ?? null},
        ${params.reason ?? null}
      )
      RETURNING id
    `;

    const id = criada[0]?.id;
    if (!id) throw new AgendaError('invalid_exception', 'Não foi possível criar a exceção.');
    return { saved: true, id, conflitos };
  });
}

/**
 * Remove a exceção.
 *
 * Apagar é certo aqui, ao contrário de serviço e profissional: uma exceção não
 * é apontada por nada — nenhum agendamento guarda "aconteceu apesar do
 * bloqueio". Desativá-la deixaria linha morta que a grade teria que aprender a
 * ignorar.
 */
export async function deleteException(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly exceptionId: string;
  /**
   * Quem só pode criar bloqueio também só pode apagar bloqueio.
   *
   * Sem isto a permissão fica assimétrica e a assimetria **é** a escalada: a
   * recepcionista não consegue criar um feriado, mas apagaria o que o dono
   * criou — reabrindo a barbearia no dia em que ela deveria estar fechada, sem
   * precisar de nenhuma permissão a mais.
   *
   * A guarda da rota é estática e declara o piso; a distinção por tipo só
   * existe depois de ler a linha, e por isso mora aqui e não no decorador.
   */
  readonly somenteBloqueio?: boolean;
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string; kind: TipoDeExcecao }[]>`
      SELECT e.id, e.kind
        FROM schedule_exceptions e
        LEFT JOIN professionals p ON p.id = e.professional_id
       WHERE e.id = ${params.exceptionId}::uuid
         AND (e.location_id = ${params.locationId}::uuid
              OR p.location_id = ${params.locationId}::uuid)
    `;
    const excecao = linhas[0];
    if (!excecao) {
      throw new AgendaError('exception_not_found', 'Esta exceção não existe mais.');
    }

    if (params.somenteBloqueio && excecao.kind !== 'block') {
      throw new AgendaError(
        'kind_not_allowed',
        'Folga, férias e feriado só podem ser removidos por quem administra a barbearia.',
      );
    }

    await tx.$executeRaw`
      DELETE FROM schedule_exceptions WHERE id = ${params.exceptionId}::uuid
    `;
  });
}
