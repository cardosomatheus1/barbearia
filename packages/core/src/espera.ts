import { contains, type Minutes, type TimeRange } from './time.js';

/**
 * A lista de espera (SPEC §2.9, bloco 38).
 *
 * "Não tem horário no sábado? **Avise-me se surgir uma vaga.**" É uma das três
 * alavancas de maior retorno da SPEC §2.5, e o concorrente analisado não tem.
 *
 * ## O que ela é, e o que ela não é
 *
 * Não é a fila presencial do §2.10, que já existe desde o bloco 17. Aquela é
 * sobre quem **está na porta agora**; esta é sobre quem foi embora sem
 * conseguir marcar. As duas se parecem no nome e não compartilham nada: uma
 * ordena por chegada e a outra por compatibilidade com uma vaga que ainda não
 * existe.
 *
 * ## Por que a compatibilidade mora aqui
 *
 * Decidir se uma vaga serve para alguém é a regra que o barbeiro discute — "eu
 * pedi sábado de manhã e vocês me ligaram para as 17h" —, então ela precisa ser
 * lida sem banco no meio. Aqui não há relógio nem fuso: o dia vem em `YYYY-MM-DD`
 * da unidade e a janela em minutos locais, como em todo o resto de
 * `packages/core`.
 */

/** Uma entrada de espera, do ponto de vista da regra. */
export interface PedidoDeEspera {
  /** Primeiro dia aceito, `YYYY-MM-DD` na data da unidade. */
  readonly de: string;
  /** Último dia aceito, inclusive. Igual a `de` quando é um dia só. */
  readonly ate: string;
  /** Faixa de minutos locais aceita no dia. */
  readonly janela: TimeRange;
  /** Nulo significa "qualquer profissional", que é o caso comum. */
  readonly profissionalId: string | null;
  /** Quanto tempo o que ela quer marcar ocupa, com buffers. */
  readonly duracaoMinutos: Minutes;
}

/** Uma vaga que abriu — o buraco que um cancelamento deixou na grade. */
export interface VagaAberta {
  readonly dia: string;
  readonly janela: TimeRange;
  readonly profissionalId: string;
}

/**
 * O limite de entradas ativas por cliente (SPEC §2.9).
 *
 * Existe contra quem entra em tudo: sem teto, uma pessoa se inscreve para os
 * sete dias da semana e passa a receber todo aviso de vaga da barbearia — e o
 * aviso deixa de significar alguma coisa para todo mundo.
 */
export const LIMITE_DE_ESPERAS_ATIVAS = 3;

/**
 * Quantos dias para a frente a espera aceita.
 *
 * A mesma janela máxima de agendamento não serve: pedir para ser avisado de uma
 * vaga em oito meses é entrada que vai expirar sem nunca ter sido útil, e que
 * ocupa uma das três vagas do cliente até lá.
 */
export const DIAS_MAXIMOS_DE_ESPERA = 60;

/**
 * A vaga serve para este pedido?
 *
 * Três perguntas, e a ordem é a de quem explica no balcão:
 *
 * 1. **É um dos dias que a pessoa pediu?**
 * 2. **É com quem ela pediu?** Pedido sem profissional aceita qualquer um —
 *    mas o contrário não: quem pediu o Ruan não quer ser avisado do Gleidson.
 * 3. **O serviço cabe dentro da janela pedida?** E é `contains`, não `overlaps`:
 *    uma vaga das 11:40 às 12:20 não serve para quem pediu "até meio-dia", porque
 *    a pessoa estaria na cadeira depois do horário que ela disse que podia.
 *
 * O que **não** se pergunta aqui é se a vaga tem tamanho suficiente — ela já vem
 * medida de quem a calculou, contra a grade real. Reconferir com a duração do
 * pedido seria refazer o motor de disponibilidade fora dele, e com dado velho.
 */
export function vagaServe(pedido: PedidoDeEspera, vaga: VagaAberta): boolean {
  if (vaga.dia < pedido.de || vaga.dia > pedido.ate) return false;
  if (pedido.profissionalId && pedido.profissionalId !== vaga.profissionalId) return false;

  // O serviço começa quando a vaga começa e ocupa o que ocupa; o fim dele é que
  // precisa caber. A vaga pode ser maior que o pedido — isso é bom, não ruim.
  const atendimento: TimeRange = {
    start: vaga.janela.start,
    end: vaga.janela.start + pedido.duracaoMinutos,
  };
  if (atendimento.end > vaga.janela.end) return false;

  return contains(pedido.janela, atendimento);
}

/**
 * A entrada já passou do prazo?
 *
 * Expira quando o **último** dia pedido acaba, não quando o primeiro chega:
 * quem pediu "de segunda a sábado" continua na fila na quinta. A comparação é
 * de string porque `YYYY-MM-DD` ordena como data — e converter para `Date`
 * aqui traria fuso para dentro de `packages/core`, que é justamente o que a
 * regra da casa proíbe.
 */
export function esperaExpirou(pedido: { readonly ate: string }, hojeNaUnidade: string): boolean {
  return pedido.ate < hojeNaUnidade;
}

export type RecusaDeEspera =
  | 'janela_invalida'
  | 'periodo_invertido'
  | 'periodo_longo_demais'
  | 'dia_no_passado'
  | 'limite_atingido';

export interface DecisaoDeEspera {
  readonly aceito: boolean;
  readonly recusa: RecusaDeEspera | null;
}

const aceita: DecisaoDeEspera = { aceito: true, recusa: null };
const nega = (recusa: RecusaDeEspera): DecisaoDeEspera => ({ aceito: false, recusa });

/**
 * Se este pedido pode entrar na lista.
 *
 * Separado de `vagaServe` de propósito: um valida a **entrada**, o outro casa
 * entrada com vaga. Juntá-los faria a recusa de um pedido malformado sair como
 * "nenhuma vaga serve", que é a mesma resposta de um pedido perfeito num dia
 * cheio — e a pessoa não teria como saber a diferença.
 */
export function podeEsperar(params: {
  readonly pedido: PedidoDeEspera;
  readonly ativasDoCliente: number;
  readonly hojeNaUnidade: string;
  readonly ultimoDiaAceito: string;
}): DecisaoDeEspera {
  const { pedido } = params;

  if (pedido.janela.end <= pedido.janela.start) return nega('janela_invalida');
  if (pedido.ate < pedido.de) return nega('periodo_invertido');
  // Passado é o **último** dia: pedir "de ontem até sábado" é legítimo e vira
  // "de hoje até sábado" na prática, porque nenhuma vaga de ontem vai abrir.
  if (pedido.ate < params.hojeNaUnidade) return nega('dia_no_passado');
  /**
   * **As duas pontas** da faixa, e a segunda foi um achado da revisão.
   *
   * Conferir só o começo deixava `ate` livre: uma entrada de hoje até
   * 2099-12-31 passava, e nunca expirava — `expirarEsperas` só fecha o que já
   * passou. Três dessas, cobrindo o dia de trabalho, faziam uma pessoa ser
   * candidata permanente a toda vaga que abrisse na barbearia. É exatamente o
   * que o teto de três e o horizonte existem para impedir, e ficava pior no
   * bloco 39, em que o topo da fila ganha janela exclusiva.
   */
  if (pedido.de > params.ultimoDiaAceito) return nega('periodo_longo_demais');
  if (pedido.ate > params.ultimoDiaAceito) return nega('periodo_longo_demais');
  if (params.ativasDoCliente >= LIMITE_DE_ESPERAS_ATIVAS) return nega('limite_atingido');

  return aceita;
}
