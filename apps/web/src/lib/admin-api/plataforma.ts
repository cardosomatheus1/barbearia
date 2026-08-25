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

export interface FotoNaFicha {
  id: string;
  tipo: 'antes' | 'depois';
  url: string;
  legenda: string | null;
  noPortfolio: boolean;
  quando: string;
  appointmentId: string | null;
  professionalId: string | null;
}

export const fotosDoClienteNaApi = (token: string, id: string) =>
  chamar<{ fotos: FotoNaFicha[] }>('GET', `/v1/admin/customers/${id}/fotos`, undefined, token);

export const registrarFotoNaApi = (
  token: string,
  id: string,
  corpo: {
    tipo: 'antes' | 'depois';
    url: string;
    legenda?: string;
    professionalId?: string;
    noPortfolio?: boolean;
  },
) => chamar<{ id: string }>('POST', `/v1/admin/customers/${id}/fotos`, corpo, token);

export const publicarFotoNaApi = (token: string, fotoId: string, publicar: boolean) =>
  chamar<{ ok: true }>(
    'PUT',
    `/v1/admin/customers/fotos/${fotoId}/portfolio`,
    { publicar },
    token,
  );

export const apagarFotoNaApi = (token: string, fotoId: string) =>
  chamar<{ ok: true }>('DELETE', `/v1/admin/customers/fotos/${fotoId}`, undefined, token);

/** Franquia: o cardápio padrão da rede e o que esta casa adotou (bloco 76). */
export interface ItemDoPadraoNaApi {
  readonly id: string;
  readonly nome: string;
  readonly descricao: string | null;
  readonly referenciaCents: number;
  readonly duracaoMinutos: number;
  readonly categoria: string | null;
  readonly ativo: boolean;
  readonly adotadoComo: {
    readonly serviceId: string;
    readonly praticadoCents: number;
    readonly quando: string;
    readonly distancia: {
      readonly bps: number;
      readonly sentido: 'acima' | 'abaixo' | 'igual';
      readonly diferencaCents: number;
      readonly relevante: boolean;
    } | null;
  } | null;
}

export interface PadraoDaFranquia {
  readonly franquia: { readonly id: string; readonly nome: string; readonly papel: 'franqueadora' | 'franqueada' } | null;
  readonly itens: readonly ItemDoPadraoNaApi[];
}

export const padraoDaFranquiaNaApi = (token: string) =>
  chamar<PadraoDaFranquia>('GET', '/v1/admin/franquia/padrao', undefined, token);

export const publicarNoPadrao = (
  token: string,
  dados: {
    id?: string;
    nome: string;
    descricao: string | null;
    referenciaCents: number;
    duracaoMinutos: number;
    categoria: string | null;
    posicao: number;
  },
) => chamar<{ id: string }>('POST', '/v1/admin/franquia/padrao', dados, token);

export const despublicarDoPadrao = (token: string, itemId: string) =>
  chamar<{ ok: true }>('DELETE', `/v1/admin/franquia/padrao/${itemId}`, undefined, token);

export const adotarDoPadrao = (token: string, itemId: string) =>
  chamar<{ serviceId: string; novo: boolean }>(
    'POST',
    '/v1/admin/franquia/adocao',
    { itemId },
    token,
  );

/** Indicadores consolidados e metas da rede (bloco 77). */
export interface LinhaDaRedeNaApi {
  readonly tenantId: string | null;
  readonly nome: string | null;
  readonly eu: boolean;
  readonly receitaCents: number;
  readonly vendas: number;
  readonly atendimentos: number;
  readonly metaCents: number | null;
  readonly ticketMedioCents: number | null;
  readonly progressoBps: number | null;
}

export interface RedeNaApi {
  readonly linhas: readonly LinhaDaRedeNaApi[];
  readonly receitaTotalCents: number;
  readonly vendasTotais: number;
  readonly ticketMedioCents: number | null;
  readonly medianaDaReceitaCents: number | null;
  readonly bateramAMeta: number | null;
}

export interface MeuLugarNaApi {
  readonly minha: LinhaDaRedeNaApi;
  readonly medianaDaReceitaCents: number | null;
  readonly percentil: number | null;
}

export interface MetaDaRedeNaApi {
  readonly tenantId: string;
  readonly nome: string;
  readonly mes: string;
  readonly metaCents: number | null;
  readonly anteriorCents: number | null;
}

export const redeConsolidadaNaApi = (token: string, de: string, ate: string) =>
  chamar<{ rede: RedeNaApi }>(
    'GET',
    `/v1/admin/rede/consolidado?de=${de}&ate=${ate}`,
    undefined,
    token,
  );

export const meuLugarNaApi = (token: string, de: string, ate: string) =>
  chamar<{ lugar: MeuLugarNaApi }>(
    'GET',
    `/v1/admin/rede/meu-lugar?de=${de}&ate=${ate}`,
    undefined,
    token,
  );

export const metasDaRedeNaApi = (token: string, mes: string) =>
  chamar<{ metas: MetaDaRedeNaApi[] }>(
    'GET',
    `/v1/admin/rede/metas?mes=${mes}`,
    undefined,
    token,
  );

export const salvarMetaDaRedeNaApi = (
  token: string,
  dados: { franqueadaId: string; mes: string; metaCents: number },
) => chamar<{ ok: true }>('PUT', '/v1/admin/rede/metas', dados, token);

/** Chaves de API da barbearia (bloco 78). */
export interface ChaveNaApi {
  readonly id: string;
  readonly nome: string;
  readonly prefixo: string;
  readonly escopos: readonly string[];
  readonly criadaEm: string;
  readonly usadaEm: string | null;
  readonly revogadaEm: string | null;
  readonly motivoDaRevogacao: string | null;
}

export const chavesNaApi = (token: string) =>
  chamar<{ chaves: ChaveNaApi[]; disponiveis: string[] }>(
    'GET',
    '/v1/admin/chaves',
    undefined,
    token,
  );

export const criarChaveNaApi = (token: string, dados: { nome: string; escopos: string[] }) =>
  chamar<{ id: string; chave: string; prefixo: string }>('POST', '/v1/admin/chaves', dados, token);

export const revogarChaveNaApi = (token: string, chaveId: string, motivo: string) =>
  chamar<{ ok: true }>('POST', `/v1/admin/chaves/${chaveId}/revogacao`, { motivo }, token);

/** Webhooks para terceiros (bloco 79). */
export interface EndpointNaApi {
  readonly id: string;
  readonly nome: string;
  readonly url: string;
  readonly eventos: readonly string[];
  readonly ativo: boolean;
  readonly criadoEm: string;
}

export interface EntregaNaApi {
  readonly id: string;
  readonly evento: string;
  readonly estado: string;
  readonly tentativas: number;
  readonly respostaHttp: number | null;
  readonly erro: string | null;
  readonly criadaEm: string;
  readonly entregueEm: string | null;
}

export const webhooksNaApi = (token: string) =>
  chamar<{ endpoints: EndpointNaApi[]; entregas: EntregaNaApi[] }>(
    'GET',
    '/v1/admin/webhooks',
    undefined,
    token,
  );

export const cadastrarWebhookNaApi = (
  token: string,
  dados: { nome: string; url: string; eventos: string[] },
) => chamar<{ id: string; segredo: string }>('POST', '/v1/admin/webhooks', dados, token);

export const desligarWebhookNaApi = (token: string, endpointId: string) =>
  chamar<{ ok: true }>('DELETE', `/v1/admin/webhooks/${endpointId}`, undefined, token);
