import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  POLITICA_SEM_SINAL,
  allowedActions,
  canApply,
  decidirReembolso,
  formatHHMM,
  instantToLocal,
  punctuality,
  realDuration,
  statusAfter,
  type AppointmentStatus,
  type AttendanceAction,
  type DesfechoDoSinal,
  type MotivoDoSinal,
  type Punctuality,
} from '@barbearia/core';
import { agendarOfertaDaVaga } from '@barbearia/jobs';
import { quemQuerAVagaLiberada, type CandidatoDaVaga } from './espera.js';

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
  /**
   * O sinal deste horário, quando ele existe.
   *
   * Nulo — e não um objeto zerado — quando o horário não pede sinal, que é a
   * esmagadora maioria. A tela não pode desenhar uma linha "sinal: R$ 0,00"
   * para todo mundo: indicador que sempre diz a mesma coisa é indicador que se
   * aprende a não ler.
   */
  readonly deposit: {
    readonly exigidoCents: number;
    readonly pagoCents: number;
    readonly motivo: MotivoDoSinal;
    /**
     * O que fazer com o dinheiro, quando o horário já acabou de um jeito ou de
     * outro.
     *
     * Nulo enquanto o horário está de pé: indicador que responde antes da
     * pergunta é pior que indicador nenhum — a recepção aprenderia a ler
     * "devolver" num agendamento que vai acontecer.
     */
    readonly reembolso: { readonly desfecho: DesfechoDoSinal; readonly porque: string } | null;
  } | null;
  /** Quanto o atendimento levou de fato. Nulo enquanto não terminou. */
  readonly realDurationMinutes: number | null;
  /** Há quantos minutos está na cadeira. Só para `in_progress`. */
  readonly elapsedMinutes: number | null;
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

/**
 * O que a política manda fazer com o sinal deste horário.
 *
 * Calculado no painel e não numa segunda ida ao banco por linha: a recepção
 * abre esta tela uma vez e trabalha nela o dia inteiro, e perguntar por
 * agendamento seria o N+1 que o CLAUDE.md §3 proíbe.
 */
function destinoDoSinal(
  linha: {
    readonly status: AppointmentStatus;
    readonly deposit_paid_cents: number;
    readonly service_starts_at: Date;
    readonly cancelled_at: Date | null;
  },
  horasParaReembolso: number,
): { readonly desfecho: DesfechoDoSinal; readonly porque: string } | null {
  if (linha.deposit_paid_cents <= 0) return null;

  const quem =
    linha.status === 'no_show'
      ? ('falta' as const)
      : linha.status === 'cancelled_business'
        ? ('casa' as const)
        : linha.status === 'cancelled_customer'
          ? ('cliente' as const)
          : null;
  if (!quem) return null;

  // Antecedência desconhecida devolve: o carimbo só falta em agendamento
  // anterior à migração 0039, e reter dinheiro por um registro que a casa não
  // fez é cobrar pelo próprio buraco.
  const horas = linha.cancelled_at
    ? (linha.service_starts_at.getTime() - linha.cancelled_at.getTime()) / 3_600_000
    : null;

  const { desfecho, porque } = decidirReembolso({
    politica: { ...POLITICA_SEM_SINAL, horasParaReembolso },
    quem,
    horasDeAntecedencia: horas,
  });
  return { desfecho, porque };
}

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
      { timezone: string; no_show_after_minutes: number; deposit_refund_hours: number }[]
    >`
      SELECT timezone, no_show_after_minutes, deposit_refund_hours FROM locations
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
        deposit_required_cents: number;
        deposit_paid_cents: number;
        deposit_reason: string | null;
        cancelled_at: Date | null;
        checked_in_at: Date | null;
        started_at: Date | null;
        completed_at: Date | null;
      }[]
    >`
      SELECT a.id, a.status, a.service_starts_at, a.service_ends_at,
             a.professional_id, p.name AS professional_name,
             a.customer_id, c.name AS customer_name, c.phone_e164 AS customer_phone,
             array_agg(s.name ORDER BY aps.position) AS services,
             a.price_cents, a.checked_in_at, a.started_at, a.completed_at,
             -- O sinal vem na mesma consulta do painel (bloco 37). Uma ida ao
             -- banco por linha para descobrir se aquele horário pede sinal
             -- seria N+1 na tela que a recepção deixa aberta o dia inteiro.
             a.deposit_required_cents, a.deposit_paid_cents, a.deposit_reason,
             a.cancelled_at
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
        deposit: linha.deposit_required_cents > 0
          ? {
              exigidoCents: linha.deposit_required_cents,
              pagoCents: linha.deposit_paid_cents,
              motivo: (linha.deposit_reason ?? 'score') as MotivoDoSinal,
              reembolso: destinoDoSinal(linha, unidade.deposit_refund_hours),
            }
          : null,
        realDurationMinutes: realDuration(linha.started_at, linha.completed_at),
        /**
         * Há quanto tempo esta pessoa está na cadeira (correção de fluxo, depois do bloco 36).
         *
         * `started_at` existe no schema desde a migração 0014, com o comentário
         * "base da duração real" — e era **descartado antes de chegar à tela**:
         * `realDuration` devolve nulo enquanto o atendimento não termina, e nada
         * mais lia a coluna. O resultado é que a linha de quem estava sendo
         * atendido era a única do painel sem nenhuma frase de contexto: o balcão
         * via "Na cadeira" e não sabia se tinha começado há cinco ou há
         * cinquenta minutos.
         *
         * É um instantâneo do momento da carga, e a tela diz isso — sem
         * componente de cliente o número não anda sozinho. Fingir um cronômetro
         * seria pior que não ter nenhum.
         */
        elapsedMinutes:
          linha.status === 'in_progress' && linha.started_at
            ? Math.max(0, Math.floor((now.getTime() - linha.started_at.getTime()) / 60000))
            : null,
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
  /**
   * Quem chama pode ver nome e telefone de cliente (`customers.view`).
   *
   * Obrigatório no tipo, e não opcional: opcional, ele seria esquecido no
   * primeiro chamador novo e a lista sairia com identidade de cliente para
   * quem a barbearia decidiu não dar. Achado da revisão de segurança do bloco
   * 38 — a rota da agenda tinha o mesmo defeito.
   */
  readonly podeVerCliente: boolean;
  readonly now?: Date;
}): Promise<{
  readonly status: AppointmentStatus;
  /**
   * Quem quer o horário que este cancelamento acabou de abrir (bloco 38).
   *
   * Vazio em toda ação que não seja cancelar — e vazio também quando ninguém
   * espera, que é o caso comum. A tela distingue os dois pelo que faz: sem
   * candidato, não desenha nada.
   */
  readonly esperando: readonly CandidatoDaVaga[];
}> {
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
            -- O painel também cancela, e o carimbo tem que sair daqui igual ao
            -- da tela do cliente. Sem esta linha o cancelamento feito pelo
            -- balcão nasceria sem antecedência conhecida — e "não sei" devolve
            -- o sinal, então a barbearia perderia o dinheiro pela própria porta.
            cancelled_at  = CASE WHEN ${destino === 'cancelled_business'} THEN ${now}
                                 ELSE cancelled_at END,
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

    /**
     * O atendimento que termina **fecha a entrada da fila** (correção de fluxo, depois do bloco 36).
     *
     * Elas já nasciam ligadas: `seatQueueEntry` cria o atendimento e grava
     * `queue_entries.appointment_id`. O que faltava era o outro lado — nada no
     * produto escrevia `done`, então a entrada sumia da tela ao virar
     * `in_service` e ficava viva para sempre.
     *
     * O preço disso não era teórico: "espera média" só conta entradas
     * concluídas, então o número que a tela da fila promete **nunca aparecia**.
     * Indicador que é sempre `—` é pior que indicador ausente — ele ocupa
     * espaço prometendo uma resposta que não vem, e quem opera aprende a não
     * olhar.
     *
     * Na mesma transação porque é o mesmo fato: se a venda terminou, a pessoa
     * saiu da cadeira. Duas transações deixariam a fila contando alguém que já
     * foi embora.
     */
    if (destino === 'completed' || destino === 'cancelled_business') {
      await tx.$executeRaw`
        UPDATE queue_entries
           SET status = 'done', finished_at = ${now}, updated_at = now()
         WHERE appointment_id = ${params.appointmentId}::uuid
           AND status = 'in_service'
      `;
    }

    /**
     * A lista de espera, perguntada **dentro da transação** (bloco 38).
     *
     * O balcão é onde a maioria dos cancelamentos acontece — o cliente liga e
     * a recepção desmarca —, então é aqui que a lista precisa aparecer. Sem
     * isto, ela existiria só no caminho que o próprio cliente usa, que é o
     * menos frequente dos dois.
     *
     * Perguntar depois do commit criaria a janela em que o horário está livre e
     * ninguém sabe.
     */
    const encontrados =
      destino === 'cancelled_business'
        ? await quemQuerAVagaLiberada(tx, params.appointmentId)
        : [];

    /**
     * A vaga vai à fila por prioridade (bloco 39).
     *
     * O balcão é onde a maioria dos cancelamentos acontece — o cliente liga e a
     * recepção desmarca. Sem esta linha, a oferta automática existiria só no
     * caminho que o próprio cliente usa, que é o menos frequente dos dois.
     */
    if (encontrados.length > 0) {
      const dados = await tx.$queryRaw<
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
         WHERE a.id = ${params.appointmentId}::uuid
      `;
      const linha = dados[0];
      if (linha) {
        await agendarOfertaDaVaga(tx, {
          locationId: linha.location_id,
          professionalId: linha.professional_id,
          inicio: linha.starts_at,
          fim: linha.ends_at,
          timezone: linha.timezone,
          agora: now,
        });
      }
    }

    /**
     * Quem não pode ver cliente recebe a **contagem**, não os nomes.
     *
     * A lista vazia seria mentira — "ninguém espera" quando alguém espera —, e
     * a lista inteira entregaria a base a quem a barbearia decidiu não dar.
     * Sem nome e sem telefone, a linha ainda diz o que a recepção precisa:
     * existe gente para este horário, procure quem pode ligar.
     */
    const esperando = params.podeVerCliente
      ? encontrados
      : encontrados.map((quem) => ({
          ...quem,
          customerNome: '',
          customerTelefoneFinal: null,
        }));

    return { status: destino, esperando };
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

/**
 * O nome da barbearia, para o rótulo do autenticador.
 *
 * Sem ele, três barbearias administradas pela mesma pessoa viram três entradas
 * "Barbearia" idênticas no celular — e o segundo fator de qual delas é qual
 * vira tentativa e erro na hora de fechar o caixa.
 */
export async function tenantName(tenantId: string): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ name: string }[]>`SELECT name FROM tenants LIMIT 1`;
    return linhas[0]?.name ?? null;
  });
}
