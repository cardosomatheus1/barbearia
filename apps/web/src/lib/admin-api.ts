import type { Conversa, ServiceTemplate } from '@barbearia/core';

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
  metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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
  staff: {
    name: string;
    role: string;
    permissions: string[];
    professionalId: string | null;
    suporte?: boolean;
  };
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
    maxDiscountBps?: number;
    dpoName?: string;
    dpoEmail?: string;
  },
) => chamar<{ saved: boolean }>('PUT', '/v1/admin/change-window', dados, token);

export interface PoliticasDaCasa {
  cancelMinHours: number;
  rescheduleMinHours: number;
  maxReschedules: number;
  cancellationPolicy: string | null;
  maxDiscountBps: number;
  dpoName: string | null;
  dpoEmail: string | null;
}

export const politicasDaCasa = (token: string) =>
  chamar<PoliticasDaCasa>('GET', '/v1/admin/policies', undefined, token);

/**
 * Redefine o que um papel pode.
 *
 * Manda o conjunto inteiro, nunca um diff: com duas abas abertas, um diff
 * produziria uma concessão que ninguém pediu.
 */
export const salvarPermissoesDoPapel = (token: string, papel: string, permissoes: string[]) =>
  chamar<{ permissoes: string[] }>(
    'PUT',
    `/v1/admin/team/permissoes/${papel}`,
    { permissoes },
    token,
  );

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
  customerId: string | null;
  services: string[];
  priceCents: number;
  realDurationMinutes: number | null;
  /** Há quantos minutos está na cadeira. Instantâneo da carga, não cronômetro. */
  elapsedMinutes: number | null;
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
  /**
   * Contagem, nunca dinheiro.
   *
   * `realizadoCents` esteve declarado aqui e **a API nunca o mandou** — de
   * propósito: `/day` é rota de `appointments.view`, e faturamento é
   * `finance.view`, que exige segundo fator. Há teste na API que reprova se o
   * campo aparecer.
   *
   * O tipo mentia, e o TypeScript garantia que a tela lia um campo que nunca
   * chegava: o balcão exibiu "R$ NaN" no lugar do total do dia desde o bloco 11,
   * e só apareceu quando a tela foi aberta num navegador com conta de verdade.
   * O faturamento do dia mora em `/admin/painel`.
   */
  totals: {
    esperados: number;
    chegaram: number;
    atendendo: number;
    concluidos: number;
    faltaram: number;
    cancelados: number;
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
  hasAccount: boolean;
  phone: string | null;
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

// -- Comanda, caixa e fiado -----------------------------------------------------

/** Espelha `FORMAS_DE_PAGAMENTO` do core, que é o que a borda da API aceita. */
export type FormaDePagamento =
  | 'cash' | 'pix' | 'debit' | 'credit' | 'link' | 'transfer' | 'fiado';
export type TipoDeItemDaComanda = 'service' | 'product' | 'consumable';

export interface ItemDaComandaNaTela {
  id: string;
  tipo: TipoDeItemDaComanda;
  descricao: string;
  quantidade: number;
  precoUnitarioCents: number;
  professionalId: string | null;
  professionalName: string | null;
}

export interface Comanda {
  id: string;
  status: 'open' | 'paid' | 'cancelled';
  customerId: string | null;
  customerName: string | null;
  appointmentId: string | null;
  openedAt: string;
  closedAt: string | null;
  itens: ItemDaComandaNaTela[];
  gorjetaCents: number;
  subtotalCents: number;
  descontoCents: number;
  totalCents: number;
  trocoCents: number;
  pagamentos: { forma: FormaDePagamento; valorCents: number }[];
  /** Saldo e limite de quem vai pagar. Nulo quando a comanda é de avulso. */
  conta: { saldoCents: number; limiteCents: number } | null;
}

export interface MovimentoDoCaixa {
  id: string;
  kind: string;
  amountCents: number;
  reason: string | null;
  createdByName: string;
  createdAt: string;
}

export interface SessaoDeCaixa {
  id: string;
  status: 'open' | 'closed';
  openedByName: string;
  openedAt: string;
  openingCents: number;
  closedByName: string | null;
  closedAt: string | null;
  countedCents: number | null;
  expectedCents: number | null;
  differenceCents: number | null;
  movimentos: MovimentoDoCaixa[];
  esperadoAgoraCents: number | null;
}

export const caixaDaUnidade = (token: string) =>
  chamar<{ timezone: string; aberto: SessaoDeCaixa | null; historico: SessaoDeCaixa[] }>(
    'GET',
    '/v1/admin/cash',
    undefined,
    token,
  );

export const abrirOCaixa = (token: string, openingCents: number) =>
  chamar<{ id: string }>('POST', '/v1/admin/cash/open', { openingCents }, token);

export const movimentarOCaixa = (
  token: string,
  dados: { kind: 'withdrawal' | 'supply'; amountCents: number; reason: string },
) => chamar<{ ok: true }>('POST', '/v1/admin/cash/movements', dados, token);

/**
 * Fecha o caixa.
 *
 * O contado vai; o esperado só volta. É o fechamento cego da SPEC §3.10 — e ele
 * só é cego se a tela não souber o número antes de o operador contar.
 */
export const fecharOCaixa = (token: string, countedCents: number, notes?: string) =>
  chamar<{ esperadoCents: number; contadoCents: number; divergenciaCents: number }>(
    'POST',
    '/v1/admin/cash/close',
    { countedCents, ...(notes ? { notes } : {}) },
    token,
  );

export const comandaAberta = (token: string, id: string) =>
  chamar<Comanda>('GET', `/v1/admin/orders/${id}`, undefined, token);

export const abrirComandaNoBalcao = (
  token: string,
  dados: { appointmentId?: string; customerId?: string },
  idempotencyKey: string,
) => chamar<Comanda>('POST', '/v1/admin/orders', dados, token, idempotencyKey);

export const adicionarNaComanda = (
  token: string,
  id: string,
  dados: {
    tipo: TipoDeItemDaComanda;
    serviceId?: string;
    descricao: string;
    quantidade: number;
    precoUnitarioCents: number;
    professionalId?: string;
  },
) => chamar<Comanda>('POST', `/v1/admin/orders/${id}/items`, dados, token);

export const removerDaComanda = (token: string, id: string, itemId: string) =>
  chamar<Comanda>('DELETE', `/v1/admin/orders/${id}/items/${itemId}`, undefined, token);

export const ajustarAComanda = (
  token: string,
  id: string,
  dados: {
    desconto?: { tipo: 'amount' | 'percent'; valor: number; motivo?: string } | null;
    gorjetaCents?: number;
  },
) => chamar<Comanda>('PATCH', `/v1/admin/orders/${id}`, dados, token);

export const fecharAComanda = (
  token: string,
  id: string,
  pagamentos: { forma: FormaDePagamento; valorCents: number }[],
  idempotencyKey: string,
) => chamar<Comanda>('POST', `/v1/admin/orders/${id}/close`, { pagamentos }, token, idempotencyKey);

/** A cobrança online da comanda (blocos 35 e 36). */
export interface CobrancaDaComandaNaTela {
  id: string;
  orderId: string;
  meio: 'pix' | 'cartao' | 'link';
  valorCents: number;
  estado: 'aguardando' | 'pago' | 'recusado' | 'expirado';
  pagamentoId: string | null;
  pixCopiaECola: string | null;
  url: string | null;
  expiraEm: string | null;
  pagaEm: string | null;
  motivo: string | null;
  criadaPor: string;
  criadaEm: string;
}

export const cobrancasDaComanda = (token: string, orderId: string) =>
  chamar<{ cobrancas: CobrancaDaComandaNaTela[] }>(
    'GET',
    `/v1/admin/orders/${orderId}/charges`,
    undefined,
    token,
  );

export const cobrarComanda = (
  token: string,
  orderId: string,
  meio: 'pix' | 'cartao' | 'link',
  idempotencyKey: string,
) =>
  chamar<CobrancaDaComandaNaTela>(
    'POST',
    `/v1/admin/orders/${orderId}/charges`,
    { meio },
    token,
    idempotencyKey,
  );

export const cancelarCobrancaDaComanda = (token: string, orderId: string, chargeId: string) =>
  chamar<{ ok: true }>(
    'DELETE',
    `/v1/admin/orders/${orderId}/charges/${chargeId}`,
    undefined,
    token,
  );

export interface Devedor {
  id: string;
  name: string;
  saldoCents: number;
}

export const quemDeve = (token: string) =>
  chamar<{ devedores: Devedor[] }>('GET', '/v1/admin/debts', undefined, token);

export const receberDoFiado = (
  token: string,
  dados: { customerId: string; amountCents: number; forma: 'cash' | 'debit' | 'credit' | 'pix' },
) => chamar<{ saldoCents: number }>('POST', '/v1/admin/debts/receive', dados, token);

export interface FaturamentoDoDia {
  dia: string;
  recebidoCents: number;
  fiadoCents: number;
  gorjetaCents: number;
  porForma: { forma: FormaDePagamento; valorCents: number }[];
  comandas: number;
}

export const faturamentoDeHoje = (token: string, dia?: string) =>
  chamar<FaturamentoDoDia>(
    'GET',
    `/v1/admin/revenue${dia ? `?dia=${encodeURIComponent(dia)}` : ''}`,
    undefined,
    token,
  );

// -- Segundo fator --------------------------------------------------------------

export interface EstadoDoSegundoFator {
  ativo: boolean;
  pendente: boolean;
  obrigatorio: boolean;
  verificadoNestaSessao: boolean;
}

export const segundoFator = (token: string) =>
  chamar<EstadoDoSegundoFator>('GET', '/v1/admin/mfa', undefined, token);

export const comecarSegundoFator = (token: string) =>
  chamar<{ segredoBase32: string; uri: string }>('POST', '/v1/admin/mfa/setup', {}, token);

export const confirmarSegundoFator = (token: string, codigo: string) =>
  chamar<{ codigosDeRecuperacao: string[] }>('POST', '/v1/admin/mfa/confirm', { codigo }, token);

export const verificarSegundoFatorAgora = (token: string, codigo: string) =>
  chamar<{ usouRecuperacao: boolean; restantes: number }>(
    'POST',
    '/v1/admin/mfa/verify',
    { codigo },
    token,
  );

// -- Comissão -------------------------------------------------------------------

export type ModoDeComissao = 'percent' | 'fixed' | 'tiers';
export type BaseDeComissao = 'liquido' | 'bruto';
export type TratamentoDoDesconto = 'reduz_base' | 'custo_da_casa';
export type TratamentoDaTaxa = 'absorvida' | 'rateada';

export interface FaixaDeComissao {
  ateCents: number | null;
  pontosBase: number;
}

export interface LinhaDeComissao {
  professionalId: string;
  professionalName: string;
  baseCents: number;
  comissaoCents: number;
  lancamentos: number;
}

export interface ExtratoDeComissao {
  de: string;
  ate: string;
  linhas: LinhaDeComissao[];
  totalBaseCents: number;
  totalComissaoCents: number;
  /** Quem vendeu e nenhuma regra alcançou. Falta de configuração ≠ zero. */
  semRegra: { professionalName: string; itens: number }[];
}

/**
 * Duas rotas, e a tela escolhe pela permissão que ela já conhece.
 *
 * `/mine` serve o holerite de quem pergunta e não pede segundo fator; a raiz
 * serve a folha inteira e pede, porque `commission.view_all` está no grupo de
 * dinheiro. Uma rota só, decidindo por dentro, liberava a folha pela permissão
 * barata — foi o que a `/security-review` encontrou.
 */
export const comissaoDoPeriodo = (
  token: string,
  opcoes: { de?: string; ate?: string; daCasa?: boolean } = {},
) => {
  const busca = new URLSearchParams();
  if (opcoes.de) busca.set('de', opcoes.de);
  if (opcoes.ate) busca.set('ate', opcoes.ate);
  const query = busca.toString();
  const rota = opcoes.daCasa ? '/v1/admin/commission' : '/v1/admin/commission/mine';
  return chamar<ExtratoDeComissao>('GET', `${rota}${query ? `?${query}` : ''}`, undefined, token);
};

export interface FechamentoDeComissao {
  id: string;
  de: string;
  ate: string;
  fechadoEm: string;
  fechadoPor: string;
  linhas: { professionalName: string; baseCents: number; comissaoCents: number }[];
  totalCents: number;
}

export const fechamentosDeComissao = (token: string, daCasa = false) =>
  chamar<{ fechamentos: FechamentoDeComissao[] }>(
    'GET',
    daCasa ? '/v1/admin/commission/closures' : '/v1/admin/commission/mine/closures',
    undefined,
    token,
  );

export const fecharComissao = (token: string, dados: { de: string; ate: string; notas?: string }) =>
  chamar<{ id: string; linhas: LinhaDeComissao[] }>(
    'POST',
    '/v1/admin/commission/closures',
    dados,
    token,
  );

export interface RegraDeComissao {
  id: string;
  professionalId: string | null;
  serviceId: string | null;
  categoryId: string | null;
  modo: ModoDeComissao;
  valor: number;
  faixas: FaixaDeComissao[];
  professionalName: string | null;
  serviceName: string | null;
  categoryName: string | null;
}

export const regrasDeComissao = (token: string) =>
  chamar<{
    regras: RegraDeComissao[];
    configuracao: {
      base: BaseDeComissao;
      tratamentoDoDesconto: TratamentoDoDesconto;
      tratamentoDaTaxa: TratamentoDaTaxa;
    };
  }>('GET', '/v1/admin/commission/rules', undefined, token);

export const salvarRegraDeComissao = (
  token: string,
  dados: {
    professionalId?: string;
    serviceId?: string;
    categoryId?: string;
    modo: ModoDeComissao;
    valor: number;
    faixas?: FaixaDeComissao[];
  },
) => chamar<{ id: string }>('PUT', '/v1/admin/commission/rules', dados, token);

export const removerRegraDeComissao = (token: string, id: string) =>
  chamar<{ ok: true }>('DELETE', `/v1/admin/commission/rules/${id}`, undefined, token);

/** A alíquota do adquirente por meio de pagamento (bloco 36). */
export const aliquotasDoAdquirente = (token: string) =>
  chamar<{ aliquotas: { forma: string; bps: number }[] }>(
    'GET',
    '/v1/admin/commission/fees',
    undefined,
    token,
  );

export const salvarAliquotaDoAdquirente = (
  token: string,
  dados: { forma: string; bps: number },
) => chamar<{ ok: true }>('PUT', '/v1/admin/commission/fees', dados, token);

export const salvarConfiguracaoDeComissao = (
  token: string,
  dados: {
    base: BaseDeComissao;
    tratamentoDoDesconto: TratamentoDoDesconto;
    tratamentoDaTaxa: TratamentoDaTaxa;
  },
) => chamar<{ ok: true }>('PUT', '/v1/admin/commission/settings', dados, token);

// -- Avisos -------------------------------------------------------------------

export interface PreferenciasDeAviso {
  confirmacao: boolean;
  lembrete24h: boolean;
  lembrete2h: boolean;
  retorno: boolean;
  diasParaRetorno: number;
}

export type TipoDeAviso =
  | 'confirmacao' | 'lembrete_24h' | 'lembrete_2h'
  | 'sua_vez' | 'senha_de_acesso' | 'retorno';

export interface EnvioRegistrado {
  id: string;
  tipo: TipoDeAviso;
  enviadoEm: string;
  status: 'sent' | 'failed' | 'skipped';
  motivo: string | null;
  telefone: string | null;
  quem: string | null;
}

export const avisos = (token: string) =>
  chamar<{ settings: PreferenciasDeAviso; log: EnvioRegistrado[] }>(
    'GET',
    '/v1/admin/notifications',
    undefined,
    token,
  );

export const salvarAvisos = (token: string, dados: PreferenciasDeAviso) =>
  chamar<{ saved: boolean }>('PUT', '/v1/admin/notifications', dados, token);

// -- A ficha do cliente -------------------------------------------------------

export interface PreferenciasDoCliente {
  maquinaLaterais: string | null;
  tipoDegrade: string | null;
  topo: string | null;
  barbaEstilo: string | null;
  produtosEvitar: string | null;
  conversa: Conversa;
  observacoes: string | null;
}

export interface VisitaNaFicha {
  id: string;
  quando: string;
  status: string;
  profissional: string;
  servicos: string[];
  precoCents: number;
}

export interface FichaDoCliente {
  customerId: string;
  nome: string;
  /** Nulo depois da anonimização: o telefone é a coluna que mais identifica. */
  telefoneFinal: string | null;
  anonimizado: boolean;
  preferencias: PreferenciasDoCliente;
  anotadoEm: string | null;
  anotadoPor: string | null;
  linhaDoTempo: VisitaNaFicha[];
  visitas: number;
  desde: string | null;
}

export const fichaDoCliente = (token: string, customerId: string) =>
  chamar<FichaDoCliente>('GET', `/v1/admin/customers/${customerId}/ficha`, undefined, token);

export const salvarPreferenciasDoCliente = (
  token: string,
  customerId: string,
  dados: PreferenciasDoCliente,
) =>
  chamar<{ saved: boolean }>(
    'PUT',
    `/v1/admin/customers/${customerId}/preferences`,
    dados,
    token,
  );

export const convidarProfissional = (
  token: string,
  dados: { professionalId: string; email: string; phone?: string },
) =>
  chamar<{ member: { id: string; name: string }; senhaInicial: string; entrega: string }>(
    'POST',
    '/v1/admin/team/invite',
    dados,
    token,
  );

// -- Os números do barbeiro ---------------------------------------------------

export interface NumerosDoMes {
  faturamentoCents: number;
  atendimentos: number;
  ticketMedioCents: number;
  taxaDeRetorno: number;
  produtosVendidos: number;
}

export interface MeusNumeros {
  professionalId: string;
  professionalName: string;
  mes: string;
  hoje: NumerosDoMes;
  mesAtual: NumerosDoMes;
  mesAnterior: NumerosDoMes;
  variacaoDoFaturamento: number | null;
  meta: {
    metaCents: number;
    realizadoCents: number;
    percentual: number;
    faltamCents: number;
    esperadoAteHojeCents: number;
    noRitmo: boolean;
    porDiaRestanteCents: number;
  };
}

export const meusNumeros = (token: string) =>
  chamar<MeusNumeros>('GET', '/v1/admin/pro/me', undefined, token);

export interface MetaDoProfissional {
  professionalId: string;
  professionalName: string;
  mes: string;
  metaCents: number | null;
  anteriorCents: number | null;
}

export const metasDaCasa = (token: string) =>
  chamar<{ mes: string; metas: MetaDoProfissional[] }>(
    'GET',
    '/v1/admin/pro/goals',
    undefined,
    token,
  );

export const salvarMetaDoProfissional = (
  token: string,
  dados: { professionalId: string; mes: string; metaCents: number | null },
) => chamar<{ saved: boolean }>('PUT', '/v1/admin/pro/goals', dados, token);

// -- O painel do proprietário -------------------------------------------------

export interface Comparado {
  valor: number;
  anterior: number;
  variacao: number | null;
}

export interface PainelOperacional {
  dia: string;
  comparadoCom: string;
  agendamentos: Comparado;
  atendidos: Comparado;
  ocupacao: Comparado;
  noShow: Comparado;
  novosClientes: Comparado;
}

export interface PainelDeDinheiro {
  dia: string;
  comparadoCom: string;
  faturamentoCents: Comparado;
  ticketMedioCents: Comparado;
}

export const painelOperacional = (token: string, dia?: string) =>
  chamar<PainelOperacional>(
    'GET',
    `/v1/admin/dashboard${dia ? `?dia=${dia}` : ''}`,
    undefined,
    token,
  );

export const painelDeDinheiro = (token: string, dia?: string) =>
  chamar<PainelDeDinheiro>(
    'GET',
    `/v1/admin/dashboard/revenue${dia ? `?dia=${dia}` : ''}`,
    undefined,
    token,
  );

// -- O validador de catálogo --------------------------------------------------

export interface AchadoDoCatalogo {
  regra: string;
  severidade: 'bloqueia' | 'publicacao' | 'aviso';
  titulo: string;
  conserto: string;
  alvoId: string | null;
  alvoNome: string;
}

export const diagnosticoDoCatalogo = (token: string) =>
  chamar<{
    achados: AchadoDoCatalogo[];
    resumo: { bloqueia: number; publicacao: number; aviso: number };
    examinados: number;
  }>('GET', '/v1/admin/catalog/diagnosis', undefined, token);

// -- A trilha de auditoria ----------------------------------------------------

export interface EventoDaTrilha {
  id: string;
  actorName: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

/**
 * A trilha vem em duas, e não é detalhe de implementação.
 *
 * `settings.manage` lê conta, papel e segundo fator; `finance.view` — que exige
 * o segundo fator — lê caixa, comanda, fiado e comissão. Uma função só, com um
 * parâmetro escolhendo a rota, esconderia que são duas permissões diferentes de
 * quem lê este arquivo.
 */
export const trilhaDeAuditoria = (token: string, antesDe?: string) =>
  chamar<{ entries: EventoDaTrilha[]; proximoCursor: string | null }>(
    'GET',
    `/v1/admin/audit${antesDe ? `?antesDe=${antesDe}` : ''}`,
    undefined,
    token,
  );

export const trilhaDoDinheiro = (token: string, antesDe?: string) =>
  chamar<{ entries: EventoDaTrilha[]; proximoCursor: string | null }>(
    'GET',
    `/v1/admin/audit/finance${antesDe ? `?antesDe=${antesDe}` : ''}`,
    undefined,
    token,
  );

// -- Importação de base ------------------------------------------------------

export type VereditoDaLinha =
  | 'telefone_invalido'
  | 'sem_nome'
  | 'conflito'
  | 'repetido_no_arquivo'
  | 'ja_existe'
  | 'novo';

export interface LinhaComProblema {
  linha: number;
  veredito: VereditoDaLinha;
  nome: string;
  telefone: string;
  motivo?: string;
  conflitaCom?: string;
}

export interface ResumoDaImportacao {
  id: string;
  fileName: string;
  separator: string;
  status: 'previewed' | 'applied' | 'reverted';
  resumo: Record<VereditoDaLinha, number>;
  total: number;
  createdAt: string;
  appliedAt: string | null;
  revertedAt: string | null;
}

export interface PreviewDaImportacao extends ResumoDaImportacao {
  cabecalho: string[];
  colunas: Record<'nome' | 'telefone' | 'nascimento' | 'observacao', number | null>;
  problemas: LinhaComProblema[];
  repetida: boolean;
}

export const listarImportacoes = (token: string) =>
  chamar<{ imports: ResumoDaImportacao[] }>('GET', '/v1/admin/imports', undefined, token);

export const analisarImportacao = (
  token: string,
  corpo: { fileName: string; conteudo: string; separador?: string },
) => chamar<PreviewDaImportacao>('POST', '/v1/admin/imports', corpo, token);

export const aplicarImportacao = (token: string, id: string) =>
  chamar<{ criados: number; atualizados: number }>(
    'POST',
    `/v1/admin/imports/${id}/apply`,
    {},
    token,
  );

export const reverterImportacao = (token: string, id: string) =>
  chamar<{ apagados: number }>('POST', `/v1/admin/imports/${id}/revert`, {}, token);

export interface SlugDaCasa {
  slug: string;
  principal: boolean;
  criadoEm: string;
}

export const listarSlugs = (token: string) =>
  chamar<{ slugs: SlugDaCasa[] }>('GET', '/v1/admin/slugs', undefined, token);

export const adicionarSlug = (token: string, slug: string) =>
  chamar<{ slug: string }>('POST', '/v1/admin/slugs', { slug }, token);

export const lerImportacao = (token: string, id: string) =>
  chamar<ResumoDaImportacao & { problemas: LinhaComProblema[] }>(
    'GET',
    `/v1/admin/imports/${id}`,
    undefined,
    token,
  );

export interface PlanoDaBarbearia {
  plano: { code: string; nome: string; publico: string; precoCents: number };
  estado: 'trialing' | 'active' | 'past_due' | 'canceled';
  testeAte: string | null;
  periodoAte: string;
  cadeiras: { emUso: number; teto: number | null };
  cobranca: {
    bandeira: string | null;
    final: string | null;
    validadeMes: number | null;
    validadeAno: number | null;
    cadastrado: boolean;
  } | null;
  recursos: { code: string; nome: string; descricao: string; ligado: boolean; noPlano: boolean }[];
}

export const planoDaBarbearia = (token: string) =>
  chamar<PlanoDaBarbearia>('GET', '/v1/admin/plano', undefined, token);

export interface OpcaoDePlano {
  code: string;
  nome: string;
  publico: string;
  precoCents: number;
  tetoDeCadeiras: number | null;
  atual: boolean;
  impedimento: string | null;
  cobrarCents: number;
  creditarCents: number;
  diasRestantes: number;
}

export const opcoesDePlano = (token: string) =>
  chamar<OpcaoDePlano[]>('GET', '/v1/admin/plano/opcoes', undefined, token);

export interface FaturaDaBarbearia {
  id: string;
  tipo: 'subscription' | 'proration';
  estado: 'open' | 'paid' | 'void';
  planoCode: string;
  valorCents: number;
  vencimento: string;
  periodoDe: string;
  periodoAte: string;
  pagaEm: string | null;
  canceladaEm: string | null;
}

export const faturasDoPlano = (token: string) =>
  chamar<FaturaDaBarbearia[]>('GET', '/v1/admin/plano/faturas', undefined, token);

/**
 * Troca de plano com `Idempotency-Key`.
 *
 * A chave é obrigatória aqui e não opcional: subir de plano emite cobrança, e
 * o segundo clique do botão — ou o retry do navegador numa rede ruim — não pode
 * virar a segunda fatura.
 */
export const trocarDePlano = (token: string, planoCode: string, chave: string) =>
  chamar<{ cobrarCents: number; creditarCents: number; faturaId: string | null }>(
    'POST',
    '/v1/admin/plano',
    { planoCode },
    token,
    chave,
  );

// -- LGPD ---------------------------------------------------------------------

export interface DecisaoNaFicha {
  finalidade: 'service' | 'marketing' | 'photos' | 'photos_public';
  concedido: boolean;
  versaoDoTexto: string;
  decididoEm: string;
  registradoPeloBalcao: boolean;
}

export interface ConsentimentosNaFicha {
  atuais: Partial<
    Record<
      'service' | 'marketing' | 'photos' | 'photos_public',
      { concedido: boolean; versaoDoTexto: string; decididoEm: string }
    >
  >;
  historico: DecisaoNaFicha[];
}

export const consentimentosDaFicha = (token: string, customerId: string) =>
  chamar<ConsentimentosNaFicha>(
    'GET',
    `/v1/admin/customers/${customerId}/consentimentos`,
    undefined,
    token,
  );

export const registrarConsentimentoNoBalcao = (
  token: string,
  customerId: string,
  dados: { finalidade: string; concedido: boolean; versaoDoTexto: string },
) =>
  chamar<{ finalidade: string; concedido: boolean; decididoEm: string }>(
    'PUT',
    `/v1/admin/customers/${customerId}/consentimentos`,
    dados,
    token,
  );

export interface PedidoNaTela {
  id: string;
  tipo: 'export' | 'deletion';
  estado: 'open' | 'done' | 'refused';
  customerId: string | null;
  pedidoEm: string;
  venceEm: string;
  encerradoEm: string | null;
  nota: string | null;
}

export const pedidosDeDados = (token: string) =>
  chamar<{ pedidos: PedidoNaTela[] }>('GET', '/v1/admin/customers/lgpd/pedidos', undefined, token);

export const abrirPedidoDeDados = (token: string, customerId: string, tipo: string) =>
  chamar<{ id: string; venceEm: string }>(
    'POST',
    `/v1/admin/customers/${customerId}/lgpd/pedidos`,
    { tipo },
    token,
  );

export const encerrarPedidoDeDados = (
  token: string,
  pedidoId: string,
  dados: { atendido: boolean; nota?: string },
) =>
  chamar<{ ok: boolean }>('PUT', `/v1/admin/customers/lgpd/pedidos/${pedidoId}`, dados, token);

export const exportarDadosDoCliente = (token: string, customerId: string) =>
  chamar<Record<string, unknown>>(
    'GET',
    `/v1/admin/customers/${customerId}/dados`,
    undefined,
    token,
  );

/**
 * Apaga os dados de um cliente (bloco 32).
 *
 * A API exige `customers.anonymize`, que só o dono tem por padrão. Ela também
 * fecha o pedido de exclusão aberto, se houver — as duas coisas na mesma
 * transação, porque metade feita aqui não é detectável depois.
 */
export const anonimizarCliente = (token: string, customerId: string, motivo: string) =>
  chamar<{ anonimizou: boolean; pedidosFechados: number }>(
    'POST',
    `/v1/admin/customers/${customerId}/anonimizar`,
    { motivo },
    token,
  );

export interface CadastroParaSair {
  customerId: string;
  nome: string;
  ultimaInteracao: string;
  saiEm: string;
}

export const cadastrosParaSair = (token: string) =>
  chamar<{ cadastros: CadastroParaSair[]; prazoDeAvisoDias: number }>(
    'GET',
    '/v1/admin/customers/lgpd/retencao',
    undefined,
    token,
  );

// -- Segurança da conta (bloco 33) --------------------------------------------

export interface SessaoNaTela {
  id: string;
  atual: boolean;
  aparelho: string;
  criadaEm: string;
}

export interface SuporteNaTela {
  quem: string | null;
  motivo: string;
  abertoEm: string;
  expiraEm: string;
}

export const sessoesDaConta = (token: string) =>
  chamar<{ sessoes: SessaoNaTela[]; suporte: SuporteNaTela[] }>(
    'GET',
    '/v1/admin/sessoes',
    undefined,
    token,
  );

export const encerrarSessao = (token: string, id: string) =>
  chamar<{ encerradas: number }>('DELETE', `/v1/admin/sessoes/${id}`, undefined, token);

export const expulsarSuporte = (token: string) =>
  chamar<{ encerradas: number }>('DELETE', '/v1/admin/sessoes/suporte/tudo', undefined, token);

export interface PreferenciasDeAlerta {
  enviarCritico: boolean;
  enviarAviso: boolean;
  enviarRetencao: boolean;
}

export const preferenciasDeAlerta = (token: string) =>
  chamar<PreferenciasDeAlerta>('GET', '/v1/admin/alertas/preferencias', undefined, token);

export const salvarPreferenciasDeAlerta = (token: string, dados: PreferenciasDeAlerta) =>
  chamar<PreferenciasDeAlerta>('PUT', '/v1/admin/alertas/preferencias', dados, token);
