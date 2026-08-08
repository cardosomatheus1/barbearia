import type { ServiceTemplate } from '@barbearia/core';

/**
 * Cliente da API do painel.
 *
 * Sempre `no-store`: o painel mostra o que a barbearia acabou de salvar, e
 * qualquer cache aqui faria a etapa seguinte trabalhar sobre dado velho.
 */

const BASE = process.env['API_URL'] ?? 'http://127.0.0.1:3000';

export type Resposta<T> =
  | { ok: true; dados: T }
  | { ok: false; code: string; message: string; detail?: unknown };

async function chamar<T>(
  metodo: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  token?: string,
  idempotencyKey?: string,
): Promise<Resposta<T>> {
  const resposta = await fetch(`${BASE}${path}`, {
    method: metodo,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });

  if (!resposta.ok) {
    const corpo = (await resposta.json().catch(() => null)) as {
      error?: { code?: string; message?: string; detail?: unknown };
    } | null;
    return {
      ok: false,
      code: corpo?.error?.code ?? 'request_failed',
      message: corpo?.error?.message ?? 'Não foi possível salvar. Tente de novo.',
      ...(corpo?.error?.detail !== undefined ? { detail: corpo.error.detail } : {}),
    };
  }

  return { ok: true, dados: (await resposta.json()) as T };
}

export interface SessaoGestor {
  token: string;
  expiresAt: string;
  tenantId: string;
  slug: string;
  name: string;
  role: string;
  mustChangePassword?: boolean;
}

/**
 * Cria a conta.
 *
 * Não devolve sessão: a API responde igual para e-mail livre e já cadastrado,
 * para não revelar quem é dono de barbearia na plataforma. O passo seguinte é
 * sempre o login.
 */
export const criarConta = (dados: {
  name: string;
  email: string;
  password: string;
  phone: string;
  businessName: string;
}) => chamar<{ next: string }>('POST', '/v1/admin/signup', dados);

export const entrarComoGestor = (email: string, password: string) =>
  chamar<SessaoGestor>('POST', '/v1/admin/login', { email, password });

export const sairDoGestor = (token: string) =>
  chamar<{ revoked: boolean }>('POST', '/v1/admin/logout', {}, token);

export interface EstadoOnboarding {
  tenantId: string;
  businessName: string;
  slug: string;
  step: number;
  publishedAt: string | null;
  locationId: string;
  counts: { services: number; professionals: number; schedules: number };
  staff: { name: string; role: string; permissions: string[] };
}

export const estadoDoPainel = (token: string) =>
  chamar<EstadoOnboarding>('GET', '/v1/admin/state', undefined, token);

export const templatesDeServico = (token: string) =>
  chamar<{ templates: ServiceTemplate[] }>('GET', '/v1/admin/templates', undefined, token);

export const salvarEmpresa = (token: string, dados: Record<string, unknown>) =>
  chamar<{ slug: string }>('PUT', '/v1/admin/business', dados, token);

export const salvarServicos = (token: string, services: unknown[]) =>
  chamar<{ created: number }>('PUT', '/v1/admin/services', { services }, token);

export const salvarProfissionais = (token: string, professionals: unknown[]) =>
  chamar<{ created: number }>('PUT', '/v1/admin/professionals', { professionals }, token);

export const salvarPagamentos = (token: string, methods: string[]) =>
  chamar<{ saved: boolean }>('PUT', '/v1/admin/payments', { methods }, token);

export const publicarBarbearia = (token: string) =>
  chamar<{ slug: string; publishedAt: string }>('POST', '/v1/admin/publish', {}, token);

export const salvarJanela = (
  token: string,
  dados: {
    cancelMinHours: number;
    rescheduleMinHours: number;
    maxReschedules: number;
    cancellationPolicy?: string;
  },
) => chamar<{ saved: boolean }>('PUT', '/v1/admin/change-window', dados, token);

// -- Balcão -------------------------------------------------------------------

export type StatusAtendimento =
  | 'pending' | 'confirmed' | 'checked_in' | 'waiting' | 'in_progress'
  | 'completed' | 'cancelled_customer' | 'cancelled_business' | 'no_show' | 'rescheduled';

export type AcaoAtendimento =
  | 'confirm' | 'check_in' | 'wait' | 'start' | 'complete'
  | 'no_show' | 'undo_no_show' | 'cancel';

export type Pontualidade =
  | { kind: 'upcoming'; minutesUntil: number }
  | { kind: 'due' }
  | { kind: 'late'; minutesLate: number; noShowInMinutes: number }
  | { kind: 'no_show_due'; minutesLate: number };

export interface LinhaDoDia {
  id: string;
  status: StatusAtendimento;
  start: string;
  end: string;
  startsAt: string;
  professionalId: string;
  professionalName: string;
  customerName: string | null;
  customerPhoneTail: string | null;
  services: string[];
  priceCents: number;
  realDurationMinutes: number | null;
  waitingMinutes: number | null;
  punctuality: Pontualidade | null;
  actions: AcaoAtendimento[];
}

export interface PainelDoDia {
  date: string;
  today: string;
  timezone: string;
  noShowAfterMinutes: number;
  professionals: { id: string; name: string }[];
  entries: LinhaDoDia[];
  totals: {
    esperados: number;
    chegaram: number;
    atendendo: number;
    concluidos: number;
    faltaram: number;
    cancelados: number;
    realizadoCents: number;
  };
}

export const painelDoDia = (token: string, filtros: { date?: string; professionalId?: string } = {}) => {
  const busca = new URLSearchParams();
  if (filtros.date) busca.set('date', filtros.date);
  if (filtros.professionalId) busca.set('professionalId', filtros.professionalId);
  const query = busca.toString();
  return chamar<PainelDoDia>('GET', `/v1/admin/day${query ? `?${query}` : ''}`, undefined, token);
};

export const moverAtendimento = (token: string, id: string, action: AcaoAtendimento) =>
  chamar<{ status: StatusAtendimento }>(
    'POST',
    `/v1/admin/appointments/${id}/attendance`,
    { action },
    token,
  );

export interface ClienteEncontrado {
  id: string;
  name: string;
  phoneMasked: string;
  lastVisitAt: string | null;
  noShows: number;
}

export const buscarClientes = (token: string, q: string) =>
  chamar<{ customers: ClienteEncontrado[] }>(
    'GET',
    `/v1/admin/customers?q=${encodeURIComponent(q)}`,
    undefined,
    token,
  );

export interface CatalogoDoBalcao {
  services: { id: string; name: string; durationMinutes: number; priceCents: number }[];
  professionals: { id: string; name: string }[];
  timezone: string;
}

export const catalogoDoBalcao = (token: string) =>
  chamar<CatalogoDoBalcao>('GET', '/v1/admin/catalog', undefined, token);

export interface DiaDaGrade {
  date: string;
  unavailableReason: string | null;
  slots: { start: string; end: string; professionalId: string }[];
}

export const gradeDoBalcao = (
  token: string,
  filtros: { serviceIds: string[]; professionalId?: string; dateFrom: string; dateTo?: string },
) => {
  const busca = new URLSearchParams({
    serviceIds: filtros.serviceIds.join(','),
    dateFrom: filtros.dateFrom,
  });
  if (filtros.professionalId) busca.set('professionalId', filtros.professionalId);
  if (filtros.dateTo) busca.set('dateTo', filtros.dateTo);
  return chamar<{ timezone: string; days: DiaDaGrade[] }>(
    'GET',
    `/v1/admin/availability?${busca.toString()}`,
    undefined,
    token,
  );
};

/**
 * Marca pelo balcão.
 *
 * A chave de idempotência vem de quem chama — nunca gerada aqui dentro, senão
 * cada reenvio traria uma chave nova e o duplo toque criaria dois horários.
 */
export const marcarNoBalcao = (
  token: string,
  dados: {
    customerId?: string;
    name?: string;
    phone?: string;
    professionalId: string;
    serviceIds: string[];
    date: string;
    start: string;
    notes?: string;
  },
  idempotencyKey: string,
) => chamar<{ id: string; startsAt: string }>(
  'POST',
  '/v1/admin/appointments',
  dados,
  token,
  idempotencyKey,
);

// -- Fotos --------------------------------------------------------------------

export interface AlvosDeFoto {
  coverUrl: string | null;
  logoUrl: string | null;
  professionals: { id: string; name: string; photoUrl: string | null }[];
  services: { id: string; name: string; photoUrl: string | null }[];
}

export const fotosDaBarbearia = (token: string) =>
  chamar<AlvosDeFoto>('GET', '/v1/admin/photos', undefined, token);

export const salvarFotos = (
  token: string,
  dados: {
    coverUrl?: string;
    logoUrl?: string;
    professionals?: { id: string; photoUrl: string }[];
    services?: { id: string; photoUrl: string }[];
  },
) => chamar<{ saved: number; photos: AlvosDeFoto }>('PUT', '/v1/admin/photos', dados, token);

// -- Equipe -------------------------------------------------------------------

export type Papel = 'owner' | 'manager' | 'receptionist' | 'professional';

export interface MembroDaEquipe {
  id: string;
  name: string;
  email: string;
  role: Papel;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  professionalId: string | null;
}

export interface Equipe {
  members: MembroDaEquipe[];
  /** O que cada papel pode, vindo da API — nunca de uma cópia da lista aqui. */
  permissionsByRole: Record<string, string[]>;
}

export const equipeDaBarbearia = (token: string) =>
  chamar<Equipe>('GET', '/v1/admin/team', undefined, token);

export const criarMembro = (
  token: string,
  dados: { name: string; email: string; role: Papel; phone?: string },
) =>
  chamar<{ member: MembroDaEquipe; senhaInicial: string }>(
    'POST',
    '/v1/admin/team',
    dados,
    token,
  );

export const trocarPapel = (token: string, id: string, role: Papel) =>
  chamar<{ changed: boolean }>('PUT', `/v1/admin/team/${id}/role`, { role }, token);

export const ligarMembro = (token: string, id: string, active: boolean) =>
  chamar<{ active: boolean }>('PUT', `/v1/admin/team/${id}/active`, { active }, token);

export const reemitirSenha = (token: string, id: string) =>
  chamar<{ senhaInicial: string }>('POST', `/v1/admin/team/${id}/reset-password`, {}, token);

export interface QuemSouEu {
  name: string;
  role: Papel;
  permissions: string[];
  mustChangePassword: boolean;
}

export const quemSouEu = (token: string) =>
  chamar<QuemSouEu>('GET', '/v1/admin/me', undefined, token);

export const trocarMinhaSenha = (
  token: string,
  currentPassword: string,
  newPassword: string,
) =>
  chamar<{ changed: boolean }>(
    'PUT',
    '/v1/admin/me/password',
    { currentPassword, newPassword },
    token,
  );

// -- Cadastro: catálogo, equipe, jornadas e recursos ---------------------------

export interface ServicoDoCatalogo {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  priceCents: number;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  bookableOnline: boolean;
  active: boolean;
  photoUrl: string | null;
  componentIds: string[];
  /** Quantos clientes já têm hora marcada com ele — o que se perde ao desativar. */
  futureAppointments: number;
}

export interface EntradaDeServico {
  name: string;
  description?: string | null;
  categoryName: string;
  priceCents: number;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  bookableOnline: boolean;
  componentIds?: string[];
}

export const catalogoDeServicos = (token: string) =>
  chamar<{ services: ServicoDoCatalogo[]; categories: { id: string; name: string }[] }>(
    'GET',
    '/v1/admin/catalog/services',
    undefined,
    token,
  );

export const criarServico = (token: string, dados: EntradaDeServico) =>
  chamar<{ id: string }>('POST', '/v1/admin/catalog/services', dados, token);

export const editarServico = (token: string, id: string, dados: EntradaDeServico) =>
  chamar<{ updated: boolean }>('PUT', `/v1/admin/catalog/services/${id}`, dados, token);

export const ligarServico = (token: string, id: string, active: boolean) =>
  chamar<{ active: boolean; futureAppointments: number }>(
    'PUT',
    `/v1/admin/catalog/services/${id}/active`,
    { active },
    token,
  );

export const exigenciasDoServico = (
  token: string,
  id: string,
  requirements: { resourceType: string; quantity: number }[],
) =>
  chamar<{ saved: boolean }>(
    'PUT',
    `/v1/admin/catalog/services/${id}/resources`,
    { requirements },
    token,
  );

export interface ProfissionalDoCadastro {
  id: string;
  name: string;
  kind: 'professional' | 'station' | 'room';
  bookableOnline: boolean;
  dailyLimit: number | null;
  active: boolean;
  photoUrl: string | null;
  bio: string | null;
  serviceIds: string[];
  weekdays: number[];
  futureAppointments: number;
}

export interface EntradaDeProfissional {
  name: string;
  bio?: string | null;
  kind: 'professional' | 'station' | 'room';
  bookableOnline: boolean;
  dailyLimit?: number | null;
  serviceIds?: string[];
}

export const equipeDoCadastro = (token: string) =>
  chamar<{ professionals: ProfissionalDoCadastro[] }>(
    'GET',
    '/v1/admin/catalog/professionals',
    undefined,
    token,
  );

export const criarProfissional = (token: string, dados: EntradaDeProfissional) =>
  chamar<{ id: string }>('POST', '/v1/admin/catalog/professionals', dados, token);

export const editarProfissional = (token: string, id: string, dados: EntradaDeProfissional) =>
  chamar<{ updated: boolean }>('PUT', `/v1/admin/catalog/professionals/${id}`, dados, token);

export interface HorarioForaDaJornada {
  appointmentId: string;
  startsAt: string;
  date: string;
  time: string;
  customerName: string | null;
}

export const ligarProfissional = (token: string, id: string, active: boolean) =>
  chamar<{ active: boolean; futuros: HorarioForaDaJornada[] }>(
    'PUT',
    `/v1/admin/catalog/professionals/${id}/active`,
    { active },
    token,
  );

export interface FaixaDaJornada {
  weekday: number;
  startMinute: number;
  endMinute: number;
  breaks: { start: number; end: number }[];
}

export const jornadaDoProfissional = (token: string, id: string) =>
  chamar<{ faixas: FaixaDaJornada[] }>(
    'GET',
    `/v1/admin/catalog/professionals/${id}/schedule`,
    undefined,
    token,
  );

/**
 * Grava a jornada.
 *
 * Sem `confirmarConflitos`, a API devolve `saved: false` com a lista de quem
 * ficaria fora e **não grava**. É de propósito: encolher a terça é operação
 * legítima, fazê-la sem ver os três clientes que já estavam marcados às 15h
 * não é.
 */
export const salvarJornada = (
  token: string,
  id: string,
  faixas: FaixaDaJornada[],
  confirmarConflitos = false,
) =>
  chamar<{ saved: boolean; conflitos: HorarioForaDaJornada[] }>(
    'PUT',
    `/v1/admin/catalog/professionals/${id}/schedule`,
    { faixas, confirmarConflitos },
    token,
  );

export interface RecursoDaUnidade {
  resourceType: string;
  capacity: number;
  usedBy: { serviceId: string; quantity: number }[];
}

export const recursosDaUnidade = (token: string) =>
  chamar<{ resources: RecursoDaUnidade[] }>('GET', '/v1/admin/catalog/resources', undefined, token);

export const salvarRecursos = (
  token: string,
  pools: { resourceType: string; capacity: number }[],
) => chamar<{ saved: boolean }>('PUT', '/v1/admin/catalog/resources', { pools }, token);
