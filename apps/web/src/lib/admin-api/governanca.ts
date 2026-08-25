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

export const resolverConflitoImportacao = (
  token: string,
  id: string,
  corpo: { linha: number; escolha: 'anterior' | 'linha' },
) =>
  chamar<{ restantes: number }>(
    'POST',
    `/v1/admin/imports/${id}/conflicts`,
    corpo,
    token,
  );

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

export interface ClienteDoMarketplace {
  id: string;
  cliente: string;
  baseCents: number;
  feeBps: number;
  feeCents: number;
  quando: string;
  estado: 'pendente' | 'faturada' | 'cancelada';
}

export const clientesDoMarketplace = (token: string) =>
  chamar<{ clientes: ClienteDoMarketplace[]; pendenteCents: number }>(
    'GET',
    '/v1/admin/plano/marketplace',
    undefined,
    token,
  );

export const contestarClienteDoMarketplace = (
  token: string,
  id: string,
  dados: { categoria: string; motivo: string },
) => chamar<{ ok: true }>('POST', `/v1/admin/plano/marketplace/${id}/contestar`, dados, token);

export interface FaturaDaBarbearia {
  id: string;
  tipo: 'subscription' | 'proration' | 'marketplace';
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

