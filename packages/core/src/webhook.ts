/**
 * Webhooks assinados para terceiros: o que sai, e quando se desiste (bloco 79).
 *
 * ## O que este arquivo decide
 *
 * O catálogo fechado de eventos, a forma do corpo e a escada de retentativa.
 * Não assina — isso é `node:crypto` e mora em `identity`, porque `core` não tem
 * dependência nenhuma.
 *
 * ## O corpo carrega fato e id, nunca dado pessoal
 *
 * A tentação é mandar o agendamento inteiro: nome, telefone, serviço, preço. O
 * integrador quer, e é uma linha a menos no código dele.
 *
 * Não. Um webhook é uma requisição que sai da nossa rede para um endereço que a
 * barbearia digitou num campo, sem TLS mútuo e sem ninguém do outro lado
 * respondendo por LGPD. Telefone de cliente por ali é exportar base por um canal
 * configurado em trinta segundos e esquecido.
 *
 * O que sai é *"o agendamento X foi criado às 14h"*. Quem quiser o detalhe busca
 * na API pública do bloco 78 — com chave, com escopo e com trilha. O webhook
 * avisa; a API responde.
 */

export const EVENTOS_DE_WEBHOOK = [
  'appointment.created',
  'appointment.cancelled',
  'appointment.rescheduled',
  'appointment.completed',
  'order.paid',
] as const;

export type EventoDeWebhook = (typeof EVENTOS_DE_WEBHOOK)[number];

const CONJUNTO: ReadonlySet<string> = new Set(EVENTOS_DE_WEBHOOK);

export function ehEventoDeWebhook(valor: string): valor is EventoDeWebhook {
  return CONJUNTO.has(valor);
}

/** A frase que a tela mostra. Mora aqui porque duas telas leem a mesma lista. */
export const ROTULO_DO_EVENTO: Readonly<Record<EventoDeWebhook, string>> = {
  'appointment.created': 'Horário marcado',
  'appointment.cancelled': 'Horário cancelado',
  'appointment.rescheduled': 'Horário remarcado',
  'appointment.completed': 'Atendimento concluído',
  'order.paid': 'Comanda paga',
};

/**
 * O corpo de uma entrega.
 *
 * Campos fixos e poucos, e nenhum deles é sobre uma pessoa. `event_id` existe
 * para o outro lado deduplicar: reentrega é normal, porque a escada existe — é
 * exatamente o que este produto exige dos próprios consumidores desde o bloco 1.
 */
export interface CorpoDoWebhook {
  readonly event_id: string;
  readonly event: EventoDeWebhook;
  readonly occurred_at: string;
  /** O id do que aconteceu, para buscar o detalhe na API pública. */
  readonly object_id: string;
  readonly location_id: string | null;
}

/**
 * Nomes de campo que **nunca** entram num corpo de webhook.
 *
 * Guarda derivada, e não uma revisão de código: o bloco que acrescentar um
 * evento vai copiar o corpo do anterior, e o dia em que alguém achar prático
 * mandar o telefone junto é o dia em que a base começa a sair por aqui. Há
 * teste que monta cada corpo e reprova qualquer uma destas chaves.
 */
export const FORA_DO_CORPO: readonly string[] = [
  'name',
  'nome',
  'phone',
  'telefone',
  'email',
  'tax_id',
  'cpf',
  'notes',
  'anotacao',
  'customer_name',
  'price_cents',
  'total_cents',
];

/**
 * A escada de retentativa, em segundos a partir da tentativa que falhou.
 *
 * Seis degraus, do minuto às seis horas: um servidor que reiniciou volta no
 * primeiro; um que caiu de madrugada é alcançado pelo último. Depois disso
 * desiste — continuar é gastar chamada contra um endereço que ninguém consertou
 * e encher a tela de entregas que não vão acontecer.
 */
export const ESCADA_DO_WEBHOOK: readonly number[] = [60, 300, 1_800, 7_200, 21_600, 21_600];

export function proximaTentativaEmSegundos(tentativasFeitas: number): number | null {
  return ESCADA_DO_WEBHOOK[tentativasFeitas] ?? null;
}

export type DesfechoDaEntrega = 'entregue' | 'retentar' | 'desistir';

/**
 * O que fazer com a resposta do outro lado.
 *
 * `2xx` é entregue. `5xx`, tempo esgotado e falha de rede retentam — o servidor
 * dele está com problema, e problema passa.
 *
 * `4xx` **encerra**, e é a regra da recusa definitiva do adquirente no bloco 46:
 * contra um `400`, os seis degraus são seis chamadas que já sabem a resposta. As
 * exceções são `408` e `429`, que dizem literalmente "tente de novo" — tratá-las
 * como definitivas puniria o integrador que está se protegendo direito.
 */
export function desfechoDaEntrega(
  status: number | null,
  tentativasFeitas: number,
): DesfechoDaEntrega {
  if (status !== null && status >= 200 && status < 300) return 'entregue';

  const definitiva = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
  if (definitiva) return 'desistir';

  return proximaTentativaEmSegundos(tentativasFeitas) === null ? 'desistir' : 'retentar';
}

/**
 * Um endereço que a barbearia digita não pode virar uma porta para dentro.
 *
 * Este é o risco central do bloco: o destino do `POST` é escolhido por quem tem
 * `team.manage` em **qualquer** barbearia, e quem faz a chamada somos nós, de
 * dentro da nossa rede. Sem guarda, um endereço apontando para
 * `169.254.169.254` faria o worker buscar credencial de nuvem e devolver o
 * código de resposta na tela — que é um oráculo de varredura de rede interna.
 *
 * A conferência é sobre o **endereço IP de destino**, e não sobre o nome: um
 * domínio que a barbearia controla pode apontar para onde ela quiser. Quem
 * chama resolve o nome antes e passa cada IP por aqui.
 */
export function ehDestinoInterno(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a = 0, b = 0] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || // "este host"
      a === 10 || // privado
      a === 127 || // laço
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, e o metadado de nuvem
      (a === 172 && b >= 16 && b <= 31) || // privado
      (a === 192 && b === 168) || // privado
      (a === 192 && b === 0) || // reservado (inclui 192.0.0.0/24)
      (a === 198 && b >= 18 && b <= 19) || // teste de desempenho
      a >= 224 // multicast e reservado
    );
  }

  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v6 === '::' || v6 === '::1') return true;
  // Único-local, link-local e o mapeamento de IPv4 — que traz os de cima junto.
  if (/^f[cd]/.test(v6) || v6.startsWith('fe80')) return true;
  const mapeado = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v6);
  if (mapeado?.[1]) return ehDestinoInterno(mapeado[1]);

  return false;
}

/**
 * Nomes que não precisam nem de resolução para serem recusados.
 *
 * A resolução é a guarda de verdade; esta lista existe para a recusa acontecer
 * no cadastro, com uma frase que explica — e não no primeiro aviso que falha,
 * três dias depois, com "não foi possível entregar".
 */
export function ehNomeInterno(hostname: string): boolean {
  const nome = hostname.toLowerCase().replace(/\.$/, '');
  if (nome === 'localhost' || nome.endsWith('.localhost')) return true;
  if (nome.endsWith('.local') || nome.endsWith('.internal') || nome.endsWith('.home.arpa')) {
    return true;
  }
  // Um IP literal no lugar do nome cai direto na conferência de endereço.
  return ehDestinoInterno(nome);
}
