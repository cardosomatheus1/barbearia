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

// -- Financeiro (bloco 51) ----------------------------------------------------

export type { DirecaoDaConta };

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

export const resumoFinanceiroDoClienteNaApi = (token: string, customerId: string) =>
  chamar<{ gastoTotalCents: number }>(
    'GET',
    `/v1/admin/financeiro/clientes/${customerId}/resumo`,
    undefined,
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
    /** O que venceu no período e não foi pago — a ressalva da linha de despesa. */
    despesasEmAbertoCents: number;
    /** A gorjeta do período: repasse, fora das duas somas. */
    gorjetasCents: number;
  };
  anterior: { resultadoCents: number; margemBps: number | null };
  linhas: LinhaDoDre[];
  receitaBruta: VariacaoDaLinha;
  resultado: VariacaoDaLinha;
}

export const dreNaApi = (token: string, de?: string, ate?: string, unidade?: string) => {
  const busca = new URLSearchParams();
  if (de && ate) {
    busca.set('de', de);
    busca.set('ate', ate);
  }
  // `todas` é o consolidado da rede (bloco 129). Quem confere se esta conta pode
  // pedi-lo é o servidor, contra as unidades que ela enxerga — a tela só pede.
  if (unidade) busca.set('unidade', unidade);
  const query = busca.toString();
  return chamar<DreNaTela>('GET', `/v1/admin/dre${query ? `?${query}` : ''}`, undefined, token);
};

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

/**
 * Reexportadas do `core`, **nunca** reescritas.
 *
 * `EstadoDaNota` tinha cinco valores aqui e seis lá: faltava `cancelando`, o
 * estado em voo que existe para o cancelamento não ser mandado duas vezes à
 * prefeitura. Nada quebrava — `ROTULO_DA_NOTA` é total sobre a união do
 * domínio, então indexá-lo com um subconjunto compila. O estrago era latente e
 * pior por isso: a primeira tela a montar um `Record<EstadoDaNota, …>` a partir
 * **deste** tipo deixaria `cancelando` de fora, e o `tsc` confirmaria que o
 * mapa está completo — porque o tipo mentia dizendo que aquele estado não
 * existe.
 *
 * `cancelando` já dividiu duas listas neste repositório antes. Esta era a
 * terceira cópia.
 */
export type { EstadoDaNota, RegimeFiscal };

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
  chamar<{ configuracao: ConfiguracaoFiscalNaTela | null; disponivel: boolean }>(
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

