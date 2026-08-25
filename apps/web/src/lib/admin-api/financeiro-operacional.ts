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

// -- Comanda, caixa e fiado -----------------------------------------------------

/**
 * Reexportada do `core`, **nunca** reescrita.
 *
 * A versão anterior era uma união escrita à mão com o comentário *"espelha
 * `FORMAS_DE_PAGAMENTO` do core"* logo acima — e não espelhava desde o bloco
 * 42: faltavam `pacote` e `assinatura`. Um `export type` independente é uma
 * segunda declaração, e acrescentar valor no domínio não quebra nada aqui.
 */
export type { FormaDePagamento };
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
  /** De quem é a gorjeta. Nulo é rateada entre quem atendeu. */
  gorjetaProfessionalId: string | null;
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
  idempotencyKey?: string,
) => chamar<{ ok: true }>('POST', '/v1/admin/cash/movements', dados, token, idempotencyKey);

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

export interface ComandaAbertaNaTela {
  id: string;
  abertaEm: string;
  customerName: string | null;
  appointmentId: string | null;
  itens: number;
  totalCents: number;
}

export interface ProdutoVendavelNaTela {
  id: string;
  nome: string;
  precoCents: number;
}

/** A lista de preços do balcão: o que dá para vender numa comanda. */
export const produtosVendaveisNaApi = (token: string) =>
  chamar<{ produtos: ProdutoVendavelNaTela[] }>(
    'GET',
    '/v1/admin/orders/vendaveis',
    undefined,
    token,
  );

/** As comandas que ficaram abertas — a listagem que a tela de cobrar não tinha. */
export const comandasAbertasDaCasa = (token: string) =>
  chamar<{ comandas: ComandaAbertaNaTela[] }>('GET', '/v1/admin/orders/abertas', undefined, token);

export const cancelarComandaAberta = (token: string, id: string) =>
  chamar<{ cancelada: true }>('DELETE', `/v1/admin/orders/${id}`, undefined, token);

export const retomarCampanhaNaApi = (token: string, id: string) =>
  chamar<{ estado: 'enviando' }>('POST', `/v1/admin/campanhas/${id}/retomar`, {}, token);

/** Tira alguém da lista de espera pelo balcão — a saída que a lista não tinha. */
export const tirarDaListaDeEspera = (token: string, id: string) =>
  chamar<{ removida: true }>('DELETE', `/v1/admin/agenda/espera/${id}`, undefined, token);

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
    /** O produto do catálogo. Com ele o preço sai do catálogo e o estoque baixa. */
    productId?: string;
  },
  idempotencyKey: string,
) => chamar<Comanda>('POST', `/v1/admin/orders/${id}/items`, dados, token, idempotencyKey);

export const removerDaComanda = (token: string, id: string, itemId: string) =>
  chamar<Comanda>('DELETE', `/v1/admin/orders/${id}/items/${itemId}`, undefined, token);

export const ajustarAComanda = (
  token: string,
  id: string,
  dados: {
    desconto?: { tipo: 'amount' | 'percent'; valor: number; motivo?: string } | null;
    gorjetaCents?: number;
    /** `null` é "rateada entre quem atendeu"; ausente é "não mexa". */
    gorjetaProfessionalId?: string | null;
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
  /** Qual serviço a assinatura está cobrindo. */
  servicoDaAssinatura?: string,
) =>
  chamar<Comanda>(
    'POST',
    `/v1/admin/orders/${id}/close`,
    {
      pagamentos,
      ...(resgateQuantidade ? { resgateQuantidade } : {}),
      ...(servicoDoPacote ? { servicoDoPacote } : {}),
      ...(servicoDaAssinatura ? { servicoDaAssinatura } : {}),
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
  estado: 'aguardando' | 'pago' | 'recusado' | 'expirado' | 'estornado';
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
  chamar<{ devedores: Devedor[]; quantos: number; totalCents: number }>(
    'GET',
    '/v1/admin/debts',
    undefined,
    token,
  );

export const receberDoFiado = (
  token: string,
  dados: { customerId: string; amountCents: number; forma: 'cash' | 'debit' | 'credit' | 'pix' },
  idempotencyKey?: string,
) => chamar<{ saldoCents: number }>('POST', '/v1/admin/debts/receive', dados, token, idempotencyKey);

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

/**
 * Desligar o segundo fator da própria conta.
 *
 * A rota e `desligarMfa` existem desde o bloco 19, com guarda, trilha e
 * derrubada da prova em todas as sessões — e **nenhum cliente**. Quem ligou o
 * TOTP e trocou de celular não desligava nem recadastrava (`iniciarCadastroMfa`
 * recusa com `already_enabled`), e ficava sem mover dinheiro se a barbearia
 * exigisse segundo fator. Só saía por `UPDATE` no banco.
 */
export const desligarSegundoFator = (token: string, codigo: string) =>
  chamar<{ ok: true }>('POST', '/v1/admin/mfa/disable', { codigo }, token);

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

export type { ModoDeComissao };
export type { BaseDeComissao };
export type { TratamentoDoDesconto };
export type { TratamentoDaTaxa };

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

