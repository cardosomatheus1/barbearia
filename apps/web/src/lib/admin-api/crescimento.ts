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
  /**
   * As permissões que a Meta concedeu, ou `null` (bloco 88).
   *
   * Os nomes crus dela, e não um booleano pronto: quem os interpreta é
   * `podeGerenciarTemplates`, de `core`, que é a mesma função dos dois lados —
   * a regra do repositório é que permissão exibida na tela sai da mesma função
   * que a API aplica, nunca de uma conta refeita na view.
   */
  readonly escopos: readonly string[] | null;
}

export interface TemplateNaTelaDoAdmin {
  readonly id: string;
  readonly tipo: string;
  readonly nome: string;
  /** O nome em português. Nulo é texto anterior ao bloco 94. */
  readonly titulo: string | null;
  readonly idioma: string;
  readonly estado: 'rascunho' | 'pendente' | 'aprovado' | 'rejeitado' | 'pausado';
  readonly corpo: string;
  readonly botoes: readonly string[];
  readonly motivoDaRecusa: string | null;
}

/**
 * O que a tela precisa para desenhar o botão de conexão (bloco 83).
 *
 * `null` quando o app da plataforma não foi configurado — e aí a tela não
 * desenha o botão. O `appSecret` **não** está aqui e nunca estará: ele assina
 * em nome do app inteiro e não sai do servidor da API.
 */
export interface SignupDoWhatsAppNaTela {
  /**
   * O endereço da Meta, montado no servidor e já com o `state`.
   *
   * `null` quando a tela pediu só o modo — ela é renderizada sem poder gravar
   * o cookie do `state`, e quem monta o endereço é a ação do botão.
   */
  readonly endereco: string | null;
  /**
   * Qual fluxo a janela da Meta abre — e o que a tela precisa avisar.
   *
   * `padrao` **toma** o número: ele sai do aplicativo WhatsApp. `coexistencia`
   * conecta um número que já está no WhatsApp Business e ele continua lá.
   * Avisar errado sobre isso é a barbearia perder o número que usa para
   * atender.
   */
  readonly modo: 'padrao' | 'coexistencia';
}

export const signupDoWhatsAppNaApi = (
  token: string,
  params?: { redirectUri: string; state: string },
) =>
  chamar<{ signup: SignupDoWhatsAppNaTela | null }>(
    'GET',
    params
      ? `/v1/admin/whatsapp/signup?redirectUri=${encodeURIComponent(params.redirectUri)}&state=${params.state}`
      : '/v1/admin/whatsapp/signup',
    undefined,
    token,
  );

export const conectarWhatsAppNaApi = (
  token: string,
  corpo: {
    code: string;
    // O mesmo endereço que abriu a janela: a Meta o compara byte a byte e
    // recusa a troca quando ele falta. Ausente é o fluxo de janela do SDK,
    // onde mandá-lo é o mesmo erro na direção contrária.
    redirectUri?: string;
    // Opcionais desde o bloco 84: no redirecionamento eles não vêm, e quem os
    // descobre é o servidor, pelo token.
    wabaId?: string;
    phoneNumberId?: string;
    numeroVisivel: string | null;
  },
) => chamar<{ cadastro: unknown }>('POST', '/v1/admin/whatsapp/conectar', corpo, token);

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

/**
 * Pergunta à Meta agora, sem esperar a volta do relógio.
 *
 * A conciliação roda de hora em hora e isso é certo para o conjunto; errado é
 * ser o único caminho, porque quem aprova o texto no painel da Meta volta em
 * segundos e lê "Na Meta".
 */
/**
 * Manda o texto aprovado de um aviso para **um** cliente.
 *
 * `enviado: false` não é erro: é a guarda de consentimento, teto ou janela de
 * silêncio dizendo por que não saiu, e o motivo vem escrito.
 */
/** Um dos dois: o texto escolhido vence, e é ele que a ficha manda. */
export const mandarMensagemNaApi = (
  token: string,
  customerId: string,
  qual: { readonly templateId: string } | { readonly tipo: string },
  idempotencyKey: string,
) =>
  chamar<{ enviado: boolean; wamid: string | null; motivo: string | null }>(
    'POST',
    '/v1/admin/whatsapp/mensagem',
    { customerId, ...qual },
    token,
    idempotencyKey,
  );

export const conciliarWhatsAppNaApi = (token: string) =>
  chamar<{ promovido: boolean; templates: number }>(
    'POST',
    '/v1/admin/whatsapp/conciliar',
    {},
    token,
  );

export const submeterTemplateNaApi = (
  token: string,
  corpo: { tipo: string; titulo?: string; botoes?: string[]; acoes?: string[]; corpo: string },
) => chamar<TemplateNaTelaDoAdmin>('POST', '/v1/admin/whatsapp/templates', corpo, token);

// -- automação (bloco 56) ----------------------------------------------------

export interface AutomacaoNaTelaDoAdmin {
  readonly id: string;
  readonly nome: string;
  readonly gatilho: string;
  readonly limiar: number | null;
  readonly atrasoMinutos: number;
  readonly tipo: string;
  /**
   * O nome do texto que esta automação escolheu (bloco 96).
   *
   * A API já o devolvia desde o bloco 94 e a tela não o declarava: a linha
   * dizia "manda Convite de retorno" — o nome do **tipo** — com três convites
   * de retorno diferentes cadastrados. O dado existia e ninguém lia, que é a
   * §6 pergunta 4.
   */
  readonly textoTitulo: string | null;
  /** O id do texto escolhido, que o formulário de edição precisa repor. */
  readonly templateId: string | null;
  /** Para quem ela manda; nulo é todo mundo que cruzou o gatilho. */
  readonly publico: string | null;
  readonly objetivo: string;
  readonly janelaDias: number;
  readonly ativa: boolean;
  readonly enviadas: number;
  readonly alcancadas: number;
}

/**
 * A fila está andando? (bloco 101)
 *
 * Nenhuma tela sabia responder: a campanha dizia "entrou na fila", a automação
 * prometia "rodam de hora em hora" e o WhatsApp mostrava o canal de pé — com
 * trinta e três mensagens paradas e o processo que as manda fora do ar.
 */
export interface SaudeDaFilaNaTela {
  readonly atrasadas: number;
  readonly agendadas: number;
  /** Desistiram depois de esgotar as tentativas, nas últimas 48h. */
  readonly falhadas: number;
  readonly ultimaConclusao: string | null;
  /** É a janela de silêncio da unidade agora: parado é o certo, e não alarme. */
  readonly emSilencio: boolean;
  readonly parada: boolean;
  /**
   * Obrigatório, nunca opcional.
   *
   * `desistiu?` chegaria `undefined` na primeira tela que esquecesse dele, e
   * `undefined` é falso: o aviso sumiria com o compilador calado, que é
   * exatamente o defeito que este campo existe para acabar.
   */
  readonly desistiu: boolean;
}

export const filaNaApi = (token: string) =>
  chamar<SaudeDaFilaNaTela>('GET', '/v1/admin/automacoes/fila', undefined, token);

export const automacoesNaApi = (token: string) =>
  chamar<{ automacoes: readonly AutomacaoNaTelaDoAdmin[] }>(
    'GET',
    '/v1/admin/automacoes',
    undefined,
    token,
  );

/**
 * Liga e desliga, sem passar pela validação do formulário.
 *
 * Porta própria porque o freio não pode depender de o resto da linha ainda ser
 * válido: a automação criada antes de o tipo ser fechado respondia 400 no
 * reenvio e ficava ligada para sempre.
 */
export const definirAutomacaoAtivaNaApi = (
  token: string,
  id: string,
  ativa: boolean,
) => chamar<{ id: string; ativa: boolean }>('PATCH', '/v1/admin/automacoes/estado', { id, ativa }, token);

export const salvarAutomacaoNaApi = (
  token: string,
  corpo: {
    id?: string;
    nome: string;
    gatilho: string;
    limiar: number | null;
    atrasoMinutos: number;
    tipo: string;
    /** Qual texto ela manda (bloco 94). Nulo resolve por tipo, como antes. */
    templateId?: string | null;
    /** Para quem ela manda (bloco 100). Nulo é todo mundo; ausente é "não mexa". */
    publico?: string | null;
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
  /** O nome do texto escolhido; nulo é campanha anterior ao bloco 96. */
  readonly textoTitulo: string | null;
  /** Quantos saíram pelo WhatsApp de verdade; o resto caiu no canal de reserva. */
  readonly enviadosPeloWhatsApp: number;
  /** Quantos foram pulados, por motivo. Vazio quando ninguém foi pulado. */
  readonly pulados: readonly { readonly motivo: string; readonly quantos: number }[];
  /**
   * A união, e não `string`.
   *
   * Com `string` o compilador aceitava indexar o mapa de rótulos com qualquer
   * coisa, e o estado novo que alguém acrescentasse chegaria à tela como
   * `undefined` — a caixa em branco no lugar do rótulo. É a mesma razão de
   * `Record<Uniao, T>` num mapa de erro.
   */
  readonly estado: EstadoDeCampanha;
  readonly criadaEm: string;
  /** O disparo mais recente, ou a criação quando nada saiu. */
  readonly ultimoMovimentoEm: string;
  readonly publico: number;
  readonly enviados: number;
  readonly entregues: number;
  readonly lidos: number;
  readonly cliques: number;
  readonly agendamentos: number;
  /** Nulo para quem não pode ver receita (`finance.view`). */
  readonly receitaCents: number | null;
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
    /** Um dos dois: o texto decide o tipo, e a borda recusa campanha sem nenhum. */
    tipo?: string;
    templateId?: string;
    janelaDias: number;
  },
) => chamar<{ id: string; publico: number }>('POST', '/v1/admin/campanhas', corpo, token);

export interface PuladoNaTela {
  readonly customerId: string;
  readonly nome: string;
  readonly motivo: string;
}

/** Quem não recebeu, com nome e motivo (bloco 97). */
export const puladosDaCampanhaNaApi = (token: string, id: string) =>
  chamar<{ pulados: readonly PuladoNaTela[] }>(
    'GET',
    `/v1/admin/campanhas/${id}/pulados`,
    undefined,
    token,
  );

export const enviarCampanhaNaApi = (token: string, id: string) =>
  chamar<{ estado: 'enviando' }>('POST', `/v1/admin/campanhas/${id}/enviar`, {}, token);

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
  corpo: { nome: string; timezone: string; cidade?: string | null; estado?: string | null; linkDoMapa?: string | null },
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

