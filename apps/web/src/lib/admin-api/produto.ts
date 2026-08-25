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
  vencidoCents: number;
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

export type { DesfechoDaRecuperacao };
export type { MotivoDaContestacao };

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
  contestadaEm: string | null;
  contestacaoMotivo: MotivoDaContestacao | null;
  contestacaoNota: string | null;
  categorias: Partial<Record<'atendimento' | 'qualidade' | 'pontualidade' | 'ambiente', number>>;
}

export interface PainelDeAvaliacoes {
  media: number | null;
  total: number;
  mediaPublica: number | null;
  /** Quantas estão no ar — o par de `mediaPublica`. */
  totalPublico: number;
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

export const retirarContestacaoNaApi = (token: string, id: string) =>
  chamar<{ retirada: boolean }>(
    'POST',
    `/v1/admin/avaliacoes/${id}/retirar-contestacao`,
    {},
    token,
  );

export const contestarAvaliacaoNaApi = (
  token: string,
  id: string,
  dados: { motivo: MotivoDaContestacao; nota: string },
) => chamar<{ contestada: boolean }>('POST', `/v1/admin/avaliacoes/${id}/contestar`, dados, token);

// -- Estoque (bloco 44) -------------------------------------------------------

export type { TipoDeProduto };
export type { TipoDeMovimentoDeEstoque };
export type { AlertaDeEstoque };

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
  /** Nulo é "não dá para dizer", nunca "nunca acaba" (bloco 69). */
  diasAteAcabar: number | null;
  comprarPorConsumo: number;
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
  dados: Omit<
    ProdutoNaTela,
    'id' | 'saldo' | 'alertas' | 'sugestaoDeCompra' | 'diasAteAcabar' | 'comprarPorConsumo'
  >,
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

export type { EstadoDaAssinatura };

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
/**
 * Uma declaração só, do domínio.
 *
 * Era uma cópia à mão, e o bloco 127 mostrou o preço: a rota passou a devolver
 * `usosNoPeriodo` e `temRegraDeComissao` e a tela não os enxergava — o mesmo
 * defeito que o bloco 120 achou em vinte uniões deste arquivo. O sintoma aqui
 * seria o pior possível, porque os dois campos existem justamente para a tela
 * parar de dizer que não houve movimento sobre uma barbearia que teve.
 */
import type { SimulacaoDaAssinatura } from '@barbearia/core';

export type SimulacaoDaAssinaturaNaTela = SimulacaoDaAssinatura;

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
  chamar<{ configuracao: ConfiguracaoDoSplitNaTela; repasses: RepasseNaTela[]; hasMore: boolean }>(
    'GET',
    `/v1/admin/split?de=${de}&ate=${ate}`,
    undefined,
    token,
  );

export const meusRepassesNaApi = (token: string, de: string, ate: string) =>
  chamar<{ repasses: RepasseNaTela[]; hasMore: boolean }>(
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
  idempotencyKey: string,
) =>
  chamar<{ estado: string }>(
    'PUT',
    `/v1/admin/split/recebedores/${professionalId}`,
    dados,
    token,
    idempotencyKey,
  );

