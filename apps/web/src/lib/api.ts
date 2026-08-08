/**
 * Cliente da API pública.
 *
 * Roda no servidor durante o SSR: o HTML já sai com nome, serviços, preços,
 * endereço e horários dentro. O sistema analisado entrega uma casca vazia com
 * `<title>Agende online</title>`, então nenhum buscador indexa nada (defeito D6).
 */

const BASE = process.env['API_URL'] ?? 'http://127.0.0.1:3000';

export interface PublicService {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  durationMinutes: number;
  professionalIds: string[];
}

export interface PublicProfile {
  slug: string;
  name: string;
  logoUrl: string | null;
  instagram: string | null;
  location: {
    id: string; name: string; timezone: string;
    street: string | null; district: string | null; city: string | null;
    state: string | null; postalCode: string | null;
    latitude: number | null; longitude: number | null;
    phone: string | null; whatsapp: string | null;
    coverUrl: string | null; about: string | null;
    amenities: string[]; cancellationPolicy: string | null;
    /** Horas de antecedência que a API realmente aplica ao cancelamento. */
    cancelMinHours: number;
  };
  categories: { id: string | null; name: string; services: PublicService[] }[];
  bundles: { serviceId: string; name: string; priceCents: number; componentIds: string[] }[];
  professionals: { id: string; name: string; bio: string | null; photoUrl: string | null }[];
  hours: { weekday: number; opensAt: string | null; closesAt: string | null }[];
  open: { isOpen: boolean; detail: string };
  priceFromCents: number | null;
}

export interface DayAvailability {
  date: string;
  slots: {
    start: string;
    end: string;
    startsAt: string;
    professionalId: string;
    priceCents: number | null;
  }[];
  unavailableReason: string | null;
  waitlistAvailable: boolean;
}

async function get<T>(path: string, revalidate: number): Promise<T | null> {
  const response = await fetch(`${BASE}${path}`, { next: { revalidate } });
  if (!response.ok) return null;
  return (await response.json()) as T;
}

/**
 * Perfil da barbearia.
 *
 * Mesmo TTL da disponibilidade de propósito: o estado "Aberto/Fechado" sai
 * daqui e os horários saem de lá. Com TTLs diferentes, a página chega a dizer
 * "Fechado" enquanto lista horários livres para hoje.
 */
export const getProfile = (slug: string) => get<PublicProfile>(`/v1/b/${slug}`, 30);

export interface AvailabilityQuery {
  locationId: string;
  serviceIds: string[];
  dateFrom: string;
  dateTo?: string;
  professionalId?: string;
  anyProfessional?: boolean;
}

/**
 * Disponibilidade para um intervalo, já filtrada pelo profissional escolhido.
 *
 * `revalidate` é parâmetro porque a mesma consulta serve a dois propósitos com
 * exigências opostas: montar a grade (pode ser de meio minuto atrás) e decidir
 * em quem gravar (não pode).
 */
export async function getAvailability(
  slug: string,
  query: AvailabilityQuery,
  revalidate = 30,
): Promise<{ days: DayAvailability[] } | null> {
  const busca = new URLSearchParams({
    locationId: query.locationId,
    serviceIds: query.serviceIds.join(','),
    dateFrom: query.dateFrom,
  });
  if (query.dateTo) busca.set('dateTo', query.dateTo);
  if (query.professionalId) busca.set('professionalId', query.professionalId);
  if (query.anyProfessional) busca.set('anyProfessional', 'true');

  return get<{ days: DayAvailability[] }>(
    `/v1/b/${slug}/availability?${busca.toString()}`,
    revalidate,
  );
}

export interface CriarAgendamento {
  locationId: string;
  professionalId: string;
  serviceIds: string[];
  date: string;
  start: string;
  name: string;
  phone: string;
}

export type ResultadoAgendamento =
  | { ok: true; id: string }
  | { ok: false; code: string };

/**
 * Cria o agendamento.
 *
 * "Qualquer profissional" vira um id concreto aqui: o motor devolve o
 * profissional junto de cada horário, e é ele que vai no corpo. Mandar "any"
 * para a API faria o servidor escolher de novo, podendo cair em outra pessoa
 * entre a tela e a gravação.
 *
 * Essa consulta é **sem cache**. Com o cache de 30 s da grade, a resolução
 * apontaria para quem já foi ocupado nesse intervalo e a gravação seria
 * recusada — e continuaria sendo pelos 30 s inteiros, sem o cliente ter como
 * escapar. Aqui a resposta precisa ser do instante.
 */
export async function criarAgendamentoNaApi(
  slug: string,
  dados: CriarAgendamento,
): Promise<ResultadoAgendamento> {
  let professionalId = dados.professionalId;

  if (professionalId === 'any') {
    const disponibilidade = await getAvailability(
      slug,
      {
        locationId: dados.locationId,
        serviceIds: dados.serviceIds,
        dateFrom: dados.date,
        anyProfessional: true,
      },
      0,
    );
    const slot = disponibilidade?.days[0]?.slots.find((s) => s.start === dados.start);
    if (!slot) return { ok: false, code: 'slot_not_available' };
    professionalId = slot.professionalId;
  }

  const response = await fetch(`${BASE}/v1/b/${slug}/appointments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Deriva da escolha, não do relógio: reenvio do mesmo formulário — o
      // duplo toque clássico em rede lenta — devolve o mesmo agendamento.
      'idempotency-key': `${dados.phone}|${dados.date}|${dados.start}|${dados.serviceIds.join(',')}`,
    },
    body: JSON.stringify({
      locationId: dados.locationId,
      professionalId,
      serviceIds: dados.serviceIds,
      date: dados.date,
      start: dados.start,
      name: dados.name,
      phone: dados.phone,
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const corpo = (await response.json().catch(() => null)) as
      | { error?: { code?: string } }
      | null;
    return { ok: false, code: corpo?.error?.code ?? 'request_failed' };
  }

  const criado = (await response.json()) as { id: string };
  return { ok: true, id: criado.id };
}

/** Resposta de POST/GET autenticado: sucesso tipado ou código de falha. */
export type Resultado<T> = { ok: true; dados: T } | { ok: false; code: string };

async function post<T>(
  path: string,
  body: unknown,
  token?: string,
): Promise<Resultado<T>> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  if (!response.ok) {
    const corpo = (await response.json().catch(() => null)) as
      | { error?: { code?: string } }
      | null;
    return { ok: false, code: corpo?.error?.code ?? 'request_failed' };
  }
  return { ok: true, dados: (await response.json()) as T };
}

/**
 * Pede o código.
 *
 * A resposta é a mesma para telefone cadastrado e não cadastrado — é a API que
 * garante isso, e a tela não pode desfazer a garantia dizendo "não encontramos
 * esse número".
 */
export const pedirCodigo = (slug: string, phone: string) =>
  post<{ expiresInSeconds: number; resendAfterSeconds: number }>(
    `/v1/b/${slug}/auth/otp`,
    { phone },
  );

export interface SessaoCriada {
  token: string;
  expiresAt: string;
  customer: { id: string; name: string };
}

export const conferirCodigo = (slug: string, phone: string, code: string) =>
  post<SessaoCriada>(`/v1/b/${slug}/auth/verify`, { phone, code });

/** Revoga a sessão no servidor. Apagar só o cookie deixaria o token válido. */
export const encerrarSessao = (slug: string, token: string) =>
  post<{ revoked: boolean }>(`/v1/b/${slug}/auth/logout`, {}, token);

export interface AgendamentoDoCliente {
  id: string;
  state: 'active' | 'done' | 'cancelled' | 'rescheduled';
  startsAt: string;
  endsAt: string;
  status: string;
  professionalName: string;
  services: string[];
  serviceIds: string[];
  professionalId: string;
  priceCents: number;
  canCancel: boolean;
  canReschedule: boolean;
  blockedReason: 'too_late' | 'too_many_reschedules' | 'already_started' | null;
  minHoursToChange: number;
}

/**
 * Agendamentos do cliente da sessão.
 *
 * Devolve `null` quando a sessão não vale mais — expirada ou revogada — para a
 * página mandar entrar de novo em vez de mostrar lista vazia, que o cliente
 * leria como "meus agendamentos sumiram".
 */
export async function listarAgendamentos(
  slug: string,
  token: string,
): Promise<AgendamentoDoCliente[] | null> {
  const response = await fetch(`${BASE}/v1/b/${slug}/appointments`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const corpo = (await response.json()) as { appointments: AgendamentoDoCliente[] };
  return corpo.appointments;
}

export const cancelarAgendamento = (slug: string, token: string, id: string, reason?: string) =>
  post<{ cancelled: boolean }>(
    `/v1/b/${slug}/appointments/${id}/cancel`,
    reason ? { reason } : {},
    token,
  );

/**
 * Grade para remarcar um agendamento específico.
 *
 * Não é o `/availability` público: esta ignora o próprio horário do cliente na
 * ocupação, que é o que a gravação também faz. Com a estratégia `anchored` as
 * duas grades divergem, e a pública ofereceria horários recusados um a um.
 */
export interface DiaDeRemarcacao {
  date: string;
  unavailableReason: string | null;
  slots: { start: string; professionalId: string }[];
}

export async function opcoesDeRemarcacao(
  slug: string,
  token: string,
  id: string,
  dateFrom: string,
  professionalId?: string,
): Promise<DiaDeRemarcacao | null> {
  const busca = new URLSearchParams({ dateFrom });
  if (professionalId) busca.set('professionalId', professionalId);

  const response = await fetch(
    `${BASE}/v1/b/${slug}/appointments/${id}/availability?${busca.toString()}`,
    { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  if (!response.ok) return null;
  const corpo = (await response.json()) as { days: DiaDeRemarcacao[] };
  return corpo.days[0] ?? null;
}

export const remarcarAgendamento = (
  slug: string,
  token: string,
  id: string,
  quando: { date: string; start: string; professionalId?: string },
) => post<{ id: string }>(`/v1/b/${slug}/appointments/${id}/reschedule`, quando, token);

export interface Comprovante {
  id: string;
  /** A API já traduz os dez status do banco nos quatro que a tela distingue. */
  state: 'active' | 'done' | 'cancelled' | 'rescheduled';
  startsAt: string;
  endsAt: string;
  professionalName: string;
  services: string[];
  priceCents: number;
  locationId: string;
}

/**
 * Comprovante do agendamento.
 *
 * Sem cache: é o registro de um agendamento específico e muda quando o cliente
 * cancela. Cache aqui mostraria "confirmado" para um horário já desmarcado.
 */
export const getComprovante = (slug: string, id: string) =>
  get<Comprovante>(`/v1/b/${slug}/appointments/${id}`, 0);

/**
 * Disponibilidade de hoje.
 *
 * Cache de 30 s: é o herói da página e precisa estar quase ao vivo, mas
 * renderizar do zero a cada visita desperdiça o trabalho num link de bio que
 * recebe rajadas.
 */
export async function getToday(
  slug: string,
  locationId: string,
  serviceId: string,
  date: string,
): Promise<DayAvailability | null> {
  // `anyProfessional` colapsa em um cartão por horário. Sem isso a faixa mostra
  // "20:20 Ruan" e "20:20 Gleidson" lado a lado, gastando o espaço mais valioso
  // da página para repetir a mesma informação.
  const query = new URLSearchParams({
    locationId,
    serviceIds: serviceId,
    dateFrom: date,
    anyProfessional: 'true',
  });
  const result = await get<{ days: DayAvailability[] }>(
    `/v1/b/${slug}/availability?${query.toString()}`,
    30,
  );
  return result?.days[0] ?? null;
}
