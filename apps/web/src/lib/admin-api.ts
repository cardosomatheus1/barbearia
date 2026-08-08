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
  metodo: 'GET' | 'POST' | 'PUT' | 'DELETE',
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

// -- Fila presencial -----------------------------------------------------------

export type StatusNaFila = 'waiting' | 'called' | 'in_service' | 'done' | 'gave_up';

export interface PessoaNaFila {
  id: string;
  posicao: number;
  customerId: string;
  customerName: string;
  customerPhoneTail: string | null;
  status: StatusNaFila;
  services: string[];
  duracaoMinutos: number;
  preferidoId: string | null;
  professionalId: string | null;
  professionalName: string | null;
  esperaMinutos: number | null;
  esperandoHaMinutos: number;
  /** O encaixe passaria por cima de quem marcou. Não impede — avisa. */
  atrasaMarcado: boolean;
  frase: string;
}

export interface CadeiraNaFila {
  professionalId: string;
  professionalName: string;
  livreEmMinutos: number;
  proximoMarcado: string | null;
  proximoMarcadoEmMinutos: number | null;
}

export interface Fila {
  entries: PessoaNaFila[];
  cadeiras: CadeiraNaFila[];
  timezone: string;
  totals: {
    esperando: number;
    chamados: number;
    atendendo: number;
    desistiram: number;
    esperaMediaMinutos: number | null;
  };
}

export const filaDoBalcao = (token: string) =>
  chamar<Fila>('GET', '/v1/admin/queue', undefined, token);

export interface EncaixeNaCadeira {
  professionalId: string;
  professionalName: string;
  livreEmMinutos: number;
  cabe: boolean;
  sobraMinutos: number | null;
  invadeMinutos: number;
  proximoMarcado: string | null;
}

export const custoDoEncaixe = (token: string, serviceIds: string[]) =>
  chamar<{ cadeiras: EncaixeNaCadeira[] }>(
    'GET',
    `/v1/admin/queue/fit?serviceIds=${encodeURIComponent(serviceIds.join(','))}`,
    undefined,
    token,
  );

/**
 * Põe alguém na fila.
 *
 * A chave de idempotência vem de quem chama — nunca gerada aqui dentro, senão
 * cada reenvio traria uma chave nova e o duplo toque criaria duas entradas.
 */
export const entrarNaFila = (
  token: string,
  dados: {
    customerId?: string;
    name?: string;
    phone?: string;
    serviceIds: string[];
    professionalId?: string;
    notes?: string;
  },
  idempotencyKey: string,
) =>
  chamar<{ id: string; token: string; posicao: number }>(
    'POST',
    '/v1/admin/queue',
    dados,
    token,
    idempotencyKey,
  );

export const moverNaFila = (token: string, id: string, para: StatusNaFila) =>
  chamar<{ status: StatusNaFila }>('POST', `/v1/admin/queue/${id}/move`, { para }, token);

export const sentarDaFila = (token: string, id: string, professionalId: string) =>
  chamar<{ appointmentId: string; endsAt: string }>(
    'POST',
    `/v1/admin/queue/${id}/seat`,
    { professionalId },
    token,
  );

export interface MinhaPosicao {
  posicao: number;
  status: StatusNaFila;
  esperaMinutos: number | null;
  frase: string;
  nome: string;
  services: string[];
  professionalName: string | null;
}

/** A posição pelo link do celular. Sem sessão: o token é a credencial. */
export const minhaPosicaoNaFila = (slug: string, token: string) =>
  chamar<MinhaPosicao>(
    'GET',
    `/v1/b/${encodeURIComponent(slug)}/queue/${encodeURIComponent(token)}`,
  );

// -- Agenda do admin -----------------------------------------------------------

export type TipoDeExcecao = 'block' | 'day_off' | 'holiday' | 'vacation' | 'custom_hours';

export interface EntradaDaAgenda {
  id: string;
  professionalId: string;
  status: StatusAtendimento;
  start: string;
  end: string;
  /** Janela com buffer: é ela que explica o horário seguinte não estar livre. */
  occupiedStart: string;
  occupiedEnd: string;
  customerName: string | null;
  services: string[];
  priceCents: number;
}

export interface ExcecaoDaAgenda {
  id: string;
  kind: TipoDeExcecao;
  professionalId: string | null;
  start: string | null;
  end: string | null;
  reason: string | null;
}

export interface DiaDaAgenda {
  date: string;
  weekday: number;
  entries: EntradaDaAgenda[];
  exceptions: ExcecaoDaAgenda[];
}

export interface AgendaDoAdmin {
  timezone: string;
  from: string;
  to: string;
  today: string;
  professionals: { id: string; name: string }[];
  days: DiaDaAgenda[];
}

/** `from` ausente é "hoje na barbearia" — resolvido pelo servidor, com o fuso da unidade. */
export const agendaDoAdmin = (
  token: string,
  filtros: { from?: string; to?: string; professionalId?: string } = {},
) => {
  const busca = new URLSearchParams();
  if (filtros.from) busca.set('from', filtros.from);
  if (filtros.to) busca.set('to', filtros.to);
  if (filtros.professionalId) busca.set('professionalId', filtros.professionalId);
  return chamar<AgendaDoAdmin>('GET', `/v1/admin/agenda?${busca.toString()}`, undefined, token);
};

export interface ConflitoDaExcecao {
  appointmentId: string;
  start: string;
  customerName: string | null;
  professionalName: string;
}

export type ExcecaoGravada =
  | { saved: true; id: string; conflitos: ConflitoDaExcecao[] }
  | { saved: false; conflitos: ConflitoDaExcecao[] };

export interface NovaExcecao {
  kind: TipoDeExcecao;
  date: string;
  startMinute?: number | null;
  endMinute?: number | null;
  professionalId?: string;
  reason?: string;
  confirmarConflitos?: boolean;
}

/**
 * Duas rotas de propósito, não uma com `if`.
 *
 * Bloquear uma hora é operação de recepção (`appointments.create`); fechar a
 * barbearia no feriado muda o funcionamento e é do dono (`settings.manage`).
 * Uma rota só teria que exigir a permissão mais forte, e a recepcionista
 * passaria a chamar o dono para tirar uma hora do dia.
 */
export const criarBloqueio = (token: string, dados: NovaExcecao) =>
  chamar<ExcecaoGravada>('POST', '/v1/admin/agenda/blocks', dados, token);

export const criarExcecao = (token: string, dados: NovaExcecao) =>
  chamar<ExcecaoGravada>('POST', '/v1/admin/agenda/exceptions', dados, token);

export const removerExcecao = (token: string, id: string) =>
  chamar<{ deleted: boolean }>('DELETE', `/v1/admin/agenda/exceptions/${id}`, undefined, token);

export const moverAgendamento = (
  token: string,
  id: string,
  dados: { date: string; start: string; professionalId?: string },
) =>
  chamar<{ id: string; startsAt: string; professionalId: string }>(
    'POST',
    `/v1/admin/agenda/appointments/${id}/move`,
    dados,
    token,
  );
