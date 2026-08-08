import { randomBytes, createHash } from 'node:crypto';
import { withTenant, type TransactionClient } from '@barbearia/db';
import { pgCode } from './booking.js';
import {
  custoDoEncaixe,
  duracaoEsperada,
  estimarFila,
  frasePosicao,
  instantToLocal,
  type AtendenteNaFila,
  type CustoDoEncaixe,
} from '@barbearia/core';

/**
 * Fila presencial — a ponte entre o banco e o motor de `packages/core`.
 *
 * Toda a decisão está lá, pura e testada; aqui só se carrega o estado e se
 * converte instante em "minutos a partir de agora", que é a unidade em que a
 * fila raciocina.
 *
 * **Três consultas, sem laço com ida ao banco.** A tela da recepção fica aberta
 * o dia inteiro e recarrega a cada ação: uma consulta por pessoa na fila seria
 * N+1 na segunda tela mais usada do produto.
 */

export type QueueFailure =
  | 'queue_entry_not_found'
  | 'transition_not_allowed'
  | 'already_in_queue'
  | 'unknown_service'
  | 'unknown_professional'
  | 'slot_taken';

export class QueueError extends Error {
  constructor(
    readonly code: QueueFailure,
    message: string,
  ) {
    super(message);
    this.name = 'QueueError';
  }
}

export type QueueStatus = 'waiting' | 'called' | 'in_service' | 'done' | 'gave_up';

const VIVOS: readonly QueueStatus[] = ['waiting', 'called'];

/** Janela da média de duração real. Ver `duracoesReais`. */
const JANELA_DE_MEDIA_DIAS = 90;

/**
 * Token do link de acompanhamento.
 *
 * 32 bytes de `randomBytes` — não `Math.random`, que é previsível, e não UUID
 * v4, que tem 122 bits mas anuncia o formato. O que vai para o banco é o
 * SHA-256; o valor em claro existe uma vez, na resposta que a recepção usa para
 * montar o link, e nunca mais.
 */
function novoToken(): { readonly token: string; readonly hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashDoToken(token) };
}

export function hashDoToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface PessoaNaFila {
  readonly id: string;
  readonly posicao: number;
  readonly customerId: string;
  readonly customerName: string;
  /** Só os quatro últimos dígitos: a tela fica virada para o salão. */
  readonly customerPhoneTail: string | null;
  readonly status: QueueStatus;
  readonly services: readonly string[];
  readonly duracaoMinutos: number;
  /** Preferência declarada. `null` é "qualquer um". */
  readonly preferidoId: string | null;
  /** Quem de fato vai atender, resolvido agora. */
  readonly professionalId: string | null;
  readonly professionalName: string | null;
  readonly esperaMinutos: number | null;
  /** Há quanto tempo está esperando. É o número pelo qual a recepção olha. */
  readonly esperandoHaMinutos: number;
  readonly atrasaMarcado: boolean;
  readonly frase: string;
}

export interface CadeiraNaFila {
  readonly professionalId: string;
  readonly professionalName: string;
  readonly livreEmMinutos: number;
  /** Hora local do próximo marcado, HH:mm. Nulo quando não há. */
  readonly proximoMarcado: string | null;
  readonly proximoMarcadoEmMinutos: number | null;
}

/** O custo por cadeira de encaixar **um serviço concreto** agora. */
export interface EncaixeNaCadeira extends CustoDoEncaixe {
  readonly professionalName: string;
  readonly proximoMarcado: string | null;
}

export interface Fila {
  readonly entries: readonly PessoaNaFila[];
  readonly cadeiras: readonly CadeiraNaFila[];
  readonly timezone: string;
  readonly totals: {
    readonly esperando: number;
    readonly chamados: number;
    readonly atendendo: number;
    readonly desistiram: number;
    readonly esperaMediaMinutos: number | null;
  };
}

const minutosEntre = (de: Date, ate: Date): number =>
  Math.max(0, Math.round((ate.getTime() - de.getTime()) / 60_000));

/**
 * Quanto cada serviço leva de fato, com o histórico da própria barbearia.
 *
 * A média sai do banco; a decisão de usá-la ou não é do domínio
 * (`duracaoEsperada`), que exige amostra mínima e limita o resultado em torno
 * da duração cadastrada.
 */
async function duracoesReais(tx: TransactionClient, now: Date): Promise<Map<string, number>> {
  // Noventa dias, não a história inteira. É correção antes de ser desempenho:
  // o barbeiro que ficou mais rápido este ano não deve ser julgado pelo ano
  // passado, e a média de três anos leva um tempo para reagir a qualquer
  // mudança real.
  //
  // O ganho medido veio junto: 40,9 ms → 8,8 ms com 34 mil atendimentos, com
  // Index Scan no lugar do Seq Scan. E o custo deixou de crescer para sempre —
  // antes, cada carga da tela da fila relia todo o passado da barbearia.
  const desde = new Date(now.getTime() - JANELA_DE_MEDIA_DIAS * 24 * 60 * 60 * 1000);

  const linhas = await tx.$queryRaw<
    { service_id: string; cadastrada: number; media: number | null; amostras: bigint }[]
  >`
    SELECT s.id AS service_id, s.duration_minutes AS cadastrada, m.media, m.amostras
      FROM services s
      LEFT JOIN (
        SELECT aps.service_id,
               avg(EXTRACT(EPOCH FROM (a.completed_at - a.started_at)) / 60) AS media,
               count(*) AS amostras
          FROM appointments a
          JOIN appointment_services aps ON aps.appointment_id = a.id
         WHERE a.status = 'completed'
           AND a.completed_at >= ${desde}
           AND a.started_at IS NOT NULL
         GROUP BY aps.service_id
      ) m ON m.service_id = s.id
  `;

  return new Map(
    linhas.map((linha) => [
      linha.service_id,
      duracaoEsperada({
        cadastradaMinutos: linha.cadastrada,
        mediaRealMinutos: linha.media === null ? null : Number(linha.media),
        amostras: Number(linha.amostras),
      }),
    ]),
  );
}

/**
 * Quem pode atender agora, e até quando.
 *
 * "Livre" é o instante em que a cadeira vaga: agora, ou o fim previsto do que
 * está em curso. O fim previsto usa a duração esperada, não a cadastrada, pelo
 * mesmo motivo da estimativa da fila.
 */
async function cadeiras(
  tx: TransactionClient,
  locationId: string,
  now: Date,
  duracoes: Map<string, number>,
  timezone: string,
): Promise<{ atendentes: AtendenteNaFila[]; nomes: Map<string, string>; proximos: Map<string, Date> }> {
  const weekday = new Date(`${instantToLocal(timezone, now).date}T12:00:00Z`).getUTCDay();

  const linhas = await tx.$queryRaw<
    {
      id: string;
      name: string;
      em_curso_desde: Date | null;
      em_curso_servicos: string[] | null;
      proximo_marcado: Date | null;
    }[]
  >`
    SELECT p.id, p.name,
           (SELECT a.started_at FROM appointments a
             WHERE a.professional_id = p.id AND a.status = 'in_progress'
             ORDER BY a.started_at DESC LIMIT 1) AS em_curso_desde,
           (SELECT array_agg(aps.service_id::text)
              FROM appointments a
              JOIN appointment_services aps ON aps.appointment_id = a.id
             WHERE a.professional_id = p.id AND a.status = 'in_progress') AS em_curso_servicos,
           (SELECT min(a.service_starts_at) FROM appointments a
             WHERE a.professional_id = p.id
               AND a.service_starts_at >= ${now}
               AND a.status IN ('pending', 'confirmed', 'checked_in', 'waiting')) AS proximo_marcado
      FROM professionals p
     WHERE p.location_id = ${locationId}::uuid
       AND p.active
       AND p.kind = 'professional'
       -- Só quem tem jornada hoje. Sem isto a fila ofereceria a cadeira de quem
       -- está de folga, e a estimativa nunca chegaria.
       AND EXISTS (
         SELECT 1 FROM work_schedules ws
          WHERE ws.professional_id = p.id AND ws.weekday = ${weekday}
       )
     ORDER BY p.name
  `;

  const atendentes: AtendenteNaFila[] = [];
  const nomes = new Map<string, string>();
  const proximos = new Map<string, Date>();

  for (const linha of linhas) {
    nomes.set(linha.id, linha.name);

    let livreEmMinutos = 0;
    if (linha.em_curso_desde) {
      const previsto = (linha.em_curso_servicos ?? []).reduce(
        (soma, servicoId) => soma + (duracoes.get(servicoId) ?? 0),
        0,
      );
      const fim = new Date(linha.em_curso_desde.getTime() + previsto * 60_000);
      livreEmMinutos = minutosEntre(now, fim);
    }

    if (linha.proximo_marcado) proximos.set(linha.id, linha.proximo_marcado);

    atendentes.push({
      professionalId: linha.id,
      livreEmMinutos,
      proximoMarcadoEmMinutos: linha.proximo_marcado
        ? minutosEntre(now, linha.proximo_marcado)
        : null,
    });
  }

  return { atendentes, nomes, proximos };
}

export async function getQueue(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly timezone: string;
  readonly now?: Date;
}): Promise<Fila> {
  const now = params.now ?? new Date();

  return withTenant(params.tenantId, async (tx) => {
    const duracoes = await duracoesReais(tx, now);
    const { atendentes, nomes, proximos } = await cadeiras(
      tx,
      params.locationId,
      now,
      duracoes,
      params.timezone,
    );

    const linhas = await tx.$queryRaw<
      {
        id: string;
        status: QueueStatus;
        customer_id: string;
        customer_name: string;
        customer_phone: string;
        professional_id: string | null;
        joined_at: Date;
        finished_at: Date | null;
        started_at: Date | null;
        service_ids: string[] | null;
        service_names: string[] | null;
      }[]
    >`
      SELECT q.id, q.status, q.customer_id, c.name AS customer_name, c.phone_e164 AS customer_phone,
             q.professional_id, q.joined_at, q.finished_at, q.started_at,
             (SELECT array_agg(qs.service_id::text ORDER BY qs.position)
                FROM queue_entry_services qs WHERE qs.queue_entry_id = q.id) AS service_ids,
             (SELECT array_agg(s.name ORDER BY qs.position)
                FROM queue_entry_services qs
                JOIN services s ON s.id = qs.service_id
               WHERE qs.queue_entry_id = q.id) AS service_names
        FROM queue_entries q
        JOIN customers c ON c.id = q.customer_id
       WHERE q.location_id = ${params.locationId}::uuid
         AND q.joined_at >= ${new Date(now.getTime() - 12 * 60 * 60 * 1000)}
       ORDER BY q.joined_at
    `;

    const vivas = linhas.filter((linha) => VIVOS.includes(linha.status));

    const duracaoDe = (ids: readonly string[]): number =>
      ids.reduce((soma, id) => soma + (duracoes.get(id) ?? 0), 0);

    const lugares = estimarFila({
      fila: vivas.map((linha) => ({
        id: linha.id,
        professionalId: linha.professional_id,
        duracaoMinutos: duracaoDe(linha.service_ids ?? []),
      })),
      atendentes,
    });

    const porId = new Map(lugares.map((lugar) => [lugar.id, lugar]));

    const entries: PessoaNaFila[] = vivas.map((linha, indice) => {
      const lugar = porId.get(linha.id);
      const professionalId = lugar?.professionalId ?? null;
      return {
        id: linha.id,
        posicao: indice + 1,
        customerId: linha.customer_id,
        customerName: linha.customer_name,
        customerPhoneTail: linha.customer_phone.slice(-4),
        status: linha.status,
        services: linha.service_names ?? [],
        duracaoMinutos: duracaoDe(linha.service_ids ?? []),
        preferidoId: linha.professional_id,
        professionalId,
        professionalName: professionalId ? (nomes.get(professionalId) ?? null) : null,
        esperaMinutos: lugar?.esperaMinutos ?? null,
        esperandoHaMinutos: minutosEntre(linha.joined_at, now),
        atrasaMarcado: lugar?.atrasaMarcado ?? false,
        frase: frasePosicao({
          posicao: indice + 1,
          esperaMinutos: lugar?.esperaMinutos ?? null,
        }),
      };
    });

    const atendidasHoje = linhas.filter((l) => l.status === 'done' && l.started_at);
    const esperas = atendidasHoje.map((l) =>
      minutosEntre(l.joined_at, l.started_at ?? l.joined_at),
    );

    return {
      entries,
      // Sem duração de serviço não existe "cabe": a cadeira informa quando vaga
      // e quando tem compromisso, e quem pergunta se cabe é `custoDoEncaixeNaFila`,
      // que sabe o que a pessoa quer fazer.
      cadeiras: atendentes.map((atendente) => {
        const proximo = proximos.get(atendente.professionalId);
        return {
          professionalId: atendente.professionalId,
          professionalName: nomes.get(atendente.professionalId) ?? '',
          livreEmMinutos: atendente.livreEmMinutos,
          proximoMarcado: proximo ? formatarHora(params.timezone, proximo) : null,
          proximoMarcadoEmMinutos: atendente.proximoMarcadoEmMinutos,
        };
      }),
      timezone: params.timezone,
      totals: {
        esperando: linhas.filter((l) => l.status === 'waiting').length,
        chamados: linhas.filter((l) => l.status === 'called').length,
        atendendo: linhas.filter((l) => l.status === 'in_service').length,
        desistiram: linhas.filter((l) => l.status === 'gave_up').length,
        esperaMediaMinutos:
          esperas.length === 0
            ? null
            : Math.round(esperas.reduce((a, b) => a + b, 0) / esperas.length),
      },
    };
  });
}

function formatarHora(timezone: string, quando: Date): string {
  const local = instantToLocal(timezone, quando);
  const h = Math.floor(local.minutes / 60);
  const m = local.minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * O custo de encaixar **este serviço** agora, cadeira por cadeira.
 *
 * É o número que a recepção não tinha: "livre" e "cabe" são coisas diferentes.
 * Cadeira livre com quinze minutos até o próximo marcado não comporta um corte
 * de trinta — e é assim que a barbearia começa o dia quinze minutos atrasada e
 * termina uma hora.
 */
export async function custoDoEncaixeNaFila(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly timezone: string;
  readonly serviceIds: readonly string[];
  readonly now?: Date;
}): Promise<readonly EncaixeNaCadeira[]> {
  const now = params.now ?? new Date();

  return withTenant(params.tenantId, async (tx) => {
    const duracoes = await duracoesReais(tx, now);
    const { atendentes, nomes, proximos } = await cadeiras(
      tx,
      params.locationId,
      now,
      duracoes,
      params.timezone,
    );

    const duracaoMinutos = params.serviceIds.reduce(
      (soma, id) => soma + (duracoes.get(id) ?? 0),
      0,
    );

    return custoDoEncaixe({ atendentes, duracaoMinutos }).map((custo) => {
      const proximo = proximos.get(custo.professionalId);
      return {
        ...custo,
        professionalName: nomes.get(custo.professionalId) ?? '',
        proximoMarcado: proximo ? formatarHora(params.timezone, proximo) : null,
      };
    });
  });
}

const UNIQUE_VIOLATION = '23505';

/**
 * Põe alguém na fila.
 *
 * Devolve o token do link **uma vez**. Ele não é recuperável depois: o banco só
 * guarda o hash, e reemitir significaria invalidar o link que a pessoa já está
 * olhando no celular.
 *
 * Os ids vindos da requisição são conferidos sob RLS antes do `INSERT`. A
 * checagem de integridade referencial do Postgres ignora row security, então a
 * chave estrangeira sozinha aceitaria um serviço de outra barbearia.
 */
export async function joinQueue(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly customerId: string;
  readonly serviceIds: readonly string[];
  readonly professionalId?: string | null;
  readonly notes?: string;
  readonly idempotencyKey?: string;
  readonly now?: Date;
}): Promise<{ readonly id: string; readonly token: string; readonly posicao: number }> {
  const now = params.now ?? new Date();

  return withTenant(params.tenantId, async (tx) => {
    if (params.idempotencyKey) {
      // Escopada por cliente, nunca só por tenant: a chave vem de fora e é
      // livre, então duas pessoas mandando "1" colidiriam — e a segunda
      // receberia de volta o token da primeira, que dá acesso à posição dela.
      const jaExiste = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM queue_entries
         WHERE customer_id = ${params.customerId}::uuid
           AND idempotency_key = ${params.idempotencyKey}
      `;
      const anterior = jaExiste[0];
      if (anterior) {
        // O token não volta: só o hash existe. Quem repetiu a chamada recebe a
        // entrada, e o link continua sendo o que foi entregue na primeira.
        return { id: anterior.id, token: '', posicao: await posicaoNaFila(tx, anterior.id) };
      }
    }

    const servicos = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM services WHERE id = ANY(${[...params.serviceIds]}::uuid[]) AND active
    `;
    if (servicos.length !== new Set(params.serviceIds).size) {
      throw new QueueError('unknown_service', 'Um dos serviços informados não existe.');
    }

    if (params.professionalId) {
      const pro = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM professionals
         WHERE id = ${params.professionalId}::uuid AND location_id = ${params.locationId}::uuid
      `;
      if (!pro[0]) {
        throw new QueueError('unknown_professional', 'Profissional não encontrado.');
      }
    }

    const { token, hash } = novoToken();

    let id: string;
    try {
      const criada = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO queue_entries
          (tenant_id, location_id, customer_id, professional_id, public_token_hash,
           idempotency_key, notes, joined_at)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${params.locationId}::uuid, ${params.customerId}::uuid,
          ${params.professionalId ?? null}::uuid, ${hash},
          ${params.idempotencyKey ?? null}, ${params.notes ?? null}, ${now}
        )
        RETURNING id
      `;
      const nova = criada[0];
      if (!nova) throw new QueueError('queue_entry_not_found', 'Não foi possível entrar na fila.');
      id = nova.id;
    } catch (error) {
      if (pgCode(error) === UNIQUE_VIOLATION) {
        // Duplo toque na recepção, ou a pessoa já está esperando. Os dois
        // levam ao mesmo lugar: ela está na fila, e não deve entrar de novo.
        throw new QueueError('already_in_queue', 'Esta pessoa já está na fila.');
      }
      throw error;
    }

    for (const [posicao, servicoId] of params.serviceIds.entries()) {
      await tx.$executeRaw`
        INSERT INTO queue_entry_services (queue_entry_id, service_id, tenant_id, position)
        VALUES (${id}::uuid, ${servicoId}::uuid,
                NULLIF(current_setting('app.tenant_id', true), '')::uuid, ${posicao})
      `;
    }

    return { id, token, posicao: await posicaoNaFila(tx, id) };
  });
}

async function posicaoNaFila(tx: TransactionClient, id: string): Promise<number> {
  const linhas = await tx.$queryRaw<{ posicao: bigint }[]>`
    SELECT count(*) + 1 AS posicao
      FROM queue_entries anterior
     WHERE anterior.status IN ('waiting', 'called')
       AND anterior.location_id = (SELECT location_id FROM queue_entries WHERE id = ${id}::uuid)
       AND anterior.joined_at < (SELECT joined_at FROM queue_entries WHERE id = ${id}::uuid)
  `;
  return Number(linhas[0]?.posicao ?? 1);
}

/** Transições que a fila aceita, espelhando a máquina do atendimento. */
const TRANSICOES: Readonly<Record<QueueStatus, readonly QueueStatus[]>> = {
  waiting: ['called', 'in_service', 'gave_up'],
  // Chamado e não apareceu volta para a fila: acontece o tempo todo, e forçar
  // a recepção a recriar a entrada perderia a hora de chegada — que é o que a
  // ordem da fila promete.
  called: ['waiting', 'in_service', 'gave_up'],
  in_service: ['done'],
  done: [],
  gave_up: [],
};

export async function moveQueueEntry(params: {
  readonly tenantId: string;
  readonly queueEntryId: string;
  readonly para: QueueStatus;
  readonly now?: Date;
}): Promise<{ readonly status: QueueStatus }> {
  const now = params.now ?? new Date();

  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ status: QueueStatus }[]>`
      SELECT status FROM queue_entries WHERE id = ${params.queueEntryId}::uuid FOR UPDATE
    `;
    const atual = linhas[0];
    if (!atual) throw new QueueError('queue_entry_not_found', 'Esta pessoa não está mais na fila.');

    if (!TRANSICOES[atual.status].includes(params.para)) {
      throw new QueueError(
        'transition_not_allowed',
        'A fila já mudou. Recarregue a tela para ver o estado atual.',
      );
    }

    // `in_service` exige o agendamento e tem função própria — chegar aqui
    // gravaria um estado que a constraint do banco recusa, e o erro sairia
    // como falha de banco em vez de regra.
    if (params.para === 'in_service') {
      throw new QueueError('transition_not_allowed', 'Use "sentar" para iniciar o atendimento.');
    }

    await tx.$executeRaw`
      UPDATE queue_entries SET
        status = ${params.para}::queue_status,
        called_at = CASE WHEN ${params.para} = 'called' THEN ${now} ELSE called_at END,
        finished_at = CASE WHEN ${params.para} IN ('done', 'gave_up') THEN ${now}
                           ELSE finished_at END,
        updated_at = now()
      WHERE id = ${params.queueEntryId}::uuid
    `;

    return { status: params.para };
  });
}

const EXCLUSION_VIOLATION = '23P01';

/**
 * A pessoa sentou: a entrada da fila vira atendimento de verdade.
 *
 * A partir daqui existe um `appointment` com horário real, e é ele que alimenta
 * comanda, comissão e relatório. A fila em si nunca vira dinheiro — ela é a sala
 * de espera.
 *
 * **A regra de convivência é imposta pelo banco.** A SPEC exige que walk-in
 * nunca sobrescreva agendamento confirmado; quem garante isso é a constraint de
 * exclusão sobre a janela do profissional, não um `if` aqui. Um `if` teria a
 * janela entre a checagem e o `INSERT` — e é justamente com o cliente de pé na
 * frente da recepção que duas pessoas tocam o botão ao mesmo tempo.
 *
 * `source: 'walk_in'` separa no relatório o que entrou pela porta do que foi
 * marcado. É o número que decide horário de funcionamento e escala.
 */
export async function seatQueueEntry(params: {
  readonly tenantId: string;
  readonly queueEntryId: string;
  readonly professionalId: string;
  readonly now?: Date;
}): Promise<{ readonly appointmentId: string; readonly endsAt: string }> {
  const now = params.now ?? new Date();

  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        status: QueueStatus;
        location_id: string;
        customer_id: string;
        service_ids: string[] | null;
      }[]
    >`
      SELECT q.status, q.location_id, q.customer_id,
             (SELECT array_agg(qs.service_id::text ORDER BY qs.position)
                FROM queue_entry_services qs WHERE qs.queue_entry_id = q.id) AS service_ids
        FROM queue_entries q
       WHERE q.id = ${params.queueEntryId}::uuid
       FOR UPDATE
    `;
    const entrada = linhas[0];
    if (!entrada) {
      throw new QueueError('queue_entry_not_found', 'Esta pessoa não está mais na fila.');
    }
    if (!TRANSICOES[entrada.status].includes('in_service')) {
      throw new QueueError(
        'transition_not_allowed',
        'A fila já mudou. Recarregue a tela para ver o estado atual.',
      );
    }

    const pro = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM professionals
       WHERE id = ${params.professionalId}::uuid AND location_id = ${entrada.location_id}::uuid
    `;
    if (!pro[0]) throw new QueueError('unknown_professional', 'Profissional não encontrado.');

    const servicos = await tx.$queryRaw<
      {
        id: string;
        price_cents: number;
        duration_minutes: number;
        buffer_before_minutes: number;
        buffer_after_minutes: number;
      }[]
    >`
      SELECT id, price_cents, duration_minutes, buffer_before_minutes, buffer_after_minutes
        FROM services WHERE id = ANY(${entrada.service_ids ?? []}::uuid[])
    `;
    if (servicos.length === 0) {
      throw new QueueError('unknown_service', 'A pessoa na fila não tem serviço escolhido.');
    }

    // Preço e duração saem do catálogo aqui e são **gravados** no atendimento:
    // o catálogo muda amanhã, o que foi vendido hoje não.
    const duracao = servicos.reduce((soma, s) => soma + s.duration_minutes, 0);
    const bufferAntes = Math.max(...servicos.map((s) => s.buffer_before_minutes));
    const bufferDepois = Math.max(...servicos.map((s) => s.buffer_after_minutes));
    const preco = servicos.reduce((soma, s) => soma + s.price_cents, 0);

    const inicio = now;
    const fim = new Date(inicio.getTime() + duracao * 60_000);
    const ocupadoDe = new Date(inicio.getTime() - bufferAntes * 60_000);
    const ocupadoAte = new Date(fim.getTime() + bufferDepois * 60_000);

    let appointmentId: string;
    try {
      const criado = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO appointments (
          tenant_id, location_id, customer_id, professional_id,
          starts_at, ends_at, service_starts_at, service_ends_at,
          status, source, price_cents, checked_in_at, started_at
        ) VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${entrada.location_id}::uuid, ${entrada.customer_id}::uuid,
          ${params.professionalId}::uuid,
          ${ocupadoDe}, ${ocupadoAte}, ${inicio}, ${fim},
          'in_progress', 'walk_in', ${preco},
          (SELECT joined_at FROM queue_entries WHERE id = ${params.queueEntryId}::uuid),
          ${now}
        )
        RETURNING id
      `;
      const novo = criado[0];
      if (!novo) throw new QueueError('slot_taken', 'Não foi possível iniciar o atendimento.');
      appointmentId = novo.id;
    } catch (error) {
      if (pgCode(error) === EXCLUSION_VIOLATION) {
        throw new QueueError(
          'slot_taken',
          'Não cabe: este profissional tem cliente marcado nesse horário. '
            + 'Escolha outra cadeira ou remarque o agendamento antes.',
        );
      }
      throw error;
    }

    for (const [posicao, servicoId] of (entrada.service_ids ?? []).entries()) {
      const servico = servicos.find((s) => s.id === servicoId);
      await tx.$executeRaw`
        INSERT INTO appointment_services
          (appointment_id, service_id, tenant_id, position, price_cents, duration_minutes)
        VALUES (
          ${appointmentId}::uuid, ${servicoId}::uuid,
          NULLIF(current_setting('app.tenant_id', true), '')::uuid, ${posicao},
          ${servico?.price_cents ?? 0}, ${servico?.duration_minutes ?? 1}
        )
      `;
    }

    await tx.$executeRaw`
      UPDATE queue_entries SET
        status = 'in_service', started_at = ${now},
        appointment_id = ${appointmentId}::uuid, updated_at = now()
      WHERE id = ${params.queueEntryId}::uuid
    `;

    return { appointmentId, endsAt: fim.toISOString() };
  });
}

/**
 * A posição de uma pessoa, pelo link do celular.
 *
 * Devolve o mínimo: onde ela está, quanto falta e a frase. **Nenhum nome de
 * outra pessoa**, nenhum telefone, nenhuma lista. Quem tem o link tem o link
 * dela, não a fila da barbearia.
 */
export interface MinhaPosicao {
  readonly posicao: number;
  readonly status: QueueStatus;
  readonly esperaMinutos: number | null;
  readonly frase: string;
  readonly nome: string;
  readonly services: readonly string[];
  readonly professionalName: string | null;
}

export async function queuePositionByToken(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly timezone: string;
  readonly token: string;
  readonly now?: Date;
}): Promise<MinhaPosicao | null> {
  const now = params.now ?? new Date();
  const hash = hashDoToken(params.token);

  const fila = await getQueue({
    tenantId: params.tenantId,
    locationId: params.locationId,
    timezone: params.timezone,
    now,
  });

  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { id: string; status: QueueStatus; customer_name: string }[]
    >`
      SELECT q.id, q.status, c.name AS customer_name
        FROM queue_entries q
        JOIN customers c ON c.id = q.customer_id
       WHERE q.public_token_hash = ${hash}
    `;
    const minha = linhas[0];
    if (!minha) return null;

    const naFila = fila.entries.find((entrada) => entrada.id === minha.id);
    if (!naFila) {
      // Já saiu da fila — sentou, terminou ou desistiu. A página diz isso em
      // vez de sumir: link que dá 404 depois de funcionar parece defeito.
      return {
        posicao: 0,
        status: minha.status,
        esperaMinutos: null,
        frase:
          minha.status === 'in_service'
            ? 'É a sua vez. Pode ir até a cadeira.'
            : 'Seu atendimento já foi encerrado.',
        nome: minha.customer_name,
        services: [],
        professionalName: null,
      };
    }

    return {
      posicao: naFila.posicao,
      status: naFila.status,
      esperaMinutos: naFila.esperaMinutos,
      frase: naFila.frase,
      nome: naFila.customerName,
      services: naFila.services,
      professionalName: naFila.professionalName,
    };
  });
}
