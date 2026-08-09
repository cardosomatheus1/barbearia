import { withTenant } from '@barbearia/db';
import type { TipoDeNotificacao } from '@barbearia/core';
import {
  concluirTarefa,
  falharTarefa,
  soltarOrfas,
  tomarTarefas,
  type Tarefa,
} from './fila.js';
import { marcarFalta } from './faltas.js';
import { agendarApuracaoDeTodas, apuracaoPendente, apurarDiaDaBarbearia } from './metricas.js';
import { agendarVarreduraDeRetorno } from './preferencias.js';
import {
  executarAvisoDeAgendamento,
  executarAvisoDeFila,
  varrerRetornos,
  type NotificationProvider,
} from './notificacoes.js';

/**
 * O worker: o primeiro processo do produto que roda sem ninguém esperando.
 *
 * Três decisões que valem ser lidas antes de mexer:
 *
 * 1. **Ele não sabe nada de negócio.** Toma tarefa, chama o handler, marca o
 *    resultado. Toda regra vive em `packages/core` e o acesso a dado passa por
 *    `withTenant` dentro do handler. Um worker que soubesse de comissão ou de
 *    fila viraria a segunda cópia dessas regras.
 *
 * 2. **Uma tarefa por vez, em série.** Barbearia não precisa de mais, e
 *    paralelismo aqui compraria contenção de conexão e ordem imprevisível em
 *    troca de vazão que ninguém pediu. Quando precisar, `tomarTarefas` já
 *    devolve lote e `SKIP LOCKED` já permite vários processos.
 *
 * 3. **Handler desconhecido é falha, não silêncio.** Tarefa de um tipo que
 *    ninguém trata some da fila se for marcada como feita — e some junto o
 *    aviso de que alguém enfileirou algo que este worker não sabe fazer.
 */

export interface Relogio {
  agora(): Date;
}

export const RELOGIO_REAL: Relogio = { agora: () => new Date() };

export type Handler = (tarefa: Tarefa, contexto: Contexto) => Promise<void>;

export interface Contexto {
  readonly provider: NotificationProvider;
  readonly relogio: Relogio;
}

const avisoDeAgendamento =
  (tipo: TipoDeNotificacao): Handler =>
  async (tarefa, contexto) => {
    const appointmentId = String(tarefa.payload['appointmentId'] ?? '');
    if (!appointmentId) throw new Error('tarefa de aviso sem agendamento');
    await executarAvisoDeAgendamento({
      tenantId: tarefa.tenantId,
      appointmentId,
      tipo,
      provider: contexto.provider,
      agora: contexto.relogio.agora(),
    });
  };

export const HANDLERS: Readonly<Record<string, Handler>> = {
  'notificacao.confirmacao': avisoDeAgendamento('confirmacao'),
  'notificacao.lembrete_24h': avisoDeAgendamento('lembrete_24h'),
  'notificacao.lembrete_2h': avisoDeAgendamento('lembrete_2h'),

  'notificacao.sua_vez': async (tarefa, contexto) => {
    const queueEntryId = String(tarefa.payload['queueEntryId'] ?? '');
    if (!queueEntryId) throw new Error('tarefa de fila sem entrada');
    await executarAvisoDeFila({
      tenantId: tarefa.tenantId,
      queueEntryId,
      provider: contexto.provider,
    });
  },

  /**
   * A varredura de retorno, que se reprograma sozinha.
   *
   * É a única tarefa periódica do produto, e ela **não** é uma varredura de
   * plataforma: `locations` tem RLS, então nenhum processo sem tenant no
   * contexto consegue descobrir quais barbearias querem a mensagem. A cadeia
   * nasce quando a barbearia liga o aviso e se mantém aqui, uma tarefa
   * criando a próxima — e para quando ela desliga, porque
   * `agendarVarreduraDeRetorno` confere antes de enfileirar.
   */
  'notificacao.retorno': async (tarefa, contexto) => {
    const agora = contexto.relogio.agora();
    await varrerRetornos({
      tenantId: tarefa.tenantId,
      provider: contexto.provider,
      agora,
    });
    await withTenant(tarefa.tenantId, (tx) =>
      agendarVarreduraDeRetorno(tx, {
        tenantId: tarefa.tenantId,
        quando: new Date(agora.getTime() + 24 * 60 * 60_000),
      }),
    );
  },

  /**
   * A apuração do dia de uma barbearia (bloco 25).
   *
   * Uma tarefa por barbearia, com `withTenant`, exatamente como a falta
   * automática — e pelo mesmo motivo: `appointments` tem RLS, e nenhuma
   * varredura de plataforma consegue lê-la.
   */
  'metricas.dia': async (tarefa) => {
    const dia = String(tarefa.payload['dia'] ?? '');
    if (!dia) throw new Error('tarefa de métricas sem dia');
    await apurarDiaDaBarbearia(tarefa.tenantId, dia);
  },

  'agendamento.marcar_falta': async (tarefa, contexto) => {
    const appointmentId = String(tarefa.payload['appointmentId'] ?? '');
    if (!appointmentId) throw new Error('tarefa de falta sem agendamento');
    await marcarFalta(tarefa.tenantId, appointmentId, contexto.relogio.agora());
  },
};

export interface ResultadoDaRodada {
  readonly tomadas: number;
  readonly concluidas: number;
  readonly falhadas: number;
  readonly reagendadas: number;
}

/**
 * Uma rodada: toma um lote, executa, marca.
 *
 * Separada do laço de propósito — é ela que o teste chama. Um worker cuja única
 * porta de entrada é `while (true)` só pode ser testado com relógio de parede e
 * `sleep`, que é como suíte de teste vira lenta e instável.
 */
export async function rodada(
  contexto: Contexto,
  opcoes: { readonly lote?: number; readonly quem?: string } = {},
): Promise<ResultadoDaRodada> {
  const tarefas = await tomarTarefas(
    opcoes.lote ?? 10,
    opcoes.quem ?? 'worker',
    contexto.relogio.agora(),
  );

  let concluidas = 0;
  let falhadas = 0;
  let reagendadas = 0;

  for (const tarefa of tarefas) {
    const handler = HANDLERS[tarefa.kind];
    try {
      if (!handler) throw new Error(`tarefa sem handler: ${tarefa.kind}`);
      await handler(tarefa, contexto);
      await concluirTarefa(tarefa.id);
      concluidas += 1;
    } catch (erro) {
      const desfecho = await falharTarefa(
        tarefa,
        erro instanceof Error ? erro.message : String(erro),
        contexto.relogio.agora(),
      );
      if (desfecho === 'failed') falhadas += 1;
      else reagendadas += 1;
    }
  }

  return { tomadas: tarefas.length, concluidas, falhadas, reagendadas };
}

/**
 * O laço.
 *
 * `parar` é uma função de propósito: o processo precisa terminar a tarefa em
 * curso antes de sair, e não no meio dela. Matar no meio deixa `running`
 * pendurado até a varredura de órfãs — que existe, mas é a rede, não o plano.
 */
export async function rodarWorker(
  contexto: Contexto,
  opcoes: {
    readonly intervaloMs?: number;
    readonly parar?: () => boolean;
    readonly aoRodar?: (resultado: ResultadoDaRodada) => void;
  } = {},
): Promise<void> {
  const intervalo = opcoes.intervaloMs ?? 5_000;
  const parar = opcoes.parar ?? (() => false);
  /**
   * O último dia já enfileirado por **este** processo.
   *
   * A correção contra dois workers é o índice único de `jobs`, não esta
   * variável — ela só evita gastar um `INSERT ... SELECT` a cada cinco
   * segundos para depois o banco recusar tudo.
   */
  let ultimaApuracao: string | null = null;

  while (!parar()) {
    await soltarOrfas(15, contexto.relogio.agora());

    // A apuração diária mora aqui, ao lado da varredura de órfãs, porque é a
    // outra coisa que o worker faz **sem** ser uma tarefa: alguém precisa
    // enfileirar a primeira, e uma barbearia criada hoje não estaria em
    // nenhuma corrente iniciada ontem.
    const pendente = apuracaoPendente(contexto.relogio.agora());
    if (pendente.dia !== ultimaApuracao) {
      ultimaApuracao = pendente.dia;
      await agendarApuracaoDeTodas(pendente);
    }

    const resultado = await rodada(contexto);
    opcoes.aoRodar?.(resultado);

    // Só dorme quando não havia nada: com fila cheia, a próxima volta é
    // imediata. Dormir sempre atrasaria o lembrete em até um intervalo por
    // tarefa, e a fila nunca alcançaria um pico.
    if (resultado.tomadas === 0 && !parar()) {
      await new Promise((resolve) => setTimeout(resolve, intervalo));
    }
  }
}
