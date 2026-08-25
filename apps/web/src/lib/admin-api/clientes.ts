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
  /** Último atendimento concluído; cancelamento/falta não é visita. */
  ultimaVisita: string | null;
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
  /** A gorjeta que ficou com esta cadeira — repasse, nunca receita da casa. */
  gorjetaCents: number;
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

/**
 * O período que a tela do painel está mostrando.
 *
 * Ou um dos três nomeados do seletor, ou a janela em dias que veio no link do
 * assistente (bloco 128) — que é a única forma de "conferir na tela" mostrar o
 * mesmo número que a resposta.
 */
export type PeriodoPedido = PeriodoPainel | { readonly dias: number };

export const ehJanelaEmDias = (p: PeriodoPedido): p is { readonly dias: number } =>
  typeof p === 'object';

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

export const painelOperacional = (token: string, dia?: string, periodo?: PeriodoPedido) => {
  const busca = new URLSearchParams();
  if (dia) busca.set('dia', dia);
  if (periodo) {
    if (ehJanelaEmDias(periodo)) busca.set('dias', String(periodo.dias));
    else busca.set('periodo', periodo);
  }
  const query = busca.toString();
  return chamar<PainelOperacional>(
    'GET',
    `/v1/admin/dashboard${query ? `?${query}` : ''}`,
    undefined,
    token,
  );
};

export const painelDeDinheiro = (token: string, dia?: string, periodo?: PeriodoPedido) => {
  const busca = new URLSearchParams();
  if (dia) busca.set('dia', dia);
  if (periodo) {
    if (ehJanelaEmDias(periodo)) busca.set('dias', String(periodo.dias));
    else busca.set('periodo', periodo);
  }
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
  /**
   * Em **quem** o evento mexeu. Nulo quando o alvo não é entidade nomeada.
   *
   * Resolvido na leitura pela API, nunca gravado em `audit_log`: a trilha é
   * append-only e a anonimização não a alcança.
   */
  alvoNome: string | null;
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

