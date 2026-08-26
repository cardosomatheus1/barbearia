import {
  ESTADOS_QUE_LIBERAM_A_AGENDA,
  maskPhone,
  tryNormalizePhone,
  type Segmento,
  ESTADOS_EM_CURSO,
} from '@barbearia/core';
import { withTenant, type TransactionClient } from '@barbearia/db';
import { segmentosDaBase } from './segmento.js';

/**
 * A porta da base de clientes (V1).
 *
 * A ficha individual já existia; faltava o índice. A paginação desta leitura
 * acontece no PostgreSQL: pedir 30 nomes não pode carregar a base inteira para
 * depois cortar em JavaScript. Segmentação continua sendo uma propriedade da
 * base (mediana/decil) e por isso é calculada em conjunto quando a sessão pode
 * vê-la; os enriquecimentos de agenda, porém, só rodam para a página retornada.
 */

export const FILTROS_DA_PORTA = [
  'todos',
  'recentes',
  'hoje',
  'em_risco',
  'vip',
  'assinantes',
  'fiado',
] as const;
export type FiltroDaPorta = (typeof FILTROS_DA_PORTA)[number];

export interface ClienteNaPorta {
  readonly id: string;
  readonly nome: string;
  readonly telefoneMascarado: string | null;
  readonly segmento: Segmento | null;
  readonly ultimaVisitaEm: string | null;
  readonly proximaVisitaEm: string | null;
  readonly temHorarioHoje: boolean | null;
  readonly temFiado: boolean | null;
}

export interface PaginaDeClientes {
  readonly clientes: readonly ClienteNaPorta[];
  readonly total: number;
  readonly pagina: number;
  readonly porPagina: number;
  readonly paginas: number;
}

interface LinhaDaPagina {
  total_count: bigint;
  id: string | null;
  name: string | null;
  phone_e164: string | null;
  created_at: Date | null;
  last_visit: Date | null;
  next_visit: Date | null;
  has_today: boolean | null;
  balance_cents: number | null;
}

export const DIAS_DE_RECENCIA = 30;

const semAcento = (valor: string): string =>
  valor.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function segmentoDoFiltroDaPorta(filtro: FiltroDaPorta): Segmento | null {
  switch (filtro) {
    case 'em_risco': return 'em_risco';
    case 'vip': return 'vip';
    case 'assinantes': return 'assinante';
    default: return null;
  }
}

export function prepararBuscaDaPorta(busca = ''): {
  readonly nome: string | null;
  readonly telefone: string | null;
  readonly invalida: boolean;
} {
  const q = busca.trim();
  if (!q) return { nome: null, telefone: null, invalida: false };

  if (/^\+?[\d\s().-]+$/.test(q)) {
    const telefone = tryNormalizePhone(q);
    return telefone.ok
      ? { nome: null, telefone: telefone.phone, invalida: false }
      : { nome: null, telefone: null, invalida: true };
  }
  return { nome: semAcento(q), telefone: null, invalida: false };
}

async function paginaDoBanco(
  tx: TransactionClient,
  params: {
    readonly hoje: string;
    readonly filtro: FiltroDaPorta;
    readonly buscaNome: string | null;
    readonly buscaTelefone: string | null;
    readonly buscaInvalida: boolean;
    readonly limiteRecentes: Date;
    readonly podeVerAgenda: boolean;
    readonly podeVerFiado: boolean;
    readonly idsDoSegmento: readonly string[];
    readonly filtraSegmento: boolean;
    readonly limite: number;
    readonly offset: number;
  },
): Promise<readonly LinhaDaPagina[]> {
  return tx.$queryRaw<LinhaDaPagina[]>`
    WITH ultima AS (
      SELECT a.customer_id, max(a.service_starts_at) AS last_visit
        FROM appointments a
       WHERE a.status = 'completed'
       GROUP BY a.customer_id
    ),
    base AS (
      SELECT c.id, c.name, c.phone_e164, c.created_at, c.balance_cents,
             u.last_visit,
             coalesce(u.last_visit, c.created_at) AS activity_at
        FROM customers c
        LEFT JOIN ultima u ON u.customer_id = c.id
       WHERE c.anonymized_at IS NULL
         AND ${!params.buscaInvalida}
         AND (${params.buscaTelefone}::text IS NULL OR c.phone_e164 = ${params.buscaTelefone})
         AND (
           ${params.buscaNome}::text IS NULL
           OR sem_acento(lower(c.name)) LIKE '%' || ${params.buscaNome} || '%'
         )
         AND (
           ${params.filtro}::text <> 'recentes'
           OR coalesce(u.last_visit, c.created_at) >= ${params.limiteRecentes}
         )
         AND (
           ${params.filtro}::text <> 'fiado'
           OR (${params.podeVerFiado} AND c.balance_cents < 0)
         )
         AND (
           ${params.filtro}::text <> 'hoje'
           OR (
             ${params.podeVerAgenda}
             AND EXISTS (
               SELECT 1
                 FROM appointments a
                 JOIN locations l ON l.id = a.location_id
                WHERE a.customer_id = c.id
                  AND (a.service_starts_at AT TIME ZONE l.timezone)::date = ${params.hoje}::date
                  AND a.status <> ALL(${[...ESTADOS_QUE_LIBERAM_A_AGENDA]}::appointment_status[])
             )
           )
         )
         AND (
           NOT ${params.filtraSegmento}
           OR c.id = ANY(${params.idsDoSegmento}::uuid[])
         )
    ),
    meta AS (
      SELECT count(*)::bigint AS total_count FROM base
    ),
    pagina AS (
      SELECT * FROM base
       ORDER BY activity_at DESC, name
       LIMIT ${params.limite} OFFSET ${params.offset}
    )
    SELECT m.total_count,
           p.id, p.name, p.phone_e164, p.created_at, p.last_visit, p.balance_cents,
           CASE WHEN p.id IS NULL OR NOT ${params.podeVerAgenda} THEN NULL ELSE (
             SELECT min(a.service_starts_at)
               FROM appointments a
              WHERE a.customer_id = p.id
                AND a.status = ANY(${[...ESTADOS_EM_CURSO]}::appointment_status[])
                AND a.service_starts_at >= now()
           ) END AS next_visit,
           CASE WHEN p.id IS NULL OR NOT ${params.podeVerAgenda} THEN NULL ELSE EXISTS (
             SELECT 1
               FROM appointments a
               JOIN locations l ON l.id = a.location_id
              WHERE a.customer_id = p.id
                AND (a.service_starts_at AT TIME ZONE l.timezone)::date = ${params.hoje}::date
                AND a.status <> ALL(${[...ESTADOS_QUE_LIBERAM_A_AGENDA]}::appointment_status[])
           ) END AS has_today
      FROM meta m
      LEFT JOIN pagina p ON true
      ORDER BY p.activity_at DESC NULLS LAST, p.name NULLS LAST
  `;
}

export async function clientesNaPorta(params: {
  readonly tenantId: string;
  readonly hoje: string;
  readonly filtro?: FiltroDaPorta;
  readonly busca?: string;
  readonly pagina?: number;
  readonly porPagina?: number;
  readonly podeVerAgenda: boolean;
  readonly podeVerSegmento: boolean;
  readonly podeVerFiado: boolean;
  readonly agora?: Date;
}): Promise<PaginaDeClientes> {
  const filtro = params.filtro ?? 'todos';
  const paginaPedida = Math.max(1, Math.floor(params.pagina ?? 1));
  const porPagina = Math.min(50, Math.max(10, Math.floor(params.porPagina ?? 30)));
  const agora = params.agora ?? new Date();
  const busca = prepararBuscaDaPorta(params.busca);
  const segmentoFiltrado = segmentoDoFiltroDaPorta(filtro);

  return withTenant(params.tenantId, async (tx) => {
    const segmentos = params.podeVerSegmento
      ? await segmentosDaBase(params.tenantId, agora, tx)
      : [];
    const segmentoPorId = new Map(segmentos.map((s) => [s.customerId, s.segmento]));
    const idsDoSegmento = segmentoFiltrado
      ? segmentos.filter((s) => s.segmento === segmentoFiltrado).map((s) => s.customerId)
      : [];

    // Filtro protegido sem permissão é vazio também no domínio. O controller já
    // responde 403; esta segunda barreira impede vazamento por chamador futuro.
    if (segmentoFiltrado && !params.podeVerSegmento) {
      return { clientes: [], total: 0, pagina: 1, porPagina, paginas: 1 };
    }
    if (filtro === 'hoje' && !params.podeVerAgenda) {
      return { clientes: [], total: 0, pagina: 1, porPagina, paginas: 1 };
    }
    if (filtro === 'fiado' && !params.podeVerFiado) {
      return { clientes: [], total: 0, pagina: 1, porPagina, paginas: 1 };
    }

    const limiteRecentes = new Date(agora.getTime() - DIAS_DE_RECENCIA * 86_400_000);
    const ler = (pagina: number) => paginaDoBanco(tx, {
      hoje: params.hoje,
      filtro,
      buscaNome: busca.nome,
      buscaTelefone: busca.telefone,
      buscaInvalida: busca.invalida,
      limiteRecentes,
      podeVerAgenda: params.podeVerAgenda,
      podeVerFiado: params.podeVerFiado,
      idsDoSegmento,
      filtraSegmento: segmentoFiltrado !== null,
      limite: porPagina,
      offset: (pagina - 1) * porPagina,
    });

    let linhas = await ler(paginaPedida);
    const totalBruto = linhas[0]?.total_count ?? 0n;
    const total = Number(totalBruto);
    if (!Number.isSafeInteger(total)) throw new Error('Quantidade de clientes ultrapassou o intervalo seguro.');
    const paginas = Math.max(1, Math.ceil(total / porPagina));
    const pagina = Math.min(paginaPedida, paginas);
    if (pagina !== paginaPedida && total > 0) linhas = await ler(pagina);

    const clientes = linhas
      .filter((linha): linha is LinhaDaPagina & { id: string; name: string } =>
        linha.id !== null && linha.name !== null,
      )
      .map((linha) => ({
        id: linha.id,
        nome: linha.name,
        telefoneMascarado: linha.phone_e164 === null ? null : maskPhone(linha.phone_e164),
        segmento: params.podeVerSegmento ? segmentoPorId.get(linha.id) ?? 'novo' : null,
        ultimaVisitaEm: linha.last_visit?.toISOString() ?? null,
        proximaVisitaEm: params.podeVerAgenda ? linha.next_visit?.toISOString() ?? null : null,
        temHorarioHoje: params.podeVerAgenda ? linha.has_today ?? false : null,
        temFiado: params.podeVerFiado ? (linha.balance_cents ?? 0) < 0 : null,
      }));

    return { clientes, total, pagina, porPagina, paginas };
  });
}
