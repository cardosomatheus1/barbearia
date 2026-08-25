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
} from '@barbearia/core';

import { BASE, chamar, type Resposta } from './core';

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
  turnstileToken?: string;
}) => chamar<{ next: string }>('POST', '/v1/admin/signup', dados);

export const entrarComoGestor = (email: string, password: string) =>
  chamar<SessaoGestor>('POST', '/v1/admin/login', { email, password });

export const sairDoGestor = (token: string) =>
  chamar<{ revoked: boolean }>('POST', '/v1/admin/logout', {}, token);

export interface EstadoOnboarding {
  tenantId: string;
  businessName: string;
  /** O cadastro da unidade, para a etapa 2 vir preenchida (bloco 111). */
  empresa: {
    street: string | null;
    district: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    phone: string | null;
    whatsapp: string | null;
    instagram: string | null;
    about: string | null;
    timezone: string;
    amenities: string[];
    latitude: number | null;
    longitude: number | null;
  };
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
  /**
   * Os recursos ligados pela plataforma para esta barbearia (bloco 26).
   *
   * Códigos, não rótulos: quem sabe o nome e a descrição de cada recurso é a
   * tela da plataforma, que lê o catálogo. Aqui só se pergunta "existe?".
   */
  recursos: string[];
  /**
   * A loja da sessão, para o casco dizer onde a pessoa está.
   *
   * `ehRede` é falso na barbearia de uma loja só — ali o nome da unidade
   * embaixo do nome da casa é ruído, e a linha some.
   */
  unidade: { id: string; nome: string; ehRede: boolean } | null;
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

