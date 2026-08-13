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
    creditScope?: 'empresa' | 'unidade';
    onlineBlockScore?: number | null;
    waitlistTrustedScore?: number;
    dpoName?: string;
    dpoEmail?: string;
    deposit?: PoliticaDeSinal;
  },
) => chamar<{ saved: boolean }>('PUT', '/v1/admin/change-window', dados, token);

// -- O sinal do horário (bloco 37) --------------------------------------------

export interface SinalDoHorario {
  appointmentId: string;
  exigidoCents: number;
  pagoCents: number;
  motivo: 'servico' | 'score' | 'ticket' | null;
  reembolso: 'devolver' | 'reter' | null;
  porqueDoReembolso: string | null;
}

export const sinalDoHorario = (token: string, id: string) =>
  chamar<SinalDoHorario>('GET', `/v1/admin/appointments/${id}/deposit`, undefined, token);

export const registrarSinal = (token: string, id: string, valorCents: number) =>
  chamar<SinalDoHorario>('POST', `/v1/admin/appointments/${id}/deposit`, { valorCents }, token);

export const devolverSinalDoHorario = (token: string, id: string) =>
  chamar<SinalDoHorario>('DELETE', `/v1/admin/appointments/${id}/deposit`, undefined, token);

export interface ConfiancaDoCliente {
  score: number;
  considerados: number;
  temEfeito: boolean;
  ajustadoAMao: boolean;
}

export const confiancaDoCliente = (token: string, customerId: string) =>
  chamar<ConfiancaDoCliente>(
    'GET',
    `/v1/admin/customers/${customerId}/reliability`,
    undefined,
    token,
  );

export const ajustarConfianca = (
  token: string,
  customerId: string,
  dados: { score: number | null; motivo: string },
) =>
  chamar<{ score: number | null; motivo: string | null; quando: string | null }>(
    'PUT',
    `/v1/admin/customers/${customerId}/reliability`,
    dados,
    token,
  );

/** A política de sinal, do jeito que a API a devolve e a recebe (bloco 37). */
export interface PoliticaDeSinal {
  mode: 'nenhum' | 'fixo' | 'percentual' | 'total';
  fixedCents: number;
  percentBps: number;
  scoreThreshold: number;
  ticketOverCents: number;
  refundHours: number;
}

export interface PoliticasDaCasa {
  cancelMinHours: number;
  rescheduleMinHours: number;
  maxReschedules: number;
  cancellationPolicy: string | null;
  maxDiscountBps: number;
  creditScope: 'empresa' | 'unidade';
  onlineBlockScore: number | null;
  waitlistTrustedScore: number;
  dpoName: string | null;
  dpoEmail: string | null;
  deposit: PoliticaDeSinal;
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
  /** O sinal deste horário. Nulo quando ele não pede — que é o caso comum. */
  deposit: {
    exigidoCents: number;
    pagoCents: number;
    motivo: 'servico' | 'score' | 'ticket';
    /** Nulo enquanto o horário está de pé — não há o que decidir ainda. */
    reembolso: { desfecho: 'devolver' | 'reter'; porque: string } | null;
  } | null;
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

/** Quem espera uma vaga (bloco 38). O balcão vê nome e os quatro últimos. */
/** O convite que esta pessoa tem na mão agora (bloco 39). */
export interface ConviteVivo {
  dia: string;
  hora: string;
  minutosRestantes: number;
}

export interface QuemEspera {
  id: string;
  customerId: string;
  customerNome: string;
  customerTelefoneFinal: string | null;
  de: string;
  ate: string;
  inicio: string;
  fim: string;
  servicos: string[];
  profissionalNome: string | null;
  entrouEm: string;
  convite: ConviteVivo | null;
}

export const moverAtendimento = (token: string, id: string, action: AcaoAtendimento) =>
  chamar<{ status: StatusAtendimento; esperando: QuemEspera[] }>(
    'POST',
    `/v1/admin/appointments/${id}/attendance`,
    { action },
    token,
  );

export const quemEsperaVaga = (token: string) =>
  chamar<{ esperando: QuemEspera[] }>('GET', '/v1/admin/agenda/espera', undefined, token);

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
  /** Este serviço sempre pede sinal, qualquer que seja o histórico (bloco 37). */
  alwaysRequireDeposit: boolean;
  componentIds: string[];
  /** Quantos clientes já têm hora marcada com ele — o que se perde ao desativar. */
  futureAppointments: number;
  /** A ficha de consumo: produtoId → quantidade (bloco 44). */
  consumiveis: Record<string, number>;
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
  alwaysRequireDeposit?: boolean;
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

// -- O convite de vaga (bloco 39) ---------------------------------------------

export type EstadoDoConvite = 'aberta' | 'aceitando' | 'aceita' | 'vencida' | 'cancelada';

export interface ConviteDeVaga {
  id: string;
  estado: EstadoDoConvite;
  venceEm: string;
  dia: string;
  hora: string;
  profissionalNome: string;
  servicos: string[];
  barbearia: string;
  minutosRestantes: number;
}

/** O convite pelo link da mensagem. Sem sessão: o token é a credencial. */
export const convitePorToken = (slug: string, token: string) =>
  chamar<ConviteDeVaga>(
    'GET',
    `/v1/b/${encodeURIComponent(slug)}/offer/${encodeURIComponent(token)}`,
  );

export const aceitarConvite = (slug: string, token: string) =>
  chamar<{ agendamentoId: string }>(
    'POST',
    `/v1/b/${encodeURIComponent(slug)}/offer/${encodeURIComponent(token)}/accept`,
  );

// -- Recados do cliente (bloco 40) --------------------------------------------

export type TipoDeRecado = 'sugestao' | 'reclamacao' | 'elogio';
export type EstadoDoRecado = 'aberto' | 'em_analise' | 'respondido' | 'encerrado';

export interface RecadoNaTela {
  id: string;
  tipo: TipoDeRecado;
  estado: EstadoDoRecado;
  texto: string;
  resposta: string | null;
  respondidoEm: string | null;
  criadoEm: string;
  diasEsperando: number;
  responsavelId: string | null;
  responsavelNome: string | null;
  clienteId: string | null;
  clienteNome: string | null;
  temContato: boolean;
  agendamentoId: string | null;
}

export const recadosDaFila = (token: string, incluirEncerrados = false) =>
  chamar<{ recados: RecadoNaTela[] }>(
    'GET',
    `/v1/admin/recados${incluirEncerrados ? '?incluirEncerrados=1' : ''}`,
    undefined,
    token,
  );

/** Assumir é sempre para si: quem assume sai da sessão, nunca do corpo. */
export const assumirRecadoNaApi = (token: string, id: string) =>
  chamar<{ assumido: boolean }>('POST', `/v1/admin/recados/${id}/assumir`, {}, token);

export const devolverRecadoNaApi = (token: string, id: string) =>
  chamar<{ devolvido: boolean }>('POST', `/v1/admin/recados/${id}/devolver`, {}, token);

export const responderRecadoNaApi = (token: string, id: string, resposta: string) =>
  chamar<{ enviada: boolean }>('POST', `/v1/admin/recados/${id}/responder`, { resposta }, token);

export const encerrarRecadoNaApi = (token: string, id: string) =>
  chamar<{ encerrado: boolean }>('POST', `/v1/admin/recados/${id}/encerrar`, {}, token);

// -- Preço por faixa de horário (bloco 68) -----------------------------------

export interface FaixaNaTela {
  id: string;
  diaDaSemana: number;
  inicioMinuto: number;
  fimMinuto: number;
  deltaBps: number;
}

export interface PrecificacaoNaTela {
  ligado: boolean;
  tetoBps: number;
  faixas: FaixaNaTela[];
}

export interface RecomendacaoNaTela {
  diaDaSemana: number;
  hora: number;
  ocupacaoBps: number;
  deltaBps: number;
  ganhoMensalCents: number;
}

export const precificacaoDaCasa = (token: string) =>
  chamar<PrecificacaoNaTela>('GET', '/v1/admin/precificacao', undefined, token);

export const recomendacoesDePreco = (token: string) =>
  chamar<{ recomendacoes: RecomendacaoNaTela[] }>(
    'GET',
    '/v1/admin/precificacao/recomendacoes',
    undefined,
    token,
  );

export const ligarPrecoPorFaixaNaApi = (token: string, ligado: boolean) =>
  chamar<PrecificacaoNaTela>('PUT', '/v1/admin/precificacao/ligado', { ligado }, token);

export const criarFaixaNaApi = (
  token: string,
  faixa: { diaDaSemana: number; inicioMinuto: number; fimMinuto: number; deltaBps: number },
) => chamar<PrecificacaoNaTela>('POST', '/v1/admin/precificacao/faixas', faixa, token);

export const apagarFaixaNaApi = (token: string, id: string) =>
  chamar<PrecificacaoNaTela>('DELETE', `/v1/admin/precificacao/faixas/${id}`, undefined, token);

// -- Insights proativos (bloco 67) -------------------------------------------

export interface InsightNaTela {
  tipo: string;
  titulo: string;
  texto: string;
  impactoCents: number;
  acao: { rotulo: string; destino: string; parametros: Record<string, string> };
}

export const insightsDoPainel = (token: string) =>
  chamar<{ insights: InsightNaTela[] }>('GET', '/v1/admin/insights', undefined, token);

// -- Recepção digital: as perguntas sem resposta (bloco 66) -------------------

export interface LacunaNaTela {
  id: string;
  /** Nulo quando o prazo de guarda do texto cru venceu — a linha continua. */
  pergunta: string | null;
  chave: string;
  vezes: number;
  primeiraVez: string;
  ultimaVez: string;
}

export const lacunasDaRecepcaoNaApi = (token: string) =>
  chamar<{ lacunas: LacunaNaTela[] }>('GET', '/v1/admin/recepcao/lacunas', undefined, token);

export const resolverLacunaNaApi = (token: string, id: string) =>
  chamar<{ resolvida: boolean }>(
    'POST',
    `/v1/admin/recepcao/lacunas/${id}/resolver`,
    {},
    token,
  );

// -- Fidelidade (bloco 41) ----------------------------------------------------

export type ModoDeFidelidade = 'nenhum' | 'pontos' | 'visitas' | 'cashback';

export interface ProgramaDeFidelidade {
  modo: ModoDeFidelidade;
  pontosPorReal: number;
  valorDoPontoCents: number;
  visitasParaPremio: number;
  cashbackBps: number;
  validadeDias: number | null;
  /** Onde o saldo vale: na rede ou só na loja em que foi ganho (bloco 59). */
  escopo: 'empresa' | 'unidade';
}

export interface LancamentoDeFidelidade {
  id: string;
  tipo: 'acumulo' | 'resgate' | 'expiracao' | 'ajuste';
  quantidade: number;
  escopo?: 'empresa' | 'unidade';
  /** O nome da loja, para o extrato responder "onde eu ganhei isso?". */
  unidade?: string | null;
  quando: string;
  venceEm: string | null;
  nota: string | null;
  baseCents: number | null;
}

export interface SaldoDeFidelidade {
  modo: ModoDeFidelidade;
  escopo: 'empresa' | 'unidade';
  saldo: number;
  /** Quanto do saldo vale em qualquer loja (bloco 59). */
  saldoCompartilhado: number;
  faltaParaPremio: number | null;
  extrato: LancamentoDeFidelidade[];
}

export const programaDeFidelidade = (token: string) =>
  chamar<ProgramaDeFidelidade>('GET', '/v1/admin/fidelidade/programa', undefined, token);

export const salvarProgramaDeFidelidade = (token: string, dados: ProgramaDeFidelidade) =>
  chamar<ProgramaDeFidelidade>('PUT', '/v1/admin/fidelidade/programa', dados, token);

export const saldoDeFidelidade = (token: string, customerId: string) =>
  chamar<SaldoDeFidelidade>(
    'GET',
    `/v1/admin/fidelidade/clientes/${customerId}`,
    undefined,
    token,
  );

export const ajustarSaldoDeFidelidade = (
  token: string,
  customerId: string,
  dados: { quantidade: number; motivo: string },
) =>
  chamar<SaldoDeFidelidade>(
    'POST',
    `/v1/admin/fidelidade/clientes/${customerId}/ajuste`,
    dados,
    token,
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
  | 'cash' | 'pix' | 'debit' | 'credit' | 'link' | 'transfer' | 'fiado' | 'fidelidade';
export type TipoDeItemDaComanda = 'service' | 'product' | 'consumable' | 'package';

export interface ItemDaComandaNaTela {
  id: string;
  tipo: TipoDeItemDaComanda;
  serviceId: string | null;
  descricao: string;
  quantidade: number;
  precoUnitarioCents: number;
  professionalId: string | null;
  professionalName: string | null;
}

export interface Comanda {
  id: string;
  /** `refunded` entrou no bloco 52: cobrada, e o dinheiro voltou. */
  status: 'open' | 'paid' | 'cancelled' | 'refunded';
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
    /** O pacote do catálogo que este item vende. Com ele o preço sai do catálogo. */
    packageId?: string;
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
  /** Quanto sai do saldo de fidelidade. A unidade é a do programa (bloco 41). */
  resgateQuantidade?: number,
  /** Qual serviço o pacote está cobrindo, quando há pagamento por pacote (bloco 42). */
  servicoDoPacote?: string,
) =>
  chamar<Comanda>(
    'POST',
    `/v1/admin/orders/${id}/close`,
    {
      pagamentos,
      ...(resgateQuantidade ? { resgateQuantidade } : {}),
      ...(servicoDoPacote ? { servicoDoPacote } : {}),
    },
    token,
    idempotencyKey,
  );

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
  /** A barbearia exige segundo fator para o financeiro (bloco 37). */
  exigidoNaBarbearia: boolean;
  /** Quem tem `team.manage` muda a exigência. Por padrão, só o dono. */
  podeMudarAExigencia: boolean;
}

export const segundoFator = (token: string) =>
  chamar<EstadoDoSegundoFator>('GET', '/v1/admin/mfa', undefined, token);

export const comecarSegundoFator = (token: string) =>
  chamar<{ segredoBase32: string; uri: string }>('POST', '/v1/admin/mfa/setup', {}, token);

export const confirmarSegundoFator = (token: string, codigo: string) =>
  chamar<{ codigosDeRecuperacao: string[] }>('POST', '/v1/admin/mfa/confirm', { codigo }, token);

export const definirPoliticaDeSegundoFator = (
  token: string,
  exigir: boolean,
  codigo?: string,
) =>
  chamar<{ exigir: boolean }>(
    'PUT',
    '/v1/admin/mfa/policy',
    { exigir, ...(codigo ? { codigo } : {}) },
    token,
  );

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
  /** A loja em que a visita aconteceu (bloco 59). Nula em base antiga. */
  unidade: string | null;
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
  /** O segmento e o ritmo (bloco 61). Sem nenhum valor em reais — ver a rota. */
  segmento: string;
  explicacaoDoSegmento: string;
  cicloDias: number | null;
  diasSemVir: number | null;
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
  /** A nota do mês e a do mês passado (bloco 43). Comparada com o próprio passado. */
  nota: { media: number | null; total: number };
  notaAnterior: { media: number | null; total: number };
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

export type PeriodoPainel = 'dia' | '7d' | 'mes';

export interface PainelOperacional {
  dia: string;
  periodo?: PeriodoPainel;
  inicio?: string;
  fim?: string;
  comparadoCom: string;
  agendamentos: Comparado;
  atendidos: Comparado;
  ocupacao: Comparado;
  noShow: Comparado;
  novosClientes: Comparado;
  equipe?: { professionalId: string; professionalName: string; ocupacao: number }[];
}

export interface PainelDeDinheiro {
  dia: string;
  periodo?: PeriodoPainel;
  inicio?: string;
  fim?: string;
  comparadoCom: string;
  faturamentoCents: Comparado;
  ticketMedioCents: Comparado;
  metaCents?: number;
  percentualMeta?: number;
  projecaoCents?: number;
  serie?: { dia: string; faturamentoCents: number }[];
}

export const painelOperacional = (token: string, dia?: string, periodo?: PeriodoPainel) => {
  const busca = new URLSearchParams();
  if (dia) busca.set('dia', dia);
  if (periodo) busca.set('periodo', periodo);
  const query = busca.toString();
  return chamar<PainelOperacional>(
    'GET',
    `/v1/admin/dashboard${query ? `?${query}` : ''}`,
    undefined,
    token,
  );
};

export const painelDeDinheiro = (token: string, dia?: string, periodo?: PeriodoPainel) => {
  const busca = new URLSearchParams();
  if (dia) busca.set('dia', dia);
  if (periodo) busca.set('periodo', periodo);
  const query = busca.toString();
  return chamar<PainelDeDinheiro>(
    'GET',
    `/v1/admin/dashboard/revenue${query ? `?${query}` : ''}`,
    undefined,
    token,
  );
};

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

// -- Pacotes (bloco 42) -------------------------------------------------------

export interface PacoteNoCatalogo {
  id: string;
  nome: string;
  serviceId: string;
  servicoNome: string;
  quantidade: number;
  precoCents: number;
  validadeDias: number | null;
  transferivel: boolean;
  ativo: boolean;
}

export interface PacoteDoCliente {
  id: string;
  serviceId: string;
  servicoNome: string;
  estado: 'ativo' | 'esgotado' | 'vencido' | 'reembolsado';
  total: number;
  usados: number;
  restam: number;
  venceEm: string | null;
  frase: string;
  valorDaUnidadeCents: number;
  precoCents: number;
  reembolsadoCents: number | null;
  /** Congelado na compra: só o que foi vendido transferível passa adiante. */
  transferivel: boolean;
}

export interface ReceitaDePacotes {
  dia: string;
  vendidoCents: number;
  reconhecidoCents: number;
  diferidoCents: number;
}

export const catalogoDePacotesNaApi = (token: string, todos = false) =>
  chamar<{ pacotes: PacoteNoCatalogo[] }>(
    'GET',
    `/v1/admin/pacotes/catalogo${todos ? '?todos=true' : ''}`,
    undefined,
    token,
  );

export const salvarPacoteNaApi = (
  token: string,
  dados: Omit<PacoteNoCatalogo, 'id' | 'servicoNome'>,
  id?: string,
) =>
  chamar<{ id: string }>(
    'PUT',
    id ? `/v1/admin/pacotes/catalogo/${id}` : '/v1/admin/pacotes/catalogo',
    dados,
    token,
  );

export const pacotesDoClienteNaApi = (token: string, customerId: string) =>
  chamar<{ pacotes: PacoteDoCliente[] }>(
    'GET',
    `/v1/admin/pacotes/clientes/${customerId}`,
    undefined,
    token,
  );

export const reembolsarPacoteNaApi = (token: string, id: string) =>
  chamar<{ valorCents: number }>(
    'POST',
    `/v1/admin/pacotes/clientes/pacotes/${id}/reembolsar`,
    {},
    token,
  );

export const receitaDePacotesNaApi = (token: string) =>
  chamar<ReceitaDePacotes>('GET', '/v1/admin/pacotes/receita', undefined, token);

// -- Avaliações (bloco 43) ----------------------------------------------------

export type DesfechoDaRecuperacao = 'contato' | 'retrabalho' | 'credito' | 'sem_retorno';

export interface AvaliacaoNaTela {
  id: string;
  nota: number;
  estrelas: string;
  comentario: string | null;
  clienteNome: string;
  profissionalNome: string | null;
  servicoNome: string | null;
  atendidoEm: string | null;
  criadaEm: string;
  publicada: boolean;
  horasRestantes: number;
  precisaDeAtitude: boolean;
  resolvidaEm: string | null;
  desfecho: DesfechoDaRecuperacao | null;
  resolucao: string | null;
  categorias: Partial<Record<'atendimento' | 'qualidade' | 'pontualidade' | 'ambiente', number>>;
}

export interface PainelDeAvaliacoes {
  media: number | null;
  total: number;
  mediaPublica: number | null;
  aRecuperar: AvaliacaoNaTela[];
  ultimas: AvaliacaoNaTela[];
}

export const painelDeAvaliacoesNaApi = (token: string) =>
  chamar<PainelDeAvaliacoes>('GET', '/v1/admin/avaliacoes', undefined, token);

export const avaliacoesDoClienteNaApi = (token: string, customerId: string) =>
  chamar<{ avaliacoes: AvaliacaoNaTela[] }>(
    'GET',
    `/v1/admin/avaliacoes/clientes/${customerId}`,
    undefined,
    token,
  );

export const tratarAvaliacaoNaApi = (
  token: string,
  id: string,
  dados: { desfecho: DesfechoDaRecuperacao; nota: string },
) => chamar<{ resolvida: boolean }>('POST', `/v1/admin/avaliacoes/${id}/tratar`, dados, token);

// -- Estoque (bloco 44) -------------------------------------------------------

export type TipoDeProduto = 'resale' | 'internal';
export type TipoDeMovimentoDeEstoque =
  | 'entrada' | 'saida' | 'venda' | 'consumo' | 'perda' | 'ajuste' | 'transferencia';
export type AlertaDeEstoque = 'abaixo_do_minimo' | 'sem_estoque' | 'vencendo' | 'vencido';

export interface ProdutoNaTela {
  id: string;
  sku: string | null;
  barcode: string | null;
  nome: string;
  categoria: string | null;
  fornecedor: string | null;
  tipo: TipoDeProduto;
  custoCents: number;
  precoCents: number | null;
  minimo: number;
  unidade: string;
  venceEm: string | null;
  ativo: boolean;
  saldo: number;
  alertas: AlertaDeEstoque[];
  sugestaoDeCompra: number;
}

export interface MovimentoNaTela {
  id: string;
  tipo: TipoDeMovimentoDeEstoque;
  quantidade: number;
  custoUnitarioCents: number;
  motivo: string | null;
  quem: string | null;
  dia: string;
  quando: string;
}

export interface MargemDoServico {
  serviceId: string;
  nome: string;
  vezes: number;
  precoCents: number;
  comissaoCents: number;
  insumosCents: number;
  taxaCents: number;
  custoVariavelCents: number;
  margemCents: number;
  margemBps: number;
}

export interface RelatorioDeMargem {
  de: string;
  ate: string;
  servicos: MargemDoServico[];
  cmv: { vendaCents: number; consumoCents: number; perdaCents: number };
}

export const produtosNaApi = (token: string, todos = false) =>
  chamar<{ produtos: ProdutoNaTela[] }>(
    'GET',
    `/v1/admin/estoque/produtos${todos ? '?todos=true' : ''}`,
    undefined,
    token,
  );

export const salvarProdutoNaApi = (
  token: string,
  dados: Omit<ProdutoNaTela, 'id' | 'saldo' | 'alertas' | 'sugestaoDeCompra'>,
  id?: string,
) =>
  chamar<{ id: string }>(
    'PUT',
    id ? `/v1/admin/estoque/produtos/${id}` : '/v1/admin/estoque/produtos',
    dados,
    token,
  );

export const moverEstoqueNaApi = (
  token: string,
  dados: { produtoId: string; tipo: string; quantidade: number; motivo?: string },
) => chamar<{ lancado: boolean }>('POST', '/v1/admin/estoque/movimentos', dados, token);

export const movimentosNaApi = (token: string, produtoId: string) =>
  chamar<{ movimentos: MovimentoNaTela[] }>(
    'GET',
    `/v1/admin/estoque/produtos/${produtoId}/movimentos`,
    undefined,
    token,
  );

export const fichaNaApi = (token: string, serviceId: string) =>
  chamar<{ itens: { produtoId: string; nome: string; unidade: string; quantidade: number; custoUnitarioCents: number }[] }>(
    'GET',
    `/v1/admin/estoque/ficha/${serviceId}`,
    undefined,
    token,
  );

export const salvarFichaNaApi = (
  token: string,
  serviceId: string,
  itens: { produtoId: string; quantidade: number }[],
) => chamar<{ itens: number }>('PUT', `/v1/admin/estoque/ficha/${serviceId}`, { itens }, token);

export const margemNaApi = (token: string) =>
  chamar<RelatorioDeMargem>('GET', '/v1/admin/estoque/margem', undefined, token);

// -- Clube de assinatura (bloco 45) -------------------------------------------

export type EstadoDaAssinatura = 'ativa' | 'pendente' | 'inadimplente' | 'suspensa' | 'cancelada';

export interface BeneficioNaTela {
  serviceId: string;
  servicoNome: string;
  precoAvulsoCents: number;
  quantidade: number | null;
  cooldownDias: number;
}

export interface JanelaBloqueada {
  diaDaSemana: number | null;
  inicio: number;
  fim: number;
}

export interface PlanoNaTela {
  id: string;
  nome: string;
  descricao: string | null;
  precoCents: number;
  descontoEmProdutoBps: number;
  ativo: boolean;
  beneficios: BeneficioNaTela[];
  assinantes: number;
  janelaDeAgendamentoDias: number;
  bloqueios: JanelaBloqueada[];
  /** Onde o plano cobre: na rede ou só na unidade da adesão (bloco 59). */
  escopo: 'empresa' | 'unidade';
}

export interface AssinaturaDoCliente {
  id: string;
  planoNome: string;
  estado: EstadoDaAssinatura;
  precoCents: number;
  desdeEm: string;
  cicloDe: string;
  cicloAte: string;
  descontoEmProdutoBps: number;
  janelaDeAgendamentoDias: number;
  /** Até quando o plano vale, quando o cliente já pediu para sair (bloco 47). */
  valeAte: string | null;
  /** Desde quando o benefício está pausado por falta de pagamento. */
  pausadoDesde: string | null;
  bloqueios: JanelaBloqueada[];
  beneficios: {
    serviceId: string;
    servicoNome: string;
    quantidade: number | null;
    cooldownDias: number;
    usados: number;
    ultimoUso: string | null;
    liberaEm: string | null;
  }[];
}

export interface ClubeDaCasa {
  mrrCents: number;
  ativas: number;
  inadimplentes: number;
  porPlano: { planoId: string; nome: string; assinantes: number; mrrCents: number }[];
}

export const planosNaApi = (token: string, todos = false) =>
  chamar<{ planos: PlanoNaTela[] }>(
    'GET',
    `/v1/admin/clube/planos${todos ? '?todos=true' : ''}`,
    undefined,
    token,
  );

/**
 * O mesmo catálogo com a contagem de assinantes.
 *
 * Rota separada porque a contagem × preço é o faturamento recorrente da casa, e
 * ela exige `finance.view`. A lista aberta a quem monta a comanda vem com zero.
 */
export const planosContadosNaApi = (token: string, todos = false) =>
  chamar<{ planos: PlanoNaTela[] }>(
    'GET',
    `/v1/admin/clube/planos/contados${todos ? '?todos=true' : ''}`,
    undefined,
    token,
  );

export const salvarPlanoNaApi = (
  token: string,
  dados: Omit<PlanoNaTela, 'id' | 'assinantes' | 'beneficios' | 'bloqueios'> & {
    beneficios: { serviceId: string; quantidade: number | null; cooldownDias: number }[];
    bloqueios: JanelaBloqueada[];
  },
  id?: string,
) =>
  chamar<{ id: string }>(
    'PUT',
    id ? `/v1/admin/clube/planos/${id}` : '/v1/admin/clube/planos',
    dados,
    token,
  );

export const clubeNaApi = (token: string) =>
  chamar<ClubeDaCasa>('GET', '/v1/admin/clube', undefined, token);

/**
 * As mensalidades do clube (bloco 47).
 *
 * A rota exige `finance.view` **e** `customers.view`: a lista traz nome de gente
 * ao lado de valor, e rota que agrega declara todas as permissões do que devolve.
 */
export interface FaturaDoClubeNaTela {
  id: string;
  assinaturaId: string;
  cliente: string;
  clienteId: string;
  plano: string | null;
  valorCents: number;
  estado: 'aberta' | 'paga' | 'cancelada';
  periodoDe: string;
  periodoAte: string;
  vencimento: string;
  tentativas: number;
  ultimoErro: string | null;
  pagaEm: string | null;
  metodo: string | null;
  marcadaInadimplenteEm: string | null;
  diasAteSuspender: number | null;
}

export const faturasDoClubeNaApi = (token: string) =>
  chamar<{ faturas: FaturaDoClubeNaTela[] }>('GET', '/v1/admin/clube/faturas', undefined, token);

export const pagarFaturaNaApi = (token: string, id: string, metodo: string) =>
  chamar<{ pago: boolean }>('POST', `/v1/admin/clube/faturas/${id}/pagar`, { metodo }, token);

export const cancelarFaturaNaApi = (token: string, id: string, motivo: string) =>
  chamar<{ cancelada: boolean }>(
    'POST',
    `/v1/admin/clube/faturas/${id}/cancelar`,
    { motivo },
    token,
  );

export const agendarCancelamentoNaApi = (token: string, id: string, motivo: string) =>
  chamar<{ valeAte: string }>(
    'POST',
    `/v1/admin/clube/${id}/agendar-cancelamento`,
    { motivo },
    token,
  );

export const desfazerCancelamentoNaApi = (token: string, id: string) =>
  chamar<{ desfeito: boolean }>(
    'POST',
    `/v1/admin/clube/${id}/desfazer-cancelamento`,
    {},
    token,
  );

/**
 * A simulação dos três modelos de comissão sobre assinatura (bloco 48).
 *
 * `finance.view` sozinho: são três totais e nenhum nome. A rentabilidade, que
 * traz nome de gente, é outra rota e exige `customers.view` junto.
 */
export interface SimulacaoDaAssinaturaNaTela {
  receitaCents: number;
  atendimentos: number;
  emUso: 'por_uso' | 'rateio' | 'hibrido';
  modelos: {
    modo: 'por_uso' | 'rateio' | 'hibrido';
    comissaoCents: number;
    sobraCents: number;
    pesoBps: number;
  }[];
}

export interface RentabilidadeDoClubeNaTela {
  de: string;
  ate: string;
  modo: 'por_uso' | 'rateio' | 'hibrido';
  receitaCents: number;
  comissaoCents: number;
  insumoCents: number;
  margemCents: number;
  assinantes: {
    assinaturaId: string;
    cliente: string;
    plano: string | null;
    mensalidadeCents: number;
    usos: number;
    valorEntregueCents: number;
    comissaoCents: number;
    insumoCents: number;
    margemCents: number;
  }[];
}

export const simulacaoDaAssinaturaNaApi = (token: string) =>
  chamar<SimulacaoDaAssinaturaNaTela>('GET', '/v1/admin/clube/simulacao', undefined, token);

export const rentabilidadeDoClubeNaApi = (token: string) =>
  chamar<RentabilidadeDoClubeNaTela>('GET', '/v1/admin/clube/rentabilidade', undefined, token);

export const salvarModeloDaAssinaturaNaApi = (
  token: string,
  modo: string,
  tetoBps: number,
) => chamar<{ salvo: boolean }>('PUT', '/v1/admin/clube/modelo', { modo, tetoBps }, token);

export const assinaturaDoClienteNaApi = (token: string, customerId: string) =>
  chamar<{ assinatura: AssinaturaDoCliente | null }>(
    'GET',
    `/v1/admin/clube/clientes/${customerId}`,
    undefined,
    token,
  );

export const assinarNaApi = (token: string, customerId: string, planId: string) =>
  chamar<{ id: string }>('POST', '/v1/admin/clube/assinar', { customerId, planId }, token);

export const cancelarAssinaturaNaApi = (token: string, id: string, motivo: string) =>
  chamar<{ cancelada: boolean }>('POST', `/v1/admin/clube/${id}/cancelar`, { motivo }, token);

export interface DependenteNaTela {
  customerId: string;
  nome: string;
  usosNoCiclo: number;
}

export const dependentesNaApi = (token: string, subscriptionId: string) =>
  chamar<{ dependentes: DependenteNaTela[] }>(
    'GET',
    `/v1/admin/clube/${subscriptionId}/dependentes`,
    undefined,
    token,
  );

export const incluirDependenteNaApi = (token: string, subscriptionId: string, customerId: string) =>
  chamar<{ incluido: boolean }>(
    'POST',
    `/v1/admin/clube/${subscriptionId}/dependentes`,
    { customerId },
    token,
  );

export const removerDependenteNaApi = (token: string, subscriptionId: string, customerId: string) =>
  chamar<{ removido: boolean }>(
    'POST',
    `/v1/admin/clube/${subscriptionId}/dependentes/remover`,
    { customerId },
    token,
  );


/**
 * Split de pagamento (bloco 49, SPEC §3.5).
 *
 * `commission.view_all` para a lista da casa, `commission.view_own` para o
 * próprio — e o recorte por profissional é imposto pela API a partir da sessão,
 * nunca por parâmetro. Barbeiro que vê o repasse do colega é a mesma briga que
 * a separação das duas permissões existe para evitar.
 */
export interface RepasseNaTela {
  id: string;
  orderId: string;
  parte: 'barbearia' | 'profissional' | 'plataforma';
  professionalId: string | null;
  profissional: string | null;
  valorCents: number;
  estado: 'pendente' | 'retido' | 'liquidado' | 'falhou' | 'estornado';
  liquidadoEm: string | null;
  ultimoErro: string | null;
  quando: string;
}

export interface ConfiguracaoDoSplitNaTela {
  ligado: boolean;
  plataformaBps: number;
}

export const splitDoPeriodoNaApi = (token: string, de: string, ate: string) =>
  chamar<{ configuracao: ConfiguracaoDoSplitNaTela; repasses: RepasseNaTela[] }>(
    'GET',
    `/v1/admin/split?de=${de}&ate=${ate}`,
    undefined,
    token,
  );

export const meusRepassesNaApi = (token: string, de: string, ate: string) =>
  chamar<{ repasses: RepasseNaTela[] }>(
    'GET',
    `/v1/admin/split/meus?de=${de}&ate=${ate}`,
    undefined,
    token,
  );

/**
 * Só o interruptor: a alíquota da plataforma é termo comercial do produto e é
 * definida pelo Super Admin, nunca pela barbearia.
 */
export const salvarSplitNaApi = (token: string, ligado: boolean) =>
  chamar<{ salvo: boolean }>('PUT', '/v1/admin/split/configuracao', { ligado }, token);


/**
 * Quem já pode receber direto do adquirente (bloco 50).
 *
 * `retidoCents` é o número que move o dono: o cadastro no adquirente é
 * burocracia que ninguém faz por gosto, e "R$ 1.240 do Ruan passaram pela casa
 * porque ele não terminou o cadastro" é o que faz o cadastro acontecer.
 */
export interface RecebedorNaTelaAdmin {
  professionalId: string;
  nome: string;
  kyc: 'ausente' | 'pendente' | 'aprovado' | 'recusado';
  temRecebedor: boolean;
  motivo: string | null;
  atualizadoEm: string | null;
  retidoCents: number;
}

export const recebedoresNaApi = (token: string) =>
  chamar<{ recebedores: RecebedorNaTelaAdmin[] }>(
    'GET',
    '/v1/admin/split/recebedores',
    undefined,
    token,
  );

export const cadastrarRecebedorNaApi = (
  token: string,
  professionalId: string,
  dados: { documento: string; banco: string; agencia: string; conta: string },
) =>
  chamar<{ estado: string }>(
    'PUT',
    `/v1/admin/split/recebedores/${professionalId}`,
    dados,
    token,
  );

// -- Financeiro (bloco 51) ----------------------------------------------------

export type DirecaoDaConta = 'pagar' | 'receber';

export interface ContaDoFinanceiro {
  id: string;
  direcao: DirecaoDaConta;
  descricao: string;
  valorCents: number;
  vencimentoEm: string;
  estado: 'aberta' | 'paga' | 'cancelada';
  pagaEm: string | null;
  valorPagoCents: number | null;
  categoriaId: string | null;
  categoriaNome: string | null;
  contaId: string | null;
  contaNome: string | null;
  observacao: string | null;
  pagaPelaGaveta: boolean;
  vencida: boolean;
  prazo: string;
  criadaPor: string;
}

export interface AgendaDoFinanceiro {
  contas: ContaDoFinanceiro[];
  resumo: {
    aPagarCents: number;
    aReceberCents: number;
    vencidoAPagarCents: number;
    vencidoAReceberCents: number;
    saldoProjetadoCents: number;
  };
  hoje: string;
}

export interface CategoriaFinanceira {
  id: string;
  nome: string;
  direcao: DirecaoDaConta;
  ativa: boolean;
}

export interface ContaBancaria {
  id: string;
  nome: string;
  ehGaveta: boolean;
  locationId: string | null;
  ativa: boolean;
}

export interface TransferenciaDoFinanceiro {
  id: string;
  deNome: string;
  paraNome: string;
  valorCents: number;
  quandoEm: string;
  observacao: string | null;
  criadaPor: string;
}

export const agendaDoFinanceiro = (token: string, fechadas = false) =>
  chamar<AgendaDoFinanceiro>(
    'GET',
    `/v1/admin/financeiro/contas${fechadas ? '?fechadas=true' : ''}`,
    undefined,
    token,
  );

export const criarContaDoFinanceiro = (
  token: string,
  dados: {
    direcao: DirecaoDaConta;
    descricao: string;
    valorCents: number;
    vencimentoEm: string;
    categoriaId?: string | null;
    contaId?: string | null;
    observacao?: string | null;
  },
) => chamar<{ id: string }>('POST', '/v1/admin/financeiro/contas', dados, token);

export const quitarContaDoFinanceiro = (
  token: string,
  contaId: string,
  dados: { valorPagoCents: number; pagaEm: string; pelaGaveta: boolean },
) => chamar<{ ok: true }>('POST', `/v1/admin/financeiro/contas/${contaId}/quitar`, dados, token);

export const cancelarContaDoFinanceiro = (token: string, contaId: string, motivo: string) =>
  chamar<{ ok: true }>('POST', `/v1/admin/financeiro/contas/${contaId}/cancelar`, { motivo }, token);

export const categoriasDoFinanceiro = (token: string) =>
  chamar<{ categorias: CategoriaFinanceira[] }>(
    'GET',
    '/v1/admin/financeiro/categorias',
    undefined,
    token,
  );

export const criarCategoriaDoFinanceiro = (
  token: string,
  dados: { nome: string; direcao: DirecaoDaConta },
) => chamar<CategoriaFinanceira>('POST', '/v1/admin/financeiro/categorias', dados, token);

export const contasBancarias = (token: string) =>
  chamar<{ contas: ContaBancaria[] }>(
    'GET',
    '/v1/admin/financeiro/contas-bancarias',
    undefined,
    token,
  );

export const criarContaBancaria = (
  token: string,
  dados: { nome: string; locationId?: string | null; ehGaveta?: boolean },
) => chamar<ContaBancaria>('POST', '/v1/admin/financeiro/contas-bancarias', dados, token);

export const transferenciasDoFinanceiro = (token: string) =>
  chamar<{ transferencias: TransferenciaDoFinanceiro[] }>(
    'GET',
    '/v1/admin/financeiro/transferencias',
    undefined,
    token,
  );

export const transferirEntreContas = (
  token: string,
  dados: {
    deContaId: string;
    paraContaId: string;
    valorCents: number;
    quandoEm: string;
    observacao?: string | null;
  },
  idempotencyKey?: string,
) =>
  chamar<{ id: string }>(
    'POST',
    '/v1/admin/financeiro/transferencias',
    dados,
    token,
    idempotencyKey,
  );

export const definirLimiteDeFiado = (token: string, customerId: string, limiteCents: number) =>
  chamar<{ limiteCents: number }>(
    'PUT',
    `/v1/admin/financeiro/clientes/${customerId}/limite`,
    { limiteCents },
    token,
  );

export const lancarSaldoInicialDeFiado = (
  token: string,
  customerId: string,
  dados: { deveCents: number; motivo: string },
) =>
  chamar<{ saldoCents: number }>(
    'POST',
    `/v1/admin/financeiro/clientes/${customerId}/saldo-inicial`,
    dados,
    token,
  );

export const fiadoDoClienteNaApi = (token: string, customerId: string) =>
  chamar<{ saldoCents: number; limiteCents: number }>(
    'GET',
    `/v1/admin/financeiro/clientes/${customerId}/fiado`,
    undefined,
    token,
  );

// -- DRE, vale, estorno e transferência de pacote (bloco 52) ------------------

export interface VariacaoDaLinha {
  atualCents: number;
  anteriorCents: number;
  deltaCents: number;
  variacaoBps: number | null;
  sentido: 'melhorou' | 'piorou' | 'igual';
}

export interface LinhaDoDre extends VariacaoDaLinha {
  campo: string;
  rotulo: string;
  natureza: 'receita' | 'custo';
}

export interface DreNaTela {
  de: string;
  ate: string;
  comparadoDe: string;
  comparadoAte: string;
  atual: {
    receitaBrutaCents: number;
    custoTotalCents: number;
    resultadoCents: number;
    margemBps: number | null;
  };
  anterior: { resultadoCents: number; margemBps: number | null };
  linhas: LinhaDoDre[];
  receitaBruta: VariacaoDaLinha;
  resultado: VariacaoDaLinha;
}

export const dreNaApi = (token: string, de?: string, ate?: string) =>
  chamar<DreNaTela>(
    'GET',
    de && ate ? `/v1/admin/dre?de=${de}&ate=${ate}` : '/v1/admin/dre',
    undefined,
    token,
  );

export interface ValeNaTela {
  id: string;
  professionalId: string;
  professionalName: string;
  valorCents: number;
  concedidoEm: string;
  motivo: string | null;
  estado: 'aberto' | 'descontado' | 'cancelado';
  pelaGaveta: boolean;
  criadoPor: string;
}

export const valesNaApi = (token: string, de: string, ate: string) =>
  chamar<{ vales: ValeNaTela[] }>(
    'GET',
    `/v1/admin/vales?de=${de}&ate=${ate}`,
    undefined,
    token,
  );

export const tetoDoValeNaApi = (
  token: string,
  professionalId: string,
  de: string,
  ate: string,
) =>
  chamar<{ comissaoAcumuladaCents: number; jaAdiantadoCents: number; disponivelCents: number }>(
    'GET',
    `/v1/admin/vales/teto/${professionalId}?de=${de}&ate=${ate}`,
    undefined,
    token,
  );

export const adiantarNaApi = (
  token: string,
  dados: {
    professionalId: string;
    valorCents: number;
    de: string;
    ate: string;
    motivo?: string | null;
    pelaGaveta: boolean;
  },
  idempotencyKey?: string,
) => chamar<{ id: string }>('POST', '/v1/admin/vales', dados, token, idempotencyKey);

export const cancelarValeNaApi = (token: string, valeId: string, motivo: string) =>
  chamar<{ ok: true }>('POST', `/v1/admin/vales/${valeId}/cancelar`, { motivo }, token);

export const estornarVendaNaApi = (token: string, orderId: string, motivo: string) =>
  chamar<{ orderId: string; totalCents: number }>(
    'POST',
    `/v1/admin/comandas/${orderId}/estornar`,
    { motivo },
    token,
  );

export const transferirPacoteNaApi = (
  token: string,
  customerPackageId: string,
  dados: { paraCustomerId: string; motivo: string },
) =>
  chamar<{ unidadesMovidas: number }>(
    'POST',
    `/v1/admin/pacotes/${customerPackageId}/transferir`,
    dados,
    token,
  );

// -- Fiscal (bloco 53) --------------------------------------------------------

export type RegimeFiscal = 'simples' | 'mei' | 'salao_parceiro';
export type EstadoDaNota =
  | 'pendente'
  | 'processando'
  | 'autorizada'
  | 'rejeitada'
  | 'cancelada';

export interface ConfiguracaoFiscalNaTela {
  cnpj: string;
  regime: RegimeFiscal;
  codigoDeServico: string;
  issBps: number;
  municipioIbge: string;
  inscricaoMunicipal: string | null;
  emitirAutomaticamente: boolean;
}

export interface NotaNaTela {
  id: string;
  orderId: string;
  estado: EstadoDaNota;
  numero: string | null;
  linkPdf: string | null;
  motivoDaRecusa: string | null;
  regime: RegimeFiscal;
  servicoCents: number;
  /** Só chega para quem tem `commission.view_all`: é a comissão daquela venda. */
  parceiroCents?: number;
  casaCents?: number;
  issBps: number;
  clienteNome: string | null;
  pedidaEm: string;
  criadaPor: string;
}

export const configuracaoFiscalNaApi = (token: string) =>
  chamar<{ configuracao: ConfiguracaoFiscalNaTela | null }>(
    'GET',
    '/v1/admin/fiscal/configuracao',
    undefined,
    token,
  );

export const salvarFiscalNaApi = (
  token: string,
  dados: {
    cnpj: string;
    regime: RegimeFiscal;
    codigoDeServico: string;
    issBps: number;
    municipioIbge: string;
    inscricaoMunicipal?: string | null;
    emitirAutomaticamente: boolean;
  },
) => chamar<ConfiguracaoFiscalNaTela>('PUT', '/v1/admin/fiscal/configuracao', dados, token);

export const notasNaApi = (token: string, de: string, ate: string) =>
  chamar<{ notas: NotaNaTela[] }>(
    'GET',
    `/v1/admin/fiscal/notas?de=${de}&ate=${ate}`,
    undefined,
    token,
  );

export interface TomadorNaTela {
  readonly customerId: string | null;
  readonly nome: string | null;
  readonly documento: string | null;
}

export const notaDaComandaNaApi = (token: string, orderId: string) =>
  chamar<{ nota: NotaNaTela | null; tomador: TomadorNaTela | null }>(
    'GET',
    `/v1/admin/fiscal/notas/comanda/${orderId}`,
    undefined,
    token,
  );

export const salvarDocumentoDoTomadorNaApi = (
  token: string,
  customerId: string,
  documento: string | null,
) =>
  chamar<{ documento: string | null }>(
    'PUT',
    `/v1/admin/fiscal/tomador/${customerId}`,
    { documento },
    token,
  );

export const emitirNotaNaApi = (token: string, orderId: string) =>
  chamar<{ id: string | null }>('POST', `/v1/admin/fiscal/notas/comanda/${orderId}`, {}, token);

export const cancelarNotaNaApi = (token: string, notaId: string, motivo: string) =>
  chamar<{ ok: true }>('POST', `/v1/admin/fiscal/notas/${notaId}/cancelar`, { motivo }, token);

// -- WhatsApp (bloco 55) -----------------------------------------------------

export interface CadastroDoWhatsAppNaTela {
  readonly estado: 'nao_configurado' | 'aguardando_verificacao' | 'ativo' | 'suspenso';
  readonly phoneNumberId: string | null;
  readonly wabaId: string | null;
  readonly numeroVisivel: string | null;
  readonly motivo: string | null;
  readonly verificadoEm: string | null;
  /** **Se** existe token, nunca qual é: a tela não recebe credencial viva. */
  readonly temToken: boolean;
}

export interface TemplateNaTelaDoAdmin {
  readonly id: string;
  readonly tipo: string;
  readonly nome: string;
  readonly idioma: string;
  readonly estado: 'rascunho' | 'pendente' | 'aprovado' | 'rejeitado' | 'pausado';
  readonly corpo: string;
  readonly botoes: readonly string[];
  readonly motivoDaRecusa: string | null;
}

export const cadastroDoWhatsAppNaApi = (token: string) =>
  chamar<{ cadastro: CadastroDoWhatsAppNaTela | null }>(
    'GET',
    '/v1/admin/whatsapp/cadastro',
    undefined,
    token,
  );

export const salvarCadastroDoWhatsAppNaApi = (
  token: string,
  corpo: {
    phoneNumberId: string;
    wabaId: string;
    numeroVisivel: string | null;
    token?: string;
  },
) => chamar<CadastroDoWhatsAppNaTela>('PUT', '/v1/admin/whatsapp/cadastro', corpo, token);

export const templatesDoWhatsAppNaApi = (token: string) =>
  chamar<{ templates: readonly TemplateNaTelaDoAdmin[] }>(
    'GET',
    '/v1/admin/whatsapp/templates',
    undefined,
    token,
  );

export const submeterTemplateNaApi = (
  token: string,
  corpo: { tipo: string; nome: string; corpo: string },
) => chamar<TemplateNaTelaDoAdmin>('POST', '/v1/admin/whatsapp/templates', corpo, token);

// -- automação (bloco 56) ----------------------------------------------------

export interface AutomacaoNaTelaDoAdmin {
  readonly id: string;
  readonly nome: string;
  readonly gatilho: string;
  readonly limiar: number | null;
  readonly atrasoMinutos: number;
  readonly tipo: string;
  readonly objetivo: string;
  readonly janelaDias: number;
  readonly ativa: boolean;
  readonly enviadas: number;
  readonly alcancadas: number;
}

export const automacoesNaApi = (token: string) =>
  chamar<{ automacoes: readonly AutomacaoNaTelaDoAdmin[] }>(
    'GET',
    '/v1/admin/automacoes',
    undefined,
    token,
  );

export const salvarAutomacaoNaApi = (
  token: string,
  corpo: {
    id?: string;
    nome: string;
    gatilho: string;
    limiar: number | null;
    atrasoMinutos: number;
    tipo: string;
    objetivo: string;
    janelaDias: number;
    ativa: boolean;
  },
) => chamar<{ id: string }>('PUT', '/v1/admin/automacoes', corpo, token);

// -- campanhas e heatmap (bloco 57) ------------------------------------------

export interface CelulaNaTelaDoAdmin {
  readonly diaDaSemana: number;
  readonly hora: number;
  readonly minutosVendidos: number;
  readonly minutosDeJornada: number;
  readonly ocupacaoBps: number | null;
  readonly faixa: 'fechado' | 'fria' | 'morna' | 'cheia';
}

export interface CampanhaNaTelaDoAdmin {
  readonly id: string;
  readonly nome: string;
  readonly filtro: string;
  readonly valorDoFiltro: number | null;
  readonly diaDaSemana: number | null;
  readonly tipo: string;
  readonly estado: string;
  readonly criadaEm: string;
  readonly publico: number;
  readonly enviados: number;
  readonly entregues: number;
  readonly lidos: number;
  readonly cliques: number;
  readonly agendamentos: number;
  readonly receitaCents: number;
}

export const campanhasNaApi = (token: string) =>
  chamar<{
    campanhas: readonly CampanhaNaTelaDoAdmin[];
    grade: readonly CelulaNaTelaDoAdmin[];
  }>('GET', '/v1/admin/campanhas', undefined, token);

export const criarCampanhaNaApi = (
  token: string,
  corpo: {
    nome: string;
    filtro: string;
    valorDoFiltro: number | null;
    diaDaSemana: number | null;
    tipo: string;
    janelaDias: number;
  },
) => chamar<{ id: string; publico: number }>('POST', '/v1/admin/campanhas', corpo, token);

// -- Multiunidade (bloco 58) --------------------------------------------------

export interface UnidadeNaTelaDoAdmin {
  readonly id: string;
  readonly nome: string;
  readonly ativa: boolean;
}

export interface TransferenciaNaTelaDoAdmin {
  readonly id: string;
  readonly produto: string;
  readonly deNome: string;
  readonly paraNome: string;
  readonly quantidade: number;
  readonly quando: string;
  readonly quem: string;
  readonly nota: string | null;
}

export const unidadesNaApi = (token: string) =>
  chamar<{
    atual: { id: string; nome: string; timezone: string; today: string } | null;
    disponiveis: readonly UnidadeNaTelaDoAdmin[];
    falha: string | null;
  }>('GET', '/v1/admin/unidades', undefined, token);

export const escolherUnidadeNaApi = (token: string, unidadeId: string) =>
  chamar<{ ok: boolean }>('POST', '/v1/admin/unidades/escolher', { unidadeId }, token);

export const equipePorUnidadeNaApi = (token: string) =>
  chamar<{
    unidades: readonly UnidadeNaTelaDoAdmin[];
    equipe: readonly {
      id: string;
      nome: string;
      papel: string;
      unidades: readonly string[];
    }[];
  }>('GET', '/v1/admin/unidades/equipe', undefined, token);

export const definirUnidadesNaApi = (token: string, staffUserId: string, unidades: string[]) =>
  chamar<{ ok: boolean }>('POST', `/v1/admin/unidades/equipe/${staffUserId}`, { unidades }, token);

export const transferenciasNaApi = (token: string) =>
  chamar<{
    transferencias: readonly TransferenciaNaTelaDoAdmin[];
    produtos: readonly { id: string; nome: string; saldo: number }[];
    saldos: readonly { produtoId: string; unidadeId: string; saldo: number }[];
    unidades: readonly UnidadeNaTelaDoAdmin[];
  }>('GET', '/v1/admin/estoque/transferencias', undefined, token);

export const transferirEstoqueNaApi = (
  token: string,
  corpo: {
    produtoId: string;
    origemId: string;
    destinoId: string;
    quantidade: number;
    nota?: string | null;
  },
) => chamar<{ id: string }>('POST', '/v1/admin/estoque/transferencias', corpo, token);

export interface UnidadeDoCadastroNaTela {
  readonly id: string;
  readonly nome: string;
  readonly timezone: string;
  readonly ativa: boolean;
  readonly cidade: string | null;
}

export const cadastroDeUnidadesNaApi = (token: string) =>
  chamar<{ unidades: readonly UnidadeDoCadastroNaTela[] }>(
    'GET',
    '/v1/admin/unidades/cadastro',
    undefined,
    token,
  );

export const abrirUnidadeNaApi = (
  token: string,
  corpo: { nome: string; timezone: string; cidade?: string | null },
) => chamar<{ id: string }>('POST', '/v1/admin/unidades/cadastro', corpo, token);

export const definirUnidadeAtivaNaApi = (token: string, id: string, ativa: boolean) =>
  chamar<{ ok: boolean }>('POST', `/v1/admin/unidades/cadastro/${id}`, { ativa }, token);

export interface RecusaOnlineNaTela {
  readonly id: string;
  readonly clienteNome: string | null;
  readonly quando: string;
  readonly queria: string;
}

export const recusasOnlineNaApi = (token: string) =>
  chamar<{ recusas: readonly RecusaOnlineNaTela[] }>(
    'GET',
    '/v1/admin/recusas-online',
    undefined,
    token,
  );

// -- Segmentação da base (bloco 61) -------------------------------------------

export interface SegmentoNaTela {
  readonly chave: string;
  readonly rotulo: string;
  readonly quantos: number;
}

export interface ClienteEmRiscoNaTela {
  readonly customerId: string;
  readonly nome: string;
  readonly cicloDias: number;
  readonly diasSemVir: number;
}

export const segmentosNaApi = (token: string) =>
  chamar<{
    segmentos: readonly SegmentoNaTela[];
    emRisco: readonly ClienteEmRiscoNaTela[];
  }>('GET', '/v1/admin/segments', undefined, token);

// -- Retenção e crescimento (bloco 62) ----------------------------------------

export interface MotivoDeChurnNaTela {
  readonly sinal: string;
  readonly frase: string;
}

export interface ClienteEmChurnNaTela {
  readonly customerId: string;
  readonly nome: string;
  readonly risco: number;
  readonly faixa: string;
  readonly rotuloDaFaixa: string;
  readonly motivos: readonly MotivoDeChurnNaTela[];
  readonly cicloDias: number | null;
  readonly diasSemVir: number | null;
}

export const churnNaApi = (token: string) =>
  chamar<{ clientes: readonly ClienteEmChurnNaTela[]; avaliados: number }>(
    'GET',
    '/v1/admin/churn',
    undefined,
    token,
  );

export interface PontoDaSerieNaTela {
  readonly dia: string;
  readonly valorCents: number;
}

export interface CrescimentoNaTelaDoAdmin {
  readonly de: string;
  readonly ate: string;
  readonly retencaoBps: number | null;
  readonly churnBps: number | null;
  readonly valorPorClienteCents: number | null;
  readonly receitaPorCadeiraCents: number | null;
  readonly receitaPorHoraCents: number | null;
  readonly serie: {
    readonly pontos: readonly PontoDaSerieNaTela[];
    readonly maximoCents: number;
    readonly totalCents: number;
    readonly mediaCents: number | null;
  };
}

export const crescimentoNaApi = (token: string, de: string, ate: string) =>
  chamar<CrescimentoNaTelaDoAdmin>(
    'GET',
    `/v1/admin/crescimento?de=${de}&ate=${ate}`,
    undefined,
    token,
  );

// -- Assistente do gestor (blocos 63 e 64) ------------------------------------

export interface FatiaNaTela {
  readonly rotulo: string | null;
  readonly valor: number | null;
  readonly formatado: string;
}

export interface RespostaDoAssistente {
  readonly entendi: boolean;
  readonly confianca?: number;
  readonly metrica?: string;
  readonly rotulo?: string;
  readonly significado?: string;
  readonly de?: string;
  readonly ate?: string;
  readonly dimensao?: string;
  readonly subirEBom?: boolean;
  readonly tela?: string;
  readonly total?: number | null;
  readonly totalFormatado?: string;
  readonly fatias?: readonly FatiaNaTela[];
  readonly sugestoes?: readonly { readonly texto: string; readonly metrica: string }[];
}

export const conversarNaApi = (token: string, texto: string) =>
  chamar<RespostaDoAssistente>('POST', '/v1/admin/metricas/conversar', { texto }, token);

export const catalogoDeMetricasNaApi = (token: string) =>
  chamar<{
    metricas: readonly { readonly chave: string; readonly rotulo: string }[];
    sugestoes: readonly { readonly texto: string; readonly metrica: string }[];
  }>('GET', '/v1/admin/metricas', undefined, token);
