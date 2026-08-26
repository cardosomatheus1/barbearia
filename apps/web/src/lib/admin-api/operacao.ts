import { ApiTimeoutError, fetchComTimeout } from '../fetch-com-timeout';
import type {
  AlertaDeEstoque,
  BaseDeComissao,
  Conversa,
  DesfechoDaRecuperacao,
  DirecaoDaConta,
  EstadoDaAssinatura,
  EstadoDaNota,
  EstadoDeCampanha,
  EstadoDoRecado,
  FormaDePagamento,
  ModoDeComissao,
  ModoDeFidelidade,
  MotivoDaContestacao,
  Papel,
  RegimeFiscal,
  ServiceTemplate,
  TipoDeCadeira,
  TipoDeExcecao,
  TipoDeMovimentoDeEstoque,
  TipoDeProduto,
  TipoDeRecado,
  TratamentoDaTaxa,
  TratamentoDoDesconto,
  AppointmentStatus,
  AttendanceAction,
} from '@barbearia/core';

import { BASE, chamar, type Resposta } from './core';

// -- Balcão -------------------------------------------------------------------

/**
 * Uma declaração só, reexportada — os dez estados moram em `core`.
 *
 * Ela era soletrada aqui, num arquivo que já importa vinte e quatro tipos do
 * domínio seis linhas acima. Um estado novo ganha rótulo obrigatório em
 * `ROTULO_DO_ESTADO` e `TOM_SEMANTICO_DO_ESTADO` — que são totais sobre a união
 * do `core` — e esta ficaria velha sem nada ficar vermelho: a API devolveria o
 * estado e a tela receberia um valor que o próprio tipo dela diz não existir.
 */
export type StatusAtendimento = AppointmentStatus;

/**
 * Idem: as oito ações são `ACOES` em `core`.
 *
 * `meu-dia/page.tsx` já importa `AttendanceAction as AcaoAtendimento` — as duas
 * declarações chegavam às mesmas funções e o `tsc` não via diferença.
 */
export type AcaoAtendimento = AttendanceAction;

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


export type FiltroDaPortaDeClientes =
  | 'todos'
  | 'recentes'
  | 'hoje'
  | 'em_risco'
  | 'vip'
  | 'assinantes'
  | 'fiado';

export interface ClienteNaPortaDoAdmin {
  id: string;
  nome: string;
  telefoneMascarado: string | null;
  segmento: 'novo' | 'ativo' | 'frequente' | 'vip' | 'em_risco' | 'perdido' | 'assinante' | null;
  ultimaVisitaEm: string | null;
  proximaVisitaEm: string | null;
  temHorarioHoje: boolean | null;
  temFiado: boolean | null;
}

export interface PaginaDaPortaDeClientes {
  clientes: ClienteNaPortaDoAdmin[];
  total: number;
  pagina: number;
  porPagina: number;
  paginas: number;
}

export const clientesNaPortaDoAdmin = (
  token: string,
  entrada: { hoje: string; filtro: FiltroDaPortaDeClientes; q?: string; pagina?: number },
) => {
  const params = new URLSearchParams({
    hoje: entrada.hoje,
    filtro: entrada.filtro,
    pagina: String(entrada.pagina ?? 1),
  });
  if (entrada.q?.trim()) params.set('q', entrada.q.trim());
  return chamar<PaginaDaPortaDeClientes>(
    'GET',
    `/v1/admin/customers/directory?${params.toString()}`,
    undefined,
    token,
  );
};

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
  slots: {
    start: string;
    end: string;
    professionalId: string;
    /**
     * O preço **daquele horário**, já com a faixa por horário aplicada.
     *
     * A rota sempre devolveu — é o mesmo `getAvailabilityRange` da página
     * pública, com `atCounter: true` — e este tipo o **apagava**. A tela do
     * balcão somava o catálogo e mostrava R$ 45,00 sobre um horário que
     * `resolveSlot` congela por R$ 49,50, porque o motor aplica a faixa
     * independentemente de quem está marcando.
     *
     * É exatamente o defeito que o bloco 105 consertou na página do cliente —
     * *"a tela dizia R$ 45,00 sobre um horário que `createAppointment`
     * congelava por R$ 54,00"* — e que ficou de pé na tela de quem atende o
     * telefone. `null` é grade sem faixa cadastrada.
     */
    price: number | null;
  }[];
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


export type AlvoDeUpload = 'cover' | 'logo' | 'professional' | 'service';

export async function enviarFotoDaBarbearia(
  token: string,
  alvo: AlvoDeUpload,
  arquivo: File,
  id?: string,
): Promise<Resposta<{ url: string; bytes: number; contentType: string }>> {
  const params = new URLSearchParams({ target: alvo });
  if (id) params.set('id', id);
  let resposta: Response;
  try {
    resposta = await fetchComTimeout(`${BASE}/v1/admin/photos/upload?${params.toString()}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': arquivo.type || 'application/octet-stream',
      },
      body: Buffer.from(await arquivo.arrayBuffer()),
      cache: 'no-store',
    }, 30_000);
  } catch (erro) {
    if (erro instanceof ApiTimeoutError) {
      return { ok: false, code: 'api_timeout', message: 'O envio demorou mais do que o esperado. Tente novamente.' };
    }
    return {
      ok: false,
      code: 'api_indisponivel',
      message: 'Não foi possível enviar a imagem porque o servidor não respondeu. Tente novamente.',
    };
  }
  if (!resposta.ok) {
    const corpo = (await resposta.json().catch(() => null)) as {
      error?: { code?: string; message?: string; detail?: unknown };
    } | null;
    return {
      ok: false,
      code: corpo?.error?.code ?? 'request_failed',
      message: corpo?.error?.message ?? 'Não foi possível enviar a imagem.',
      ...(corpo?.error?.detail !== undefined ? { detail: corpo.error.detail } : {}),
    };
  }
  return { ok: true, dados: (await resposta.json()) as { url: string; bytes: number; contentType: string } };
}

export async function removerFotoDaBarbearia(
  token: string,
  alvo: AlvoDeUpload,
  id?: string,
): Promise<Resposta<{ removed: boolean }>> {
  const params = new URLSearchParams({ target: alvo });
  if (id) params.set('id', id);
  return chamar<{ removed: boolean }>('DELETE', `/v1/admin/photos/upload?${params.toString()}`, undefined, token);
}

// -- Equipe -------------------------------------------------------------------

export type { Papel };

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
  /** O ganho de fazer o combo na sequência, em minutos (bloco 111). */
  comboToleranceMinutes: number;
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
  /** O ganho de fazer o combo na sequência, em minutos (bloco 111). */
  comboToleranceMinutes?: number;
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
  /** Os quatro do enum `professional_kind`. `station`/`room` nunca existiram. */
  kind: TipoDeCadeira;
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
  /** Página pública do barbeiro (bloco 73, SPEC §5.2). */
  perfilPublico: boolean;
  perfilSlug: string | null;
  especialidades: string[];
}

export const definirPerfilPublicoNaApi = (
  token: string,
  id: string,
  corpo: { ligado: boolean; especialidades: string[]; bio?: string },
) =>
  chamar<{ ligado: boolean; slug: string | null }>(
    'PUT',
    `/v1/admin/catalog/professionals/${id}/perfil-publico`,
    corpo,
    token,
  );

export interface EntradaDeProfissional {
  name: string;
  bio?: string | null;
  /** Os quatro do enum `professional_kind`. `station`/`room` nunca existiram. */
  kind: TipoDeCadeira;
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

export type { TipoDeRecado };
export type { EstadoDoRecado };

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

// -- Vitrine do marketplace (bloco 70) ---------------------------------------

export interface VitrineDaCasa {
  ligado: boolean;
  naVitrine: number;
  /** Quantas unidades **de fato** aparecem na busca (bloco 115). */
  listadas: number;
}

export const vitrineDaCasa = (token: string) =>
  chamar<VitrineDaCasa>('GET', '/v1/admin/vitrine', undefined, token);

export const definirVitrineNaApi = (token: string, ligado: boolean) =>
  chamar<{ ligado: boolean; unidades: number }>('PUT', '/v1/admin/vitrine', { ligado }, token);

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

export type { ModoDeFidelidade };

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

