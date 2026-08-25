import { withTenant, type TransactionClient } from '@barbearia/db';
import { travarDiaDaAgenda } from './concorrencia.js';
import {
  conflitaComExcecao,
  formatHHMM,
  instantToLocal,
  localToInstant,
  resolveWorkingDay,
  validarExcecao,
  type AppointmentStatus,
  type TipoDeExcecao,
  type ScheduleException,
  type TimeRange,
  type WeeklyPlan,
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
  /** Mexer na agenda de outra cadeira, ou na da casa, sem enxergá-la. */
  | 'fora_do_alcance'
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

export interface AgendaWorkingDay {
  readonly professionalId: string;
  /** Jornada efetiva depois de folga/feriado/horário especial e bloqueios. */
  readonly working: readonly { readonly start: string; readonly end: string }[];
  /** Pausas cadastradas, recortadas para dentro da jornada efetiva. */
  readonly breaks: readonly { readonly start: string; readonly end: string }[];
  readonly closedBy: 'custom_hours' | 'day_off' | 'holiday' | 'vacation' | 'no_weekly_plan' | null;
}

export interface AgendaDay {
  readonly date: string;
  readonly weekday: number;
  readonly entries: readonly AgendaEntry[];
  readonly exceptions: readonly AgendaException[];
  /** A régua visual da agenda usa esta jornada; nunca adivinha abertura pela primeira reserva. */
  readonly workingDays: readonly AgendaWorkingDay[];
}

export interface Agenda {
  readonly timezone: string;
  readonly from: string;
  readonly to: string;
  readonly professionals: readonly { readonly id: string; readonly name: string }[];
  readonly days: readonly AgendaDay[];
}

/**
 * Status que ocupam espaço na grade — e `completed` é um deles.
 *
 * O comentário anterior dizia "cancelado e falta deixam de ocupar", e estava
 * certo sobre esses dois. O que ninguém decidiu foi o `completed`, que saiu
 * junto: a partir daí a grade **apagava o que já tinha sido atendido**.
 *
 * O efeito é o pior possível numa tela de planejamento. Às quatro da tarde de um
 * sábado, a aba Agenda vai esvaziando conforme os cortes são encerrados, o
 * contador por cadeira desconta cada um, e no fim do dia todas marcam zero. Um
 * dia passado abre sempre vazio. E `/admin/dia` do mesmo dia diz "1 atendido"
 * enquanto `/admin/agenda` diz "Nada marcado" — §6 pergunta 6, sobre o mesmo
 * fato, no mesmo instante.
 *
 * O horário nunca esteve livre de verdade: `TERMINAL_STATUSES`, que é quem o
 * motor de disponibilidade consulta, mantém `completed` ocupando, e a constraint
 * anti-overbooking também. Então a grade desenhava livre o que o motor recusa —
 * não vira overbooking, vira tela mentindo.
 *
 * A própria tela acreditava que ele aparecia: o comentário de
 * `apps/web/src/app/admin/agenda/page.tsx` descreve o cartão de "Atendido" e o
 * que ele oferece, sobre um cartão que a consulta nunca produzia.
 *
 * `no_show` continua fora: falta libera o horário de verdade — desfazê-la passa
 * pela constraint de novo, e é por isso que ela pode ser recusada.
 */
const OCUPAM: readonly string[] = [
  'pending',
  'confirmed',
  'checked_in',
  'waiting',
  'in_progress',
  'completed',
];

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
  /**
   * Quem pode ver identidade de cliente — obrigatório, como no painel do dia.
   *
   * A agenda traz `customerName` em toda linha e aceita janela de trinta dias:
   * medido no banco de demonstração, um papel com `appointments.view` mais
   * `appointments.view_all_professionals` colhia 577 dos 631 clientes por nome,
   * enquanto a rota de busca de clientes respondia 403.
   *
   * Redigir e não recusar, pelo precedente de `applyAttendance` — `@Exige` é
   * conjuntivo e trancaria quem só atende para fora da própria agenda.
   */
  readonly podeVerCliente: boolean;
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

    const professionalIds = profissionais.map((p) => p.id);
    const weekdays = [...new Set(dias.map((date) => new Date(`${date}T12:00:00Z`).getUTCDay()))];
    const jornadas = professionalIds.length === 0
      ? []
      : await tx.$queryRaw<
          {
            professional_id: string;
            weekday: number;
            start_minute: number;
            end_minute: number;
            breaks: unknown;
          }[]
        >`
          SELECT professional_id, weekday, start_minute, end_minute, breaks
            FROM work_schedules
           WHERE professional_id = ANY(${professionalIds}::uuid[])
             AND weekday = ANY(${weekdays}::smallint[])
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
        customerName: params.podeVerCliente ? linha.customer_name : null,
        services: linha.service_names ?? [],
        priceCents: linha.price_cents,
      });
      porDia.set(data, doDia);
    }

    const excecoesPorDia = new Map<string, AgendaException[]>();
    const planosPorProfissional = new Map<string, WeeklyPlan[]>();
    for (const linha of jornadas) {
      const pausas = Array.isArray(linha.breaks)
        ? (linha.breaks as TimeRange[]).filter(
            (item) => typeof item?.start === 'number' && typeof item?.end === 'number',
          )
        : [];
      const planos = planosPorProfissional.get(linha.professional_id) ?? [];
      planos.push({
        weekday: linha.weekday,
        start: linha.start_minute,
        end: linha.end_minute,
        breaks: pausas,
      });
      planosPorProfissional.set(linha.professional_id, planos);
    }

    const regrasDaUnidade = new Map<string, ScheduleException[]>();
    const regrasDoProfissional = new Map<string, ScheduleException[]>();
    const bloqueiosDaUnidade = new Map<string, TimeRange[]>();
    const bloqueiosDoProfissional = new Map<string, TimeRange[]>();

    const adicionar = <T,>(mapa: Map<string, T[]>, chave: string, item: T) => {
      const lista = mapa.get(chave) ?? [];
      lista.push(item);
      mapa.set(chave, lista);
    };

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

      if (linha.kind === 'block') {
        if (linha.start_minute === null || linha.end_minute === null) continue;
        const faixa = { start: linha.start_minute, end: linha.end_minute };
        if (linha.professional_id)
          adicionar(bloqueiosDoProfissional, `${data}|${linha.professional_id}`, faixa);
        else adicionar(bloqueiosDaUnidade, data, faixa);
        continue;
      }

      const regra: ScheduleException = {
        kind: linha.kind,
        scope: linha.professional_id ? 'professional' : 'location',
        ...(linha.start_minute !== null ? { start: linha.start_minute } : {}),
        ...(linha.end_minute !== null ? { end: linha.end_minute } : {}),
        ...(linha.reason !== null ? { reason: linha.reason } : {}),
      };
      if (linha.professional_id)
        adicionar(regrasDoProfissional, `${data}|${linha.professional_id}`, regra);
      else adicionar(regrasDaUnidade, data, regra);
    }

    const jornadaDoDia = (date: string, weekday: number): AgendaWorkingDay[] =>
      profissionais.map((profissional) => {
        const resolvida = resolveWorkingDay({
          weekday,
          weeklyPlans: planosPorProfissional.get(profissional.id) ?? [],
          exceptions: [
            ...(regrasDaUnidade.get(date) ?? []),
            ...(regrasDoProfissional.get(`${date}|${profissional.id}`) ?? []),
          ],
          blocks: [
            ...(bloqueiosDaUnidade.get(date) ?? []),
            ...(bloqueiosDoProfissional.get(`${date}|${profissional.id}`) ?? []),
          ],
        });
        const texto = (faixa: TimeRange) => ({
          start: formatHHMM(faixa.start),
          end: formatHHMM(faixa.end),
        });
        return {
          professionalId: profissional.id,
          working: resolvida.working.map(texto),
          breaks: resolvida.breaks.map(texto),
          closedBy: resolvida.closedBy,
        };
      });

    return {
      timezone: params.timezone,
      from: primeiro,
      to: ultimo,
      professionals: profissionais,
      days: dias.map((date) => {
        const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
        return {
          date,
          weekday,
          entries: porDia.get(date) ?? [],
          exceptions: excecoesPorDia.get(date) ?? [],
          workingDays: jornadaDoDia(date, weekday),
        };
      }),
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
  /**
   * Nulo quando quem pergunta não tem `customers.view`.
   *
   * A rota que a devolve declara `settings.manage`, que é permissão de
   * cadastro. Sem a redação, ela entregava a agenda futura com nome de quem
   * marcou por uma permissão que não é de cliente — e a decisão de bloquear a
   * faixa continua possível sabendo **quantos** e **quando**.
   */
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
    readonly podeVerCliente: boolean;
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
      customerName: params.podeVerCliente ? linha.customer_name : null,
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
  /**
   * Quem pode ver identidade de cliente.
   *
   * A rota declara `settings.manage` — permissão de cadastro, não de cliente —
   * e a primeira chamada devolve os conflitos **sem gravar**. Redigir e não
   * recusar, como o painel do dia: sem a permissão a lista ainda diz quantos e
   * quando, que é o que decide se o bloqueio pode entrar.
   */
  readonly podeVerCliente: boolean;
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

  /**
   * Quem só enxerga a própria agenda só **fecha** a própria agenda (bloco 109).
   *
   * `onlyProfessionalId` é o recorte que o controller deriva de
   * `appointments.view_all_professionals`: nulo para dono, gerente e recepção,
   * o id da cadeira para o barbeiro. Ele recortava a **leitura** e não tocava a
   * escrita — o alvo vinha do corpo, e `null` significa "a barbearia toda".
   *
   * O barbeiro que quisesse fechar o próprio almoço fechava a casa inteira, e o
   * seletor "De quem" **abre** em "A barbearia toda": não era preciso requisição
   * forjada, bastava não mexer no campo.
   *
   * A metade que tornava isso pior é a de cima: `conflitosDaExcecao` já filtra
   * por `onlyProfessionalId`, então a lista de "quem está marcado dentro" vinha
   * com um cliente quando havia quatro. Ele lia "só o Wesley", confirmava, e
   * fechava três cadeiras com três clientes de colegas dentro da janela, sem ter
   * sido avisado deles. A leitura foi estreitada por uma revisão de segurança e
   * a escrita ficou larga: virou guarda que impede saber sem impedir agir.
   *
   * A rota vizinha já fazia certo — `mover` recusa destino na cadeira do colega
   * com essa mesma frase. Aqui é a mesma regra, no caminho que faltava.
   */
  if (params.onlyProfessionalId && alvoProfissional !== params.onlyProfessionalId) {
    throw new AgendaError(
      'fora_do_alcance',
      'Você só pode bloquear a sua própria agenda.',
    );
  }

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
    await travarDiaDaAgenda(tx, params.locationId, params.date);
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
      podeVerCliente: params.podeVerCliente,
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
  /**
   * E quem só enxerga a própria agenda só apaga o que é da própria cadeira.
   *
   * A simetria de **tipo** existia desde que a rota nasceu; a de **dono** não.
   * Verificado: o dono criou um bloqueio na cadeira do Ruan e o barbeiro
   * Gleidson apagou — sobre uma cadeira que ele nem enxerga na própria agenda.
   * É o par do que a criação passou a recusar no bloco 109, e sem ele bastava
   * apagar o bloqueio para desfazer a folga alheia.
   */
  readonly onlyProfessionalId?: string | null;
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { id: string; kind: TipoDeExcecao; professional_id: string | null }[]
    >`
      SELECT e.id, e.kind, e.professional_id
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

    /**
     * A recusa tem a **mesma mensagem** de exceção inexistente.
     *
     * "Existe, mas não é sua" confirma o id para quem o adivinhou — é o
     * precedente do OTP, que responde igual para telefone existente e
     * inexistente, e o mesmo que a recusa de unidade já segue.
     */
    if (params.onlyProfessionalId && excecao.professional_id !== params.onlyProfessionalId) {
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
