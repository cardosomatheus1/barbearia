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
  /** A API já devolvia; a tela é que ignorava. */
  photoUrl: string | null;
  priceCents: number;
  durationMinutes: number;
  professionalIds: string[];
}

export interface PublicProfile {
  slug: string;
  name: string;
  logoUrl: string | null;
  instagram: string | null;
  /** O encarregado de dados, que a LGPD art. 41 §1 manda divulgar publicamente. */
  encarregado: { nome: string; email: string | null } | null;
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
  professionals: {
    id: string;
    name: string;
    bio: string | null;
    photoUrl: string | null;
    /** Endereço da página pública dele, quando existe (bloco 73). */
    perfilPublico: string | null;
  }[];
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

/**
 * A reputação que a página pública mostra (bloco 43).
 *
 * Cache curto, como o perfil: uma avaliação nova não precisa aparecer no
 * segundo seguinte, mas uma nota que venceu a janela de 48h precisa aparecer no
 * mesmo dia — e é o TTL que garante isso sem varredura nenhuma.
 */
export const getAvaliacoesPublicas = (slug: string) =>
  get<ReputacaoPublica>(`/v1/b/${slug}/avaliacoes`, 30);

export interface ReputacaoPublica {
  media: number | null;
  total: number;
  avaliacoes: {
    nota: number;
    estrelas: string;
    comentario: string | null;
    primeiroNome: string;
    profissionalNome: string | null;
    quando: string;
  }[];
}

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
  /** Carimbo assinado da passagem pela busca do marketplace (bloco 72). */
  origem?: string;
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
      // Só quando o carimbo existe: mandar `undefined` seria o mesmo, mas
      // mandar a chave sempre faria a borda validar um campo que a página
      // pública normal não tem por que enviar.
      ...(dados.origem ? { origem: dados.origem } : {}),
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

// -- Lista de espera (bloco 38) -----------------------------------------------

export interface EntrarNaEspera {
  locationId: string;
  serviceIds: string[];
  /** `'any'` vira ausência no corpo: o domínio lê nulo como "qualquer um". */
  professionalId: string;
  de: string;
  ate: string;
  inicio: string;
  fim: string;
  name: string;
  phone: string;
}

export interface EsperaDoCliente {
  id: string;
  status: 'waiting' | 'booked' | 'left' | 'expired';
  de: string;
  ate: string;
  inicio: string;
  fim: string;
  duracaoMinutos: number;
  profissionalId: string | null;
  profissionalNome: string | null;
  servicos: string[];
  entrouEm: string;
  /** O convite aberto, quando existe. Nulo é o caso comum. */
  convite: { dia: string; hora: string; minutosRestantes: number } | null;
}

/**
 * Entra na lista.
 *
 * Sem id na resposta de propósito: a API não o devolve a quem não tem sessão —
 * `resolveGuestCustomer` reencontra o cliente pelo telefone, e devolver a
 * entrada transformaria a rota num oráculo sobre o cadastro de terceiro. Quem
 * quer ver a própria lista entra em "Meus agendamentos", que pede sessão.
 */
export async function entrarNaEsperaNaApi(
  slug: string,
  dados: EntrarNaEspera,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const response = await fetch(`${BASE}/v1/b/${slug}/waitlist`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      /**
       * Derivada da escolha, não do relógio.
       *
       * Reenvio do mesmo formulário — o duplo toque clássico em rede lenta —
       * devolve a mesma entrada em vez de criar a segunda. Mesma construção da
       * criação de agendamento, e pelo mesmo motivo: a chave precisa ser
       * estável para o **mesmo pedido**, e diferente para pedidos diferentes.
       */
      'idempotency-key': `${dados.phone}|${dados.de}|${dados.ate}|${dados.inicio}|${dados.fim}|${dados.professionalId}`,
    },
    body: JSON.stringify({
      locationId: dados.locationId,
      serviceIds: dados.serviceIds,
      ...(dados.professionalId && dados.professionalId !== 'any'
        ? { professionalId: dados.professionalId }
        : {}),
      de: dados.de,
      ate: dados.ate,
      inicio: dados.inicio,
      fim: dados.fim,
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

  return { ok: true };
}

/**
 * Manda um recado para a barbearia (bloco 40).
 *
 * Sem sessão, e sem exigir sequer nome: o recado anônimo é o de quem esperou
 * quarenta minutos e foi embora, e ele é o mais valioso que existe.
 *
 * A resposta é sempre a mesma — "registrado" —, e a tela não tenta descobrir
 * mais que isso. Distinguir "criei" de "você já é cliente daqui" seria oráculo
 * sobre cadastro alheio.
 */
export async function mandarRecadoNaApi(
  slug: string,
  dados: {
    tipo: string;
    texto: string;
    nome?: string;
    telefone?: string;
    token?: string;
  },
): Promise<{ ok: true } | { ok: false; code: string }> {
  const response = await fetch(`${BASE}/v1/b/${slug}/feedback`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(dados.token ? { authorization: `Bearer ${dados.token}` } : {}),
    },
    body: JSON.stringify({
      tipo: dados.tipo,
      texto: dados.texto,
      ...(dados.nome ? { nome: dados.nome } : {}),
      ...(dados.telefone ? { telefone: dados.telefone } : {}),
    }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const corpo = (await response.json().catch(() => null)) as
      | { error?: { code?: string } }
      | null;
    return { ok: false, code: corpo?.error?.code ?? 'request_failed' };
  }

  return { ok: true };
}

export interface MeuSaldoDeFidelidade {
  modo: 'nenhum' | 'pontos' | 'visitas' | 'cashback';
  saldo: number;
  faltaParaPremio: number | null;
  extrato: {
    id: string;
    tipo: 'acumulo' | 'resgate' | 'expiracao' | 'ajuste';
    quantidade: number;
    quando: string;
    venceEm: string | null;
    nota: string | null;
  }[];
}

/** O saldo do próprio cliente. O id vem da sessão, nunca do endereço. */
export async function meuSaldoDeFidelidade(
  slug: string,
  token: string,
): Promise<MeuSaldoDeFidelidade | null> {
  const response = await fetch(`${BASE}/v1/b/${slug}/loyalty`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) return null;
  return (await response.json()) as MeuSaldoDeFidelidade;
}

/**
 * Os pacotes do próprio cliente (bloco 42).
 *
 * Lista vazia e não `null` numa falha: como a lista de espera, um pacote que não
 * carregou não pode mandar o cliente para a tela de entrar — ele já está
 * autenticado, e o resto da página continua útil.
 */
export async function meusPacotes(
  slug: string,
  token: string,
): Promise<MeuPacote[]> {
  const response = await fetch(`${BASE}/v1/b/${slug}/packages`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) return [];
  const corpo = (await response.json()) as { pacotes: MeuPacote[] };
  return corpo.pacotes;
}

export interface MeuPacote {
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
}

/**
 * Os atendimentos que esta pessoa ainda pode avaliar (bloco 43).
 *
 * Lista vazia numa falha, como a lista de espera: quem já está autenticado não
 * pode ser mandado para a tela de entrar porque um bloco secundário não
 * carregou.
 */
export async function meusAtendimentosAAvaliar(
  slug: string,
  token: string,
): Promise<AtendimentoAAvaliar[]> {
  const response = await fetch(`${BASE}/v1/b/${slug}/reviews/pendentes`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) return [];
  const corpo = (await response.json()) as { atendimentos: AtendimentoAAvaliar[] };
  return corpo.atendimentos;
}

export interface AtendimentoAAvaliar {
  id: string;
  servico: string | null;
  profissional: string | null;
  quando: string;
}

export async function avaliarNaApi(
  slug: string,
  token: string,
  dados: {
    appointmentId: string;
    nota: number;
    comentario?: string;
  },
): Promise<{ ok: true } | { ok: false; code: string }> {
  const response = await fetch(`${BASE}/v1/b/${slug}/reviews`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(dados),
    cache: 'no-store',
  });
  if (response.ok) return { ok: true };
  const corpo = (await response.json().catch(() => ({}))) as { code?: string };
  return { ok: false, code: corpo.code ?? 'request_failed' };
}

export async function listarEsperas(
  slug: string,
  token: string,
): Promise<EsperaDoCliente[]> {
  const response = await fetch(`${BASE}/v1/b/${slug}/waitlist`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  // Lista vazia e não `null`: ao contrário dos agendamentos, uma falha aqui não
  // pode mandar o cliente para a tela de entrar — ele já está autenticado, e a
  // espera é o menos importante da página.
  if (!response.ok) return [];
  const corpo = (await response.json()) as { esperas: EsperaDoCliente[] };
  return corpo.esperas;
}

/**
 * Aceita o convite pela própria tela.
 *
 * Sem token: quem autoriza é a sessão. O caminho do link continua existindo e é
 * o normal — este é o que sobra quando a mensagem não chega.
 */
export async function aceitarConviteDaEspera(
  slug: string,
  token: string,
  entryId: string,
): Promise<{ ok: boolean; code?: string }> {
  const response = await fetch(`${BASE}/v1/b/${slug}/waitlist/${entryId}/accept`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (response.ok) return { ok: true };
  const corpo = (await response.json().catch(() => null)) as
    | { error?: { code?: string } }
    | null;
  return { ok: false, code: corpo?.error?.code ?? 'request_failed' };
}

export async function sairDaEsperaNaApi(
  slug: string,
  token: string,
  entryId: string,
): Promise<{ ok: boolean; code?: string }> {
  const response = await fetch(`${BASE}/v1/b/${slug}/waitlist/${entryId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (response.ok) return { ok: true };
  const corpo = (await response.json().catch(() => null)) as
    | { error?: { code?: string } }
    | null;
  return { ok: false, code: corpo?.error?.code ?? 'request_failed' };
}

/** Resposta de POST/GET autenticado: sucesso tipado ou código de falha. */
export type Resultado<T> = { ok: true; dados: T } | { ok: false; code: string };

async function post<T>(
  path: string,
  body: unknown,
  token?: string,
  metodo: 'POST' | 'PUT' = 'POST',
): Promise<Resultado<T>> {
  const response = await fetch(`${BASE}${path}`, {
    method: metodo,
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

/**
 * O consentimento de marketing, decidido pelo próprio titular (bloco 31).
 *
 * A versão do texto viaja com a decisão porque é ela que se mostra numa
 * contestação — sem dizer o que a pessoa leu, "ela aceitou" não responde nada.
 */
export interface ConsentimentoDoTitular {
  marketing: boolean;
  decididoEm: string | null;
}

/**
 * A leitura vai por `POST`? Não: vai por `fetch` direto.
 *
 * `get` deste arquivo é para conteúdo público com revalidação — ele não manda
 * cabeçalho de autorização, e a decisão do titular exige sessão. Repetir doze
 * linhas de `fetch` seria pior; reaproveitar o `get` público seria mandar uma
 * leitura autenticada por um caminho que cacheia.
 */
export async function lerConsentimento(
  slug: string,
  token: string,
): Promise<ConsentimentoDoTitular | null> {
  const resposta = await fetch(`${BASE}/v1/b/${slug}/auth/consentimento`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!resposta.ok) return null;
  return (await resposta.json()) as ConsentimentoDoTitular;
}

export const decidirConsentimento = (
  slug: string,
  token: string,
  marketing: boolean,
  versaoDoTexto: string,
) =>
  post<ConsentimentoDoTitular>(
    `/v1/b/${slug}/auth/consentimento`,
    { marketing, versaoDoTexto },
    token,
    'PUT',
  );

/**
 * O titular pedindo uma cópia dos próprios dados.
 *
 * Reenviar devolve o mesmo pedido: o segundo toque do botão não reinicia a
 * contagem do prazo de 15 dias.
 */
export const pedirMeusDados = (slug: string, token: string, tipo: 'export' | 'deletion') =>
  post<{ id: string; tipo: string; venceEm: string }>(
    `/v1/b/${slug}/auth/pedido-de-dados`,
    { tipo },
    token,
  );

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
  /**
   * O sinal deste horário. Nulo quando ele não pede.
   *
   * Sem o motivo, de propósito: o score é interno (SPEC §2.13, regra 5), e
   * "pelo seu histórico de faltas" numa tela que o cliente abre no ônibus é
   * exatamente o constrangimento que a regra existe para evitar.
   */
  deposit: { exigidoCents: number; pagoCents: number } | null;
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

/**
 * O plano do próprio cliente, e o extrato das mensalidades (bloco 47).
 *
 * O id vem da sessão, nunca do endereço: a RLS separa barbearias e **não**
 * separa clientes dentro de uma. `null` numa falha, como o saldo de fidelidade —
 * um plano que não carregou não pode mandar quem já está autenticado para a tela
 * de entrar, e o resto da página continua útil.
 */
export interface MeuPlano {
  assinatura: {
    id: string;
    planoNome: string;
    estado: 'ativa' | 'pendente' | 'inadimplente' | 'suspensa' | 'cancelada';
    precoCents: number;
    cicloDe: string;
    cicloAte: string;
    valeAte: string | null;
    pausadoDesde: string | null;
    beneficios: {
      serviceId: string;
      servicoNome: string;
      quantidade: number | null;
      usados: number;
      liberaEm: string | null;
    }[];
  } | null;
  faturas: {
    id: string;
    valorCents: number;
    estado: 'aberta' | 'paga' | 'cancelada';
    periodoDe: string;
    vencimento: string;
    pagaEm: string | null;
    diasAteSuspender: number | null;
  }[];
}

export async function meuPlano(slug: string, token: string): Promise<MeuPlano | null> {
  const response = await fetch(`${BASE}/v1/b/${slug}/plano`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) return null;
  return (await response.json()) as MeuPlano;
}

export async function cancelarMeuPlano(
  slug: string,
  token: string,
  motivo: string,
): Promise<Resultado<{ valeAte: string }>> {
  return post(`/v1/b/${slug}/plano/cancelar`, motivo.length > 0 ? { motivo } : {}, token);
}

export async function manterMeuPlano(
  slug: string,
  token: string,
): Promise<Resultado<{ desfeito: boolean }>> {
  return post(`/v1/b/${slug}/plano/manter`, {}, token);
}

// -- Marketplace: a busca (bloco 70) -----------------------------------------

export interface CidadeNaVitrine {
  cidade: string;
  estado: string;
  latitude: number;
  longitude: number;
  casas: number;
}

export interface CasaNaBusca {
  slug: string;
  nome: string;
  cidade: string | null;
  estado: string | null;
  fotoUrl: string | null;
  precoDeCents: number | null;
  notaBps: number | null;
  avaliacoes: number;
  comodidades: string[];
  temClube: boolean;
  distanciaKm: number;
  /**
   * O próximo horário livre, já com a frase pronta (bloco 71).
   *
   * A frase vem do servidor porque quem decide "Hoje" e "Amanhã" é o fuso da
   * **unidade**, não o do aparelho — é a mesma razão de a grade da página
   * pública vir montada.
   */
  proximoHorario: { startsAt: string; rotulo: string } | null;
  /** Carimbo assinado de "veio pela busca" (bloco 72). A página só o carrega. */
  carimbo: string;
  /** Card pago (bloco 75). A tela diz isso em letras, sempre. */
  patrocinado: boolean;
}

export interface BuscaDeBarbearias {
  readonly resultados: readonly CasaNaBusca[];
  readonly analisadas: number;
  readonly truncada: boolean;
}

export async function cidadesDaVitrine(): Promise<readonly CidadeNaVitrine[]> {
  const resposta = await fetch(`${BASE}/v1/marketplace/cidades`, { cache: 'no-store' });
  if (!resposta.ok) return [];
  const corpo = (await resposta.json()) as { cidades: CidadeNaVitrine[] };
  return corpo.cidades;
}

export async function buscarBarbearias(
  parametros: Record<string, string | string[]>,
): Promise<BuscaDeBarbearias> {
  /**
   * Lista vira **parâmetro repetido**, que é o que um `<form method="get">` com
   * caixas de seleção manda e o que a borda já sabe ler (`z.union([string,
   * array])`). Juntar com vírgula seria inventar uma segunda gramática de lista
   * na URL: `comodidades=wifi,parking` chegaria como um valor só e não casaria
   * com comodidade nenhuma — sem erro, devolvendo vazio.
   */
  const busca = new URLSearchParams();
  for (const [chave, valor] of Object.entries(parametros)) {
    for (const item of Array.isArray(valor) ? valor : [valor]) busca.append(chave, item);
  }
  const query = busca.toString();
  const resposta = await fetch(`${BASE}/v1/marketplace/busca?${query}`, { cache: 'no-store' });
  if (!resposta.ok) return { resultados: [], analisadas: 0, truncada: false };
  return (await resposta.json()) as BuscaDeBarbearias;
}

/**
 * A conversa do cliente com o agente (blocos 65 e 66, SPEC §4.16).
 *
 * A resposta é uma **união**, e a tela desenha um caso por vez. Escrever o tipo
 * como um objeto de campos opcionais faria a tela ter que adivinhar em qual
 * situação está — e adivinhar errado é como um "não entendi" apareceria ao lado
 * de três horários.
 */
/**
 * O que o agente entendeu até aqui — um **objeto**, e a tela precisa saber disso.
 *
 * Declarado como `string`, ele passava pelo compilador e quebrava no navegador:
 * React não renderiza objeto, e o que a pessoa via era a tela de erro em cima de
 * uma resposta que existia. O `vitest` não veria — ele apaga os tipos sem
 * conferi-los —, e o `tsc` também não, porque quem afirmava o tipo errado era
 * esta declaração.
 */
export interface EntendidoAteAqui {
  servico: string | null;
  profissional: string | null;
  emQuantosDias: number | null;
  aPartirDeMinuto: number | null;
  ateMinuto: number | null;
}

export type RespostaDoAgente =
  | { entendi: false; escalar: true }
  | { entendi: true; escalar: true; intencao?: string }
  | { entendi: true; escalar: false; resposta: string }
  | { entendi: true; escalar: false; intencao: string; precisaEntrar: true }
  | {
      entendi: true;
      escalar: false;
      intencao: string;
      pergunta: string;
      entendido: EntendidoAteAqui;
    }
  | {
      entendi: true;
      escalar: false;
      intencao: string;
      entendido: EntendidoAteAqui;
      /** Sem ele o link da proposta cai no passo 1 e a conversa é jogada fora. */
      servicoId: string;
      data: string;
      horarios: { comecaEm: string; profissionalId: string }[];
      nenhumServe: boolean;
    };

export async function conversarComOAgente(
  slug: string,
  texto: string,
): Promise<RespostaDoAgente | null> {
  const resposta = await fetch(`${BASE}/v1/b/${slug}/agente`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texto }),
    cache: 'no-store',
  });
  if (!resposta.ok) return null;
  return (await resposta.json()) as RespostaDoAgente;
}

export interface PerfilDoBarbeiroNaApi {
  professionalId: string;
  locationId: string;
  nome: string;
  slug: string;
  fotoUrl: string | null;
  bio: string | null;
  especialidades: string[];
  notaBps: number | null;
  avaliacoes: number;
  atendimentos: number;
  /** Portfólio público, só com o consentimento de uso público vigente. */
  portfolio: { id: string; url: string; legenda: string | null }[];
}

/**
 * A página pública do barbeiro (bloco 73, SPEC §5.2).
 *
 * Sem cache: a nota e a contagem de atendimentos mudam a cada avaliação e a
 * cada dia de trabalho, e uma página que diz "1.842 atendimentos" quando são
 * 1.900 é o tipo de número que só é notado por quem confere.
 */
export async function perfilDoBarbeiro(
  slug: string,
  barbeiro: string,
): Promise<PerfilDoBarbeiroNaApi | null> {
  const resposta = await fetch(`${BASE}/v1/b/${slug}/b/${barbeiro}`, { cache: 'no-store' });
  if (!resposta.ok) return null;
  return (await resposta.json()) as PerfilDoBarbeiroNaApi;
}
