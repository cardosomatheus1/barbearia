/**
 * O agente de agendamento: da frase do cliente para uma **intenção** (bloco 65,
 * SPEC §4.16).
 *
 * > *"O agente **nunca** calcula disponibilidade sozinho — sempre chama o motor.
 * > Uma única fonte de verdade."*
 *
 * É a frase que decide este arquivo, e ela tem uma consequência forte: aqui não
 * há grade, não há preço e não há regra de agenda. O que sai é **o que a pessoa
 * pediu**, em campos — serviço, profissional, dia, faixa de hora. Quem responde
 * "18:20 · 19:00 · 20:10" é `getAvailability`, o mesmo motor que a página pública
 * usa, com a mesma antecedência mínima e a mesma constraint anti-overbooking.
 *
 * ## Nunca inventa
 *
 * *"Nunca inventa serviço, preço, horário ou promoção."* O intérprete só devolve
 * **nomes que o catálogo da barbearia tem** — ele recebe a lista e casa contra
 * ela. Um serviço que não existe vira `null`, e `null` faz o agente perguntar em
 * vez de chutar.
 *
 * ## Confirmação explícita antes de gravar
 *
 * A intenção **nunca** vira agendamento direto. Ela vira uma proposta com
 * serviço, profissional, data, hora e valor — e só a confirmação da pessoa
 * grava. É a mesma razão de o assistente do bloco 64 não responder o que não
 * entendeu: o custo de errar aqui é uma cadeira ocupada e um cliente que não vem.
 */

import { assuntoDaPergunta } from './recepcao.js';

export const INTENCOES = [
  'marcar',
  'remarcar',
  'cancelar',
  'consultar_horario',
  'falar_com_humano',
] as const;
export type Intencao = (typeof INTENCOES)[number];

export interface PedidoDoCliente {
  readonly intencao: Intencao;
  /** O id do serviço, quando a frase nomeia um que existe. */
  readonly servicoId: string | null;
  readonly servicoNome: string | null;
  readonly profissionalId: string | null;
  readonly profissionalNome: string | null;
  /** Dias a partir de hoje: 0 = hoje, 1 = amanhã. Nulo quando não foi dito. */
  readonly emQuantosDias: number | null;
  /** Minutos desde a meia-noite, quando a frase pede "depois das 18h". */
  readonly aPartirDeMinuto: number | null;
  readonly ateMinuto: number | null;
  readonly confianca: number;
}

export interface ItemDoCatalogo {
  readonly id: string;
  readonly nome: string;
}

/**
 * Abaixo disto o agente **escala para humano**.
 *
 * *"Escalada para humano quando a confiança é baixa ou em pedido do cliente."*
 * Não é enfeite: o custo de errar é uma cadeira ocupada e um cliente que não vem.
 */
export const CONFIANCA_PARA_AGIR = 0.6;

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const PISTAS_DE_INTENCAO: readonly { readonly intencao: Intencao; readonly palavras: readonly string[] }[] = [
  {
    intencao: 'falar_com_humano',
    palavras: ['falar com alguem', 'atendente', 'pessoa de verdade', 'humano', 'nao e isso'],
  },
  {
    intencao: 'remarcar',
    palavras: ['remarcar', 'mudar o horario', 'trocar o horario', 'passar para', 'adiar'],
  },
  {
    intencao: 'cancelar',
    palavras: ['cancelar', 'desmarcar', 'nao vou poder', 'nao consigo ir', 'nao vou conseguir'],
  },
  {
    intencao: 'marcar',
    palavras: ['quero cortar', 'quero marcar', 'agendar', 'marcar', 'tem horario', 'da pra', 'queria cortar'],
  },
  {
    intencao: 'consultar_horario',
    palavras: ['que horas', 'meu horario', 'quando e', 'confirmar meu'],
  },
];

/**
 * Querer, sem dizer o verbo de agendar.
 *
 * São as palavras que transformam o nome de um serviço em pedido: *"quero um
 * corte"*, *"preciso de uma barba"*. Ficam separadas das pistas de intenção
 * porque sozinhas não dizem nada — "quero saber o preço" também tem "quero", e
 * é a terceira condição da regra que separa as duas.
 */
const PISTAS_DE_DESEJO: readonly string[] = [
  'quero',
  'queria',
  'gostaria',
  'preciso',
  'to precisando',
  'vou querer',
  'tem vaga',
  'tem como',
];

/** "amanhã" e afins. A data absoluta fica com quem tem o fuso — ver o cabeçalho. */
const PISTAS_DE_DIA: readonly { readonly palavras: readonly string[]; readonly dias: number }[] = [
  { palavras: ['depois de amanha'], dias: 2 },
  { palavras: ['amanha'], dias: 1 },
  { palavras: ['hoje', 'agora', 'mais tarde'], dias: 0 },
];

/**
 * As horas ditas em voz alta.
 *
 * `18h`, `18:30`, `as 18`, `depois das 18`. O `\b` no começo evita casar o "18"
 * de um telefone — e telefone aparece o tempo todo numa conversa de barbearia.
 */
const HORA = /\b(?:as\s+)?([01]?\d|2[0-3])(?:[:h](\d{2}))?\s*(?:h|horas)?\b/g;

const DEPOIS = ['depois das', 'depois de', 'a partir das', 'a partir de', 'apos as', 'apos'];
const ANTES = ['antes das', 'antes de', 'ate as', 'ate'];

/**
 * O que a pessoa pediu, casado contra o catálogo **desta** barbearia.
 *
 * `servicos` e `profissionais` entram por parâmetro porque o intérprete não sabe
 * ler banco — e é isso que garante que ele não invente nome nenhum: o que não
 * está na lista não sai daqui.
 */
export function interpretarPedido(
  texto: string,
  catalogo: {
    readonly servicos: readonly ItemDoCatalogo[];
    readonly profissionais: readonly ItemDoCatalogo[];
  },
): PedidoDoCliente | null {
  const t = normalizar(texto);
  if (t.trim().length === 0) return null;

  const achada = PISTAS_DE_INTENCAO.find((p) => p.palavras.some((w) => t.includes(w)));

  const servico = casar(t, catalogo.servicos);
  const profissional = casar(t, catalogo.profissionais);
  const dia = PISTAS_DE_DIA.find((d) => d.palavras.some((w) => t.includes(w)));
  const faixa = faixaDeHora(t);

  /**
   * O substantivo também marca — e era a frase mais comum que não funcionava.
   *
   * As pistas de intenção são todas **verbais**: "quero cortar", "agendar",
   * "marcar". Quem diz *"quero um corte amanhã"* — que é como se pede corte no
   * Brasil — não casava nenhuma, o intérprete devolvia nulo, a recepção não
   * tinha resposta, e o cliente lia "não entendi". A convenção
   * *"substantivo no catálogo, verbo na boca"* já existia neste arquivo e
   * cobria só metade do problema: o verbo que acha o substantivo. Faltava o
   * substantivo que dispensa o verbo.
   *
   * A regra é estreita de propósito, porque a errada aqui é cara: um pedido de
   * preço tratado como agendamento é o agente oferecendo horário a quem
   * perguntou quanto custa. Três condições ao mesmo tempo:
   *
   * 1. a frase **nomeia um serviço do catálogo** — sem isso não há o que marcar;
   * 2. carrega um sinal de agendamento: um dia, uma hora, ou uma palavra de
   *    querer ("quero", "queria", "preciso");
   * 3. **não é pergunta de recepção**. Quem decide isso é `assuntoDaPergunta`,
   *    a mesma função que a recepção usa — duas leituras da mesma frase por
   *    caminhos diferentes acabariam discordando, e a discordância apareceria
   *    como "quanto custa o corte?" virando oferta de horário.
   *
   * A confiança sai da fórmula de sempre, e é ela que segura o resto: sem dia,
   * "queria uma barba" fica em 0,60 e o agente **pergunta quando** em vez de
   * agir. É o desfecho certo para uma frase que de fato não disse quando.
   */
  const querer = PISTAS_DE_DESEJO.some((w) => t.includes(w));
  const marcarPeloSubstantivo =
    !achada
    && servico !== null
    && (dia !== undefined || faixa.de !== null || faixa.ate !== null || querer)
    && assuntoDaPergunta(texto) === null;

  if (!achada && !marcarPeloSubstantivo) return null;

  /**
   * A confiança sobe com o que a frase **fixa**.
   *
   * Uma intenção sozinha é pouco: "quero marcar" não diz o quê, com quem, nem
   * quando. Cada campo reconhecido é uma coisa a menos para perguntar — e o
   * agente age quando cruza o piso, senão ele pergunta.
   */
  let confianca = 0.35;
  if (servico) confianca += 0.25;
  if (dia) confianca += 0.2;
  if (faixa.de !== null || faixa.ate !== null) confianca += 0.1;
  if (profissional) confianca += 0.1;

  return {
    intencao: achada?.intencao ?? 'marcar',
    servicoId: servico?.id ?? null,
    servicoNome: servico?.nome ?? null,
    profissionalId: profissional?.id ?? null,
    profissionalNome: profissional?.nome ?? null,
    emQuantosDias: dia?.dias ?? null,
    aPartirDeMinuto: faixa.de,
    ateMinuto: faixa.ate,
    confianca: Math.min(1, confianca),
  };
}

/**
 * Quantas letras da raiz bastam para casar uma forma verbal.
 *
 * O catálogo guarda substantivo — "Corte", "Barba" — e a pessoa fala verbo:
 * *"quero **cortar**"*, *"vim **barbear**"*. `includes('corte')` não acha
 * "cortar", e o agente respondia "o que você quer fazer?" para a frase mais
 * comum que existe numa barbearia.
 *
 * Quatro letras é o piso: abaixo disso, "cor" casaria com qualquer coisa. Acima,
 * "cort" deixa de achar "cortar".
 */
const LETRAS_DA_RAIZ = 4;

/**
 * Casa o nome contra o catálogo, do mais longo para o mais curto.
 *
 * "Corte e barba" contém "corte": sem ordenar por tamanho, a frase que pede o
 * combo cairia no serviço simples — e o cliente sairia com metade do que pediu,
 * pagando metade e ocupando metade do tempo que a agenda reservou.
 *
 * O nome inteiro vence a raiz, e por isso são **duas** passadas: com uma só, a
 * raiz de um nome curto acharia antes de o nome longo ser tentado.
 */
function casar(texto: string, itens: readonly ItemDoCatalogo[]): ItemDoCatalogo | null {
  const ordenados = [...itens].sort((a, b) => b.nome.length - a.nome.length);
  const inteiro = ordenados.find((i) => texto.includes(normalizar(i.nome)));
  if (inteiro) return inteiro;

  return (
    ordenados.find((i) => {
      const nome = normalizar(i.nome);
      // Só nomes de uma palavra viram raiz: "corte e barba" sem a última letra
      // é "corte e barb", que não casa com frase nenhuma e só gasta tempo.
      if (nome.includes(' ') || nome.length <= LETRAS_DA_RAIZ) return false;
      return texto.includes(nome.slice(0, LETRAS_DA_RAIZ));
    }) ?? null
  );
}

/**
 * A faixa de hora pedida, em minutos desde a meia-noite.
 *
 * "Depois das 18h" é um piso; "até as 12h" é um teto. Confundir os dois é a
 * diferença entre oferecer o que serve e oferecer o que não serve — e quem
 * disse "até meio-dia" está dizendo que **precisa ir embora** ao meio-dia.
 */
function faixaDeHora(texto: string): { readonly de: number | null; readonly ate: number | null } {
  const horas: { minuto: number; posicao: number }[] = [];
  for (const achado of texto.matchAll(HORA)) {
    const h = Number(achado[1]);
    const m = Number(achado[2] ?? 0);
    if (Number.isNaN(h) || m > 59) continue;
    horas.push({ minuto: h * 60 + m, posicao: achado.index ?? 0 });
  }
  if (horas.length === 0) return { de: null, ate: null };

  let de: number | null = null;
  let ate: number | null = null;

  for (const hora of horas) {
    const antesDela = texto.slice(Math.max(0, hora.posicao - 18), hora.posicao);
    if (DEPOIS.some((w) => antesDela.includes(w))) de = hora.minuto;
    else if (ANTES.some((w) => antesDela.includes(w))) ate = hora.minuto;
  }

  /**
   * Hora dita sem "depois" nem "antes" é a hora **pedida**, não um piso.
   *
   * "Quero cortar amanhã às 19h" quer 19h. Tratá-la como piso ofereceria 19h,
   * 20h e 21h — e a pessoa que só pode às 19h veria três opções das quais duas
   * não servem, o que é pior que uma pergunta.
   */
  if (de === null && ate === null && horas[0]) {
    de = horas[0].minuto;
    ate = horas[0].minuto;
  }

  return { de, ate };
}

/** O que ainda falta perguntar antes de propor um horário. */
export type FaltaNoPedido = 'servico' | 'dia';

export function oQueFalta(pedido: PedidoDoCliente): readonly FaltaNoPedido[] {
  const falta: FaltaNoPedido[] = [];
  if (pedido.servicoId === null) falta.push('servico');
  if (pedido.emQuantosDias === null) falta.push('dia');
  return falta;
}

/**
 * A pergunta que o agente faz quando falta alguma coisa.
 *
 * Uma por vez, e a mais importante primeiro: perguntar duas coisas numa
 * mensagem faz a pessoa responder uma e o agente ficar no mesmo lugar.
 */
export const PERGUNTA_DO_AGENTE: Readonly<Record<FaltaNoPedido, string>> = {
  servico: 'O que você quer fazer? Corte, barba, ou os dois?',
  dia: 'Para que dia?',
};

/**
 * Se o horário oferecido serve para o que foi pedido.
 *
 * `contains`, nunca `overlaps` — é a mesma decisão da lista de espera do bloco
 * 39. Quem pediu "até meio-dia" está dizendo que precisa ir embora ao meio-dia;
 * uma vaga que começa 11:40 põe a pessoa na cadeira até 12:10, e a oferta vira
 * mensagem inútil.
 */
export function horarioServe(
  pedido: PedidoDoCliente,
  slot: { readonly inicioMinuto: number; readonly fimMinuto: number },
): boolean {
  if (pedido.aPartirDeMinuto !== null && slot.inicioMinuto < pedido.aPartirDeMinuto) return false;
  if (pedido.ateMinuto !== null && slot.fimMinuto > pedido.ateMinuto + DURACAO_TOLERADA) return false;
  return true;
}

/**
 * A folga que "até as 12h" tolera no fim do serviço.
 *
 * Zero seria rígido demais: quem diz "até meio-dia" aceita sair 12:10, e recusar
 * isso esvazia a oferta em toda barbearia cuja grade não fecha exatamente na
 * hora cheia. Quinze minutos é meio slot — o suficiente para não parecer que o
 * agente ignorou o pedido.
 */
export const DURACAO_TOLERADA = 15;
