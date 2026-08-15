/**
 * WhatsApp oficial — o contrato (bloco 55, SPEC §4.12).
 *
 * O motor de aviso existe desde o bloco 20 e sempre mandou por uma abstração.
 * Este arquivo é o contrato do canal de verdade, e a decisão que ele carrega
 * está na SPEC em letras: **número verificado da barbearia, não da plataforma**.
 *
 * ## Por que o número é dela
 *
 * A mensagem que chega de um número desconhecido é a que o cliente ignora ou
 * bloqueia. O número da barbearia ele já tem na agenda — é para onde ele liga
 * quando quer remarcar. O custo dessa escolha é real e não se esconde: a
 * barbearia precisa criar o portfólio na Meta, conectar a WABA e **confirmar a
 * posse do número** por código de SMS. Por isso o estado do cadastro é
 * explícito, e a barbearia opera sem ele.
 *
 * ## O que **não** é exigido para começar
 *
 * *Business Verification* — razão social, endereço, documentos da empresa — não
 * entra no caminho de quem está se cadastrando. Uma conta nova já manda para
 * clientes de verdade, com **teto de 250 destinatários únicos por dia** em
 * conversa iniciada pela casa; o teto sobe para 2.000 e além conforme o volume
 * entregue, e é só aí que a verificação documental pode ser cobrada.
 *
 * Isto é decisão de produto e não trivia: 250 por dia é folgado para uma
 * barbearia — a campanha maior que este produto monta é a base inteira, e uma
 * base de barbearia de bairro tem centenas, não milhares. A consequência é que
 * o onboarding do canal cabe numa tarde, e a tela precisa dizer isso em vez de
 * mandar esperar.
 *
 * ## Cloud API direto
 *
 * Sem BSP no meio: um intermediário a menos no caminho do dado do cliente, e a
 * conta é com a Meta. O que se paga por isso é a burocracia ficar visível — e é
 * a tela que precisa guiar, não esconder.
 *
 * ## Por que template é cadastro e não string
 *
 * A Meta aprova cada texto, leva de minutos a dias, recusa, e **pausa** o que já
 * tinha aprovado quando o índice de qualidade cai. Um texto no código estaria
 * certo hoje e errado no dia em que a Meta pedisse mudança — e não haveria onde
 * ler "por que a mensagem parou de sair".
 */

import type { TipoDeNotificacao } from './notificacao.js';

// ---------------------------------------------------------------------------
// O estado do cadastro
// ---------------------------------------------------------------------------

export const ESTADOS_DO_WHATSAPP = [
  'nao_configurado',
  'aguardando_verificacao',
  'ativo',
  'suspenso',
] as const;
export type EstadoDoWhatsApp = (typeof ESTADOS_DO_WHATSAPP)[number];

export const ROTULO_DO_WHATSAPP: Readonly<Record<EstadoDoWhatsApp, string>> = {
  nao_configurado: 'Não configurado',
  aguardando_verificacao: 'Na Meta',
  ativo: 'Ativo',
  suspenso: 'Suspenso',
};

/**
 * O que a tela diz sobre cada estado.
 *
 * Quatro estados e não um booleano porque cada um pede uma coisa diferente de
 * quem opera: começar, esperar, nada, ou resolver com a Meta. "WhatsApp: não"
 * serviria para três deles e não diria o que fazer em nenhum.
 */
export const EXPLICACAO_DO_WHATSAPP: Readonly<Record<EstadoDoWhatsApp, string>> = {
  nao_configurado:
    'Os avisos saem pelo canal antigo. Cadastre o número para eles saírem pelo WhatsApp da casa.',
  /**
   * O que falta é **confirmar o número**, não esperar pela Meta.
   *
   * Até o bloco 82 esta frase dizia "a Meta está verificando a empresa, ela
   * avisa por e-mail" — e isso mandava a barbearia sentar e esperar. A
   * verificação de empresa (*Business Verification*) deixou de ser exigida para
   * começar a mandar mensagem: o que falta neste estado é a pessoa confirmar a
   * posse do número com o código que chega por SMS ou ligação, que ela faz
   * agora e sozinha.
   *
   * Frase que manda esperar sobre um passo que é para fazer é a pior classe de
   * texto de interface: ela não erra um número, ela para o trabalho.
   */
  aguardando_verificacao:
    'Falta confirmar o número no painel da Meta: ela manda um código por SMS ou ligação, e é você quem digita. Leva um minuto — não é preciso esperar aprovação nenhuma.',
  ativo: 'Os avisos saem pelo número da barbearia.',
  suspenso: 'A Meta suspendeu o número. O motivo está abaixo — os avisos voltaram ao canal antigo.',
};

/** Dá para mandar mensagem agora? */
export function whatsappDisponivel(estado: EstadoDoWhatsApp): boolean {
  return estado === 'ativo';
}

// ---------------------------------------------------------------------------
// O estado do template
// ---------------------------------------------------------------------------

export const ESTADOS_DO_TEMPLATE = [
  'rascunho',
  'pendente',
  'aprovado',
  'rejeitado',
  'pausado',
] as const;
export type EstadoDoTemplate = (typeof ESTADOS_DO_TEMPLATE)[number];

export const ROTULO_DO_TEMPLATE: Readonly<Record<EstadoDoTemplate, string>> = {
  rascunho: 'Rascunho',
  pendente: 'Na Meta',
  aprovado: 'Aprovado',
  rejeitado: 'Rejeitado',
  pausado: 'Pausado',
};

export const EXPLICACAO_DO_TEMPLATE: Readonly<Record<EstadoDoTemplate, string>> = {
  rascunho: 'Ainda não foi enviado para aprovação.',
  pendente: 'Enviado. A Meta costuma responder em minutos, às vezes em dias.',
  aprovado: 'Aprovado. É este texto que sai.',
  rejeitado: 'A Meta recusou. O motivo está abaixo — corrija o texto e envie de novo.',
  pausado:
    'A Meta pausou este texto porque muita gente marcou como spam ou bloqueou o número. Ele volta sozinho, e mandar menos é o que faz voltar.',
};

/** Só o aprovado sai. Os outros quatro são etapas ou problemas. */
export function templateUtilizavel(estado: EstadoDoTemplate): boolean {
  return estado === 'aprovado';
}

// ---------------------------------------------------------------------------
// Os botões
// ---------------------------------------------------------------------------

/**
 * O que o cliente pode tocar dentro da mensagem.
 *
 * A SPEC §4.12 chama isto de requisito e explica por quê numa frase que vale
 * ser repetida: *o botão de cancelar dentro da mensagem reduz falta **e** reduz
 * cancelamento tardio ao mesmo tempo* — quem não precisa voltar ao site avisa
 * com antecedência em vez de simplesmente não aparecer.
 *
 * A lista é fechada porque cada botão é uma ação do domínio, não um texto: o
 * que volta da Meta é este identificador, e é ele que decide o que acontece.
 */
export const BOTOES_DA_MENSAGEM = [
  'confirmar',
  'remarcar',
  'cancelar',
  'agendar_novamente',
] as const;
export type BotaoDaMensagem = (typeof BOTOES_DA_MENSAGEM)[number];

/**
 * O texto de cada botão, em `core` e não escrito na tela.
 *
 * Vocabulário de transição mora aqui (CLAUDE.md §6): o mesmo botão aparece no
 * template cadastrado, na mensagem que sai e no histórico que o balcão lê, e
 * "Cancelar" num lugar com "Desmarcar" no outro é o que faz a recepção achar
 * que são duas coisas.
 */
export const ROTULO_DO_BOTAO: Readonly<Record<BotaoDaMensagem, string>> = {
  confirmar: 'Confirmar',
  remarcar: 'Remarcar',
  cancelar: 'Cancelar',
  agendar_novamente: 'Agendar novamente',
};

export function botaoConhecido(valor: string): valor is BotaoDaMensagem {
  return (BOTOES_DA_MENSAGEM as readonly string[]).includes(valor);
}

/**
 * Quais botões cada aviso leva.
 *
 * Derivado do tipo e não escolhido na tela: um lembrete com "Agendar novamente"
 * ofereceria marcar de novo a quem já tem hora marcada, e um retorno com
 * "Cancelar" ofereceria cancelar o que não existe. O template cadastrado na Meta
 * nasce com estes botões, e o que volta é conferido contra eles.
 */
export const BOTOES_DO_AVISO: Readonly<Record<TipoDeNotificacao, readonly BotaoDaMensagem[]>> = {
  confirmacao: ['confirmar', 'remarcar', 'cancelar'],
  lembrete_24h: ['confirmar', 'remarcar', 'cancelar'],
  // Duas horas antes, remarcar já não é oferta honesta: não há grade para
  // remanejar no mesmo dia, e oferecer produz a frustração de tentar e não ter.
  lembrete_2h: ['confirmar', 'cancelar'],
  sua_vez: [],
  senha_de_acesso: [],
  retorno: ['agendar_novamente'],
};

// ---------------------------------------------------------------------------
// O contrato do provedor
// ---------------------------------------------------------------------------

export interface TemplateParaAprovar {
  readonly nome: string;
  readonly idioma: string;
  readonly corpo: string;
  readonly botoes: readonly BotaoDaMensagem[];
}

export interface RespostaDoTemplate {
  readonly metaId: string | null;
  readonly estado: EstadoDoTemplate;
  readonly motivoDaRecusa: string | null;
}

export interface MensagemParaEnviar {
  /** O telefone do destinatário, E.164. */
  readonly para: string;
  readonly template: string;
  readonly idioma: string;
  /** As variáveis posicionais do template, na ordem (`{{1}}`, `{{2}}`...). */
  readonly variaveis: readonly string[];
  /**
   * O que volta quando a pessoa toca cada botão.
   *
   * Carrega o id do agendamento junto do botão — a Meta devolve exatamente esta
   * string, e sem o id não haveria como saber **qual** horário cancelar. É o
   * mesmo desenho do token da vaga no bloco 39.
   */
  readonly respostas: readonly { readonly botao: BotaoDaMensagem; readonly payload: string }[];
}

export interface MensagemEnviada {
  /** O id da Meta (`wamid...`). É a chave da conciliação por webhook. */
  readonly wamid: string;
}

export interface WhatsAppProvider {
  /** Manda um template aprovado. É o único jeito de iniciar conversa. */
  enviar(mensagem: MensagemParaEnviar): Promise<MensagemEnviada>;
  /** Submete um texto para aprovação da Meta. */
  submeterTemplate(template: TemplateParaAprovar): Promise<RespostaDoTemplate>;
  /** Pergunta em que pé está. A rede de segurança da conciliação. */
  consultarTemplate(nome: string, idioma: string): Promise<RespostaDoTemplate>;
}

/**
 * O provedor de mentira, com estado controlável pelo teste.
 *
 * **`pendente` por padrão** ao submeter template, e não `aprovado`: é o estado
 * real de um template recém-enviado, e a aprovação leva de minutos a dias. Um
 * fake otimista faria a cadeia de conciliação — a fila perguntando, a tela
 * saindo de "na Meta" — nunca ser percorrida pelo caminho da vida real. É a
 * mesma decisão do `FakeFiscalProvider` e do `FakePaymentProvider`.
 */
export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly enviadas: MensagemParaEnviar[] = [];
  readonly submetidos: TemplateParaAprovar[] = [];
  proximoEstadoDoTemplate: EstadoDoTemplate = 'pendente';
  proximaRecusa: string | null = null;
  /** Para provar o caminho de falha sem depender de rede fora do ar. */
  falharProxima = false;
  private contador = 0;

  async enviar(mensagem: MensagemParaEnviar): Promise<MensagemEnviada> {
    if (this.falharProxima) {
      this.falharProxima = false;
      throw new Error('WhatsApp indisponível');
    }
    this.enviadas.push(mensagem);
    this.contador += 1;
    return { wamid: `wamid.fake.${this.contador}` };
  }

  async submeterTemplate(template: TemplateParaAprovar): Promise<RespostaDoTemplate> {
    this.submetidos.push(template);
    return this.resposta(template.nome);
  }

  async consultarTemplate(nome: string, _idioma: string): Promise<RespostaDoTemplate> {
    return this.resposta(nome);
  }

  private resposta(nome: string): RespostaDoTemplate {
    return {
      metaId: `meta.${nome}`,
      estado: this.proximoEstadoDoTemplate,
      motivoDaRecusa: this.proximoEstadoDoTemplate === 'rejeitado' ? this.proximaRecusa : null,
    };
  }
}

// ---------------------------------------------------------------------------
// A resposta do cliente
// ---------------------------------------------------------------------------

/**
 * O que vem dentro do `payload` de um botão: a ação e o agendamento.
 *
 * Duas partes separadas por `:`, e o id é UUID — não sequencial, pelo mesmo
 * motivo de todo id público deste produto. A Meta devolve a string exatamente
 * como foi mandada, e ela viaja pelo aparelho do cliente: assumir que ela chega
 * intacta é o erro que este par de funções existe para não cometer.
 */
export function montarPayload(botao: BotaoDaMensagem, agendamentoId: string): string {
  return `${botao}:${agendamentoId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function lerPayload(
  payload: string | null | undefined,
): { readonly botao: BotaoDaMensagem; readonly agendamentoId: string } | null {
  if (!payload) return null;
  const corte = payload.indexOf(':');
  if (corte < 0) return null;
  const botao = payload.slice(0, corte);
  const agendamentoId = payload.slice(corte + 1);
  if (!botaoConhecido(botao)) return null;
  // O id é conferido aqui, mas **quem manda é a RLS**: um UUID bem formado de
  // outra barbearia passaria por esta função e não passaria pela consulta.
  if (!UUID.test(agendamentoId)) return null;
  return { botao, agendamentoId };
}

