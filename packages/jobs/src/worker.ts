import { withTenant } from '@barbearia/db';
import type { Alerta, TipoDeNotificacao } from '@barbearia/core';
import {
  concluirTarefa,
  falharTarefa,
  soltarOrfas,
  tomarTarefas,
  type Tarefa,
} from './fila.js';
import { marcarFalta } from './faltas.js';
import { agendarApuracaoDeTodas, apuracaoPendente, apurarDiaDaBarbearia } from './metricas.js';
import { agendarRetencaoDeTodas, retencaoPendente } from './retencao.js';
import { agendarAlertasDeTodas, alertaPendente } from './alerta-agendado.js';
import {
  agendarCobrancaDoClubeDeTodas,
  agendarLiquidacaoDeTodas,
  cobrancaDoClubePendente,
} from './clube.js';
import { alertasDaBarbearia } from './alertas.js';
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
  /**
   * O recurso está ligado para esta barbearia? (bloco 26)
   *
   * Entra **injetado**, e não importado, para não inverter a direção das
   * dependências: a plataforma é a camada de cima, e `jobs` não deve saber que
   * ela existe. É o mesmo padrão do `provider` — quem monta o processo
   * (`apps/worker`) liga as duas pontas, e o teste liga uma versão de mentira.
   *
   * Obrigatório de propósito. Opcional, ele seria esquecido no primeiro handler
   * novo, e o interruptor de mensagem — que é o que tem custo por disparo —
   * pararia de valer sem nada ficar vermelho.
   */
  readonly recursoLigado: (tenantId: string, code: 'avisos') => Promise<boolean>;
  /**
   * O aviso de cobrança ao dono (bloco 28), injetado pelo mesmo motivo.
   *
   * Ele fala **pela plataforma com a barbearia**, ao contrário de tudo o mais
   * nesta fila, que fala pela barbearia com os clientes dela. Deixar `jobs`
   * importar `@barbearia/platform` para isso inverteria a seta — e o remetente
   * errado apareceria como cobrança saindo do WhatsApp da própria barbearia.
   */
  readonly avisarDeCobranca: (aviso: {
    readonly tenantId: string;
    readonly faturaId: string;
    readonly assunto: string;
    readonly agora: Date;
  }) => Promise<void>;
  /**
   * Uma volta da régua de cobrança.
   *
   * Não é tarefa da fila, e não pode ser: `jobs.tenant_id` é `NOT NULL` desde o
   * bloco 20, e "quem venceu hoje?" atravessa todas as barbearias. Ela roda no
   * laço, ao lado da varredura de órfãs, pelo mesmo motivo que a apuração
   * diária roda ali.
   */
  readonly rodarRegua: (agora: Date) => Promise<void>;
  /**
   * A varredura de retenção de uma barbearia (bloco 32), injetada.
   *
   * Mesma razão do `provider` e da régua: ela vive em `packages/crm`, que é
   * camada de cima, e `jobs` não pode conhecê-la sem inverter a seta. O que
   * chega aqui é a função pronta; quem a liga é `apps/worker`.
   *
   * Devolve quantos foram avisados e quantos saíram, só para o log — a decisão
   * de avisar ou anonimizar é tomada lá dentro, sobre a regra pura de `core`.
   */
  readonly varrerRetencao: (
    tenantId: string,
    agora: Date,
  ) => Promise<{ readonly avisados: number; readonly anonimizados: number }>;
  /**
   * A expiração da lista de espera (bloco 38), injetada.
   *
   * Mesma razão da varredura de retenção: ela vive em `packages/scheduling`,
   * que é camada de cima, e `jobs` não pode conhecê-la sem inverter a seta.
   *
   * **Obrigatória no tipo**, não opcional. Opcional, ela seria esquecida no
   * primeiro worker novo e a lista pararia de expirar sem nada ficar vermelho —
   * é o mesmo critério de `varrerRetencao`.
   */
  readonly expirarEsperas: (tenantId: string, agora: Date) => Promise<number>;
  /**
   * A oferta de vaga da lista de espera (bloco 39), injetada.
   *
   * Mesma razão de `varrerRetencao`: ela vive em `packages/scheduling` e manda
   * mensagem pelo provedor, e `jobs` não conhece nenhum dos dois. O que chega
   * aqui é a função pronta; quem a liga é `apps/worker`.
   *
   * Devolve se alguém foi convidado, só para o log — a decisão de a quem
   * oferecer é da fórmula de `packages/core`.
   */
  readonly oferecerVagaDaEspera: (
    tenantId: string,
    vaga: {
      readonly locationId: string;
      readonly professionalId: string;
      readonly inicio: Date;
      readonly fim: Date;
    },
    agora: Date,
  ) => Promise<boolean>;
  /**
   * A passagem ao próximo da fila quando a janela exclusiva vence (bloco 39).
   *
   * Devolve quantas vagas voltaram à mesa. Quem oferece de novo é o próprio
   * handler, pela função acima.
   */
  readonly vencerOfertasDaEspera: (tenantId: string, agora: Date) => Promise<number>;

  /**
   * A resposta a um recado, entregue ao cliente (bloco 40).
   *
   * Injetada pelo mesmo motivo da oferta de vaga e da varredura de retenção:
   * `jobs` não conhece `crm`, e quem monta o processo é quem liga as pontas.
   * Obrigatória e não opcional no tipo — opcional, ela seria esquecida no
   * primeiro worker novo e a resposta deixaria de sair sem nada ficar vermelho.
   *
   * Devolve `false` quando não há mais a quem responder: entre o enfileiramento
   * e o envio a pessoa pode ter pedido exclusão, e aí o `customer_id` foi
   * desatado. A tarefa conclui, porque não há o que repetir.
   */
  readonly responderRecadoDoCliente: (tenantId: string, recadoId: string) => Promise<boolean>;
  /**
   * Uma volta da liquidação de repasses (bloco 50), injetada.
   *
   * Mesma razão de todas as outras: ela vive em `packages/finance` e conhece o
   * adquirente, e `jobs` não conhece nenhum dos dois. Obrigatória no tipo — a
   * opcional é a que é esquecida no primeiro worker novo, e o barbeiro deixaria
   * de receber sem nada ficar vermelho.
   */
  readonly liquidarRepasses: (
    tenantId: string,
    agora: Date,
  ) => Promise<{ readonly repassados: number; readonly retidos: number }>;

  /**
   * Uma volta da régua de cobrança do clube (bloco 47), injetada.
   *
   * Mesma razão da varredura de retenção e da oferta de vaga: ela vive em
   * `packages/finance`, que é camada de cima, e conhece o adquirente — `jobs`
   * não conhece nenhum dos dois. Quem liga as pontas é `apps/worker`.
   *
   * **Obrigatória no tipo**, não opcional. Opcional, ela seria esquecida no
   * primeiro worker novo e o clube pararia de cobrar sem nada ficar vermelho —
   * é o mesmo critério de `varrerRetencao`.
   */
  readonly rodarCobrancaDoClube: (
    tenantId: string,
    agora: Date,
  ) => Promise<{ readonly cobradas: number; readonly suspensas: number }>;
  /**
   * O aviso do clube entregue ao assinante (bloco 47), injetado.
   *
   * Devolve `false` quando não há mais a quem avisar — entre o enfileiramento e
   * o envio a pessoa pode ter pedido exclusão, e aí não há telefone. A tarefa
   * conclui, porque não há o que repetir.
   */
  readonly avisarDoClube: (
    tenantId: string,
    assinaturaId: string,
    motivo: string,
    agora: Date,
  ) => Promise<boolean>;
  /**
   * O alerta operacional saindo pelo canal do gestor (bloco 33), injetado.
   *
   * Era lacuna declarada desde o bloco 22: as regras decidiam, o coletor
   * alimentava, e a lista pronta não ia para lugar nenhum. Quem a produz é este
   * pacote (`alertasDaBarbearia`); quem a entrega é a plataforma, que conhece o
   * dono e o canal. A seta não volta — `apps/worker` liga as duas pontas, como
   * já faz com a régua de cobrança.
   */
  readonly avisarDaOperacao: (
    tenantId: string,
    alertas: readonly Alerta[],
    agora: Date,
  ) => Promise<void>;
  /**
   * A conferência das cobranças online de uma barbearia (bloco 35), injetada.
   *
   * Mesma razão de todas as outras: ela vive em `packages/finance` e precisa do
   * adquirente e do fuso da unidade, e `jobs` não conhece nenhum dos dois. Quem
   * liga as pontas é `apps/worker`.
   *
   * O webhook é o caminho e chega em segundos; isto é a rede de segurança para
   * quando ele se perde — e é o que faz o Pix vencido liberar a comanda, sem o
   * quê ela ficaria presa a um QR Code que nenhum banco aceita mais.
   */
  readonly conciliarCobrancas: (
    tenantId: string,
    agora: Date,
  ) => Promise<{ readonly pagas: number; readonly encerradas: number }>;
}

const avisoDeAgendamento =
  (tipo: TipoDeNotificacao): Handler =>
  async (tarefa, contexto) => {
    const appointmentId = String(tarefa.payload['appointmentId'] ?? '');
    if (!appointmentId) throw new Error('tarefa de aviso sem agendamento');
    // A checagem é **na hora de enviar**, não na de enfileirar. Desligar o
    // recurso precisa parar também o lembrete que já está na fila para amanhã —
    // e é justamente o que já está na fila que continuaria custando mensagem.
    if (!(await contexto.recursoLigado(tarefa.tenantId, 'avisos'))) return;
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
    if (!(await contexto.recursoLigado(tarefa.tenantId, 'avisos'))) return;
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
    // A varredura de retorno se reprograma sozinha, então o recurso desligado
    // pula o envio **e** mantém a corrente viva: religar não pode exigir que
    // alguém lembre de reenfileirar a primeira.
    if (await contexto.recursoLigado(tarefa.tenantId, 'avisos')) {
      await varrerRetornos({
      tenantId: tarefa.tenantId,
        provider: contexto.provider,
        agora,
      });
    }
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

  /**
   * O aviso de cobrança ao dono (bloco 28).
   *
   * O handler só repassa: quem lê a fatura, confere se ela ainda está aberta e
   * respeita a janela de silêncio da unidade é a plataforma, porque é lá que a
   * cobrança mora. Aqui ficaria a segunda cópia dessas regras.
   */
  'cobranca.aviso': async (tarefa, contexto) => {
    const faturaId = String(tarefa.payload['faturaId'] ?? '');
    const assunto = String(tarefa.payload['assunto'] ?? '');
    if (!faturaId || !assunto) throw new Error('aviso de cobrança sem fatura ou assunto');
    await contexto.avisarDeCobranca({
      tenantId: tarefa.tenantId,
      faturaId,
      assunto,
      agora: contexto.relogio.agora(),
    });
  },

  /**
   * A conferência das cobranças online de uma barbearia (bloco 35).
   *
   * Nasce junto com a cobrança, dentro da mesma transação, e roda depois da
   * janela do Pix. **Não** confere recurso ligado: isto não manda mensagem —
   * fecha venda e libera comanda travada, que é o oposto de algo opcional.
   */
  'cobranca.conciliar': async (tarefa, contexto) => {
    await contexto.conciliarCobrancas(tarefa.tenantId, contexto.relogio.agora());
  },

  /**
   * A retenção do dia de uma barbearia (bloco 32).
   *
   * Uma tarefa por barbearia, com `withTenant` lá dentro, exatamente como a
   * apuração e a falta automática — e pelo mesmo motivo: `customers` tem RLS, e
   * nenhuma varredura de plataforma consegue lê-la.
   *
   * **Não** confere recurso ligado. Retenção de dado pessoal é obrigação legal,
   * não recurso opcional: um interruptor aqui seria um botão para deixar de
   * cumprir a lei.
   */
  'lgpd.retencao': async (tarefa, contexto) => {
    await contexto.varrerRetencao(tarefa.tenantId, contexto.relogio.agora());

    /**
     * A lista de espera vencida sai na mesma volta (bloco 38).
     *
     * Junto da retenção e não numa tarefa própria porque é a mesma natureza —
     * varredura diária, uma por barbearia, escrevendo de madrugada — e porque
     * uma segunda cadeia de agendamento seria mais peça para manter do que
     * trabalho para fazer.
     *
     * Sem ela, `expired` seria um estado que ninguém escreve: a entrada
     * continuaria ocupando uma das três vagas do cliente para sempre, e a lista
     * dele mostraria um sábado que já passou.
     */
    await contexto.expirarEsperas(tarefa.tenantId, contexto.relogio.agora());
  },

  /**
   * A varredura de alerta de uma barbearia (bloco 33).
   *
   * Uma por barbearia e com `withTenant` lá dentro, como a apuração e a
   * retenção: `appointments` e `jobs` têm RLS, e nenhuma varredura de
   * plataforma consegue lê-las.
   *
   * O que decide se sai mensagem é a preferência do dono, e ela mora do lado da
   * plataforma junto do canal. Aqui só se coleta e se repassa.
   */
  'alerta.varredura': async (tarefa, contexto) => {
    const agora = contexto.relogio.agora();
    const alertas = await alertasDaBarbearia(tarefa.tenantId, agora);
    if (alertas.length === 0) return;
    await contexto.avisarDaOperacao(tarefa.tenantId, alertas, agora);
  },

  /**
   * A vaga que abriu, oferecida ao topo da fila (bloco 39, SPEC §2.9).
   *
   * A tarefa nasce **dentro da transação do cancelamento** e roda fora dela:
   * oferecer manda mensagem, e mandar mensagem dentro da transação que desmarca
   * o horário travaria a tela da recepção num provedor lento.
   *
   * Ninguém na fila não é erro — é o caso comum, e a tarefa conclui em silêncio.
   */
  'espera.oferecer': async (tarefa, contexto) => {
    const locationId = String(tarefa.payload['locationId'] ?? '');
    const professionalId = String(tarefa.payload['professionalId'] ?? '');
    const inicio = String(tarefa.payload['inicio'] ?? '');
    const fim = String(tarefa.payload['fim'] ?? '');
    if (!locationId || !professionalId || !inicio || !fim) return;

    /**
     * Respeita o interruptor de avisos da barbearia, como todo aviso ao cliente.
     *
     * Sem isto, quem desligou as mensagens continuaria mandando convite de vaga
     * — e o convite é o mais intrusivo de todos, porque tem relógio correndo.
     */
    if (!(await contexto.recursoLigado(tarefa.tenantId, 'avisos'))) return;

    await contexto.oferecerVagaDaEspera(
      tarefa.tenantId,
      {
        locationId,
        professionalId,
        inicio: new Date(inicio),
        fim: new Date(fim),
      },
      contexto.relogio.agora(),
    );
  },

  /**
   * A resposta ao recado do cliente (bloco 40).
   *
   * A tarefa nasce **dentro da transação** que grava a resposta: enfileirar
   * depois do commit abriria a janela em que o balcão vê "respondido" e o
   * cliente nunca recebe nada — e a mensagem é a única coisa que este canal
   * entrega.
   *
   * Respeita o interruptor de avisos como todo aviso ao cliente. O custo está
   * escrito: quem desligou as mensagens responde pelo próprio WhatsApp, e a
   * resposta gravada continua sendo o registro do que foi dito.
   */
  'recado.responder': async (tarefa, contexto) => {
    const recadoId = String(tarefa.payload['recadoId'] ?? '');
    if (!recadoId) return;
    if (!(await contexto.recursoLigado(tarefa.tenantId, 'avisos'))) return;

    await contexto.responderRecadoDoCliente(tarefa.tenantId, recadoId);
  },

  /**
   * A janela exclusiva venceu: passa ao próximo (bloco 39).
   *
   * A varredura é por barbearia e não por oferta, mesmo a tarefa carregando um
   * id: uma oferta que venceu no mesmo minuto que outra sai junto, e o laço
   * pela fila de trabalho custaria uma volta por pessoa.
   */
  'espera.vencer': async (tarefa, contexto) => {
    await contexto.vencerOfertasDaEspera(tarefa.tenantId, contexto.relogio.agora());
  },

  /**
   * A liquidação dos repasses (bloco 50).
   *
   * Uma tarefa por barbearia pelo mesmo motivo da cobrança do clube:
   * `payment_splits` tem RLS `FORCE`, e um processo sem tenant enxerga zero
   * linhas. Ela roda **junto** com a cobrança, na mesma volta e no mesmo
   * horário: as duas falam com o adquirente, e empilhá-las de madrugada é o que
   * mantém o expediente livre de espera de rede.
   */
  'split.liquidar': async (tarefa, contexto) => {
    await contexto.liquidarRepasses(tarefa.tenantId, contexto.relogio.agora());
  },

  /**
   * A régua de cobrança do clube (bloco 47).
   *
   * Uma tarefa por barbearia, ao contrário da régua da plataforma: `club_invoices`
   * tem RLS `FORCE`, e um processo sem tenant no contexto enxerga zero linhas.
   */
  'clube.cobranca': async (tarefa, contexto) => {
    await contexto.rodarCobrancaDoClube(tarefa.tenantId, contexto.relogio.agora());
  },

  /**
   * O aviso ao assinante: cobrança recusada, atraso, pausa, cartão vencendo.
   *
   * A tarefa nasce **dentro da transação** que muda o estado da fatura —
   * enfileirar depois do commit abre a janela em que o plano foi pausado e
   * ninguém soube, que é exatamente a janela que a suspensão "avisada" da SPEC
   * §4.6 existe para fechar.
   *
   * Respeita o interruptor de avisos, como todo aviso ao cliente. O custo está
   * escrito: quem desligou as mensagens avisa pelo próprio WhatsApp, e o estado
   * gravado continua sendo o registro do que aconteceu.
   */
  'clube.aviso': async (tarefa, contexto) => {
    const subscriptionId = String(tarefa.payload['subscriptionId'] ?? '');
    const motivo = String(tarefa.payload['motivo'] ?? '');
    if (!subscriptionId || !motivo) return;
    if (!(await contexto.recursoLigado(tarefa.tenantId, 'avisos'))) return;

    await contexto.avisarDoClube(
      tarefa.tenantId,
      subscriptionId,
      motivo,
      contexto.relogio.agora(),
    );
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
  /**
   * O último dia em que **este** processo rodou a régua de cobrança.
   *
   * Dois workers rodam duas voltas no mesmo dia, e está certo assim: a régua é
   * reentrante por construção — a emissão é idempotente pelo índice, o aviso
   * pela chave da fila, e o passo de cada fatura sai de datas já gravadas. A
   * variável evita a volta repetida a cada cinco segundos, não a repetida entre
   * processos; querer exatidão aqui exigiria uma tarefa sem tenant, que é
   * justamente o que `jobs` recusa desde o bloco 20.
   */
  let ultimaRegua: string | null = null;
  /** O último dia em que este processo enfileirou a varredura de retenção. */
  let ultimaRetencao: string | null = null;
  /** E a de alerta, que roda de manhã em vez de de madrugada. */
  let ultimoAlerta: string | null = null;
  /** E a da cobrança do clube, que roda de madrugada e fala com o adquirente. */
  let ultimoClube: string | null = null;

  while (!parar()) {
    await soltarOrfas(15, contexto.relogio.agora());

    const hoje = contexto.relogio.agora().toISOString().slice(0, 10);
    if (hoje !== ultimaRegua) {
      ultimaRegua = hoje;
      await contexto.rodarRegua(contexto.relogio.agora());
    }

    // A apuração diária mora aqui, ao lado da varredura de órfãs, porque é a
    // outra coisa que o worker faz **sem** ser uma tarefa: alguém precisa
    // enfileirar a primeira, e uma barbearia criada hoje não estaria em
    // nenhuma corrente iniciada ontem.
    const pendente = apuracaoPendente(contexto.relogio.agora());
    if (pendente.dia !== ultimaApuracao) {
      ultimaApuracao = pendente.dia;
      await agendarApuracaoDeTodas(pendente);
    }

    // A retenção mora ao lado da apuração pelo mesmo motivo: alguém precisa
    // enfileirar a primeira, e uma barbearia criada hoje não está em nenhuma
    // corrente iniciada ontem.
    const retencao = retencaoPendente(contexto.relogio.agora());
    if (retencao.dia !== ultimaRetencao) {
      ultimaRetencao = retencao.dia;
      await agendarRetencaoDeTodas(retencao);
    }

    const alerta = alertaPendente(contexto.relogio.agora());
    if (alerta.dia !== ultimoAlerta) {
      ultimoAlerta = alerta.dia;
      await agendarAlertasDeTodas(alerta);
    }

    // A cobrança do clube, pelo mesmo motivo das duas acima: alguém precisa
    // enfileirar a primeira. Ela é a única das três que fala com o adquirente,
    // e por isso roda de madrugada e sozinha na volta.
    const clube = cobrancaDoClubePendente(contexto.relogio.agora());
    if (clube.dia !== ultimoClube) {
      ultimoClube = clube.dia;
      await agendarCobrancaDoClubeDeTodas(clube);
      // Na mesma volta: as duas falam com o adquirente, e é de madrugada que
      // isso não disputa rede com o balcão.
      await agendarLiquidacaoDeTodas(clube);
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
