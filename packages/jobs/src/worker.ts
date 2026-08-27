import { withTenant } from '@barbearia/db';
import { notaEmCurso, type Alerta, type EstadoDaNota, type TipoDeNotificacao } from '@barbearia/core';
import {
  concluirTarefa,
  enfileirar,
  falharTarefa,
  renovarTarefa,
  soltarOrfas,
  tomarTarefas,
  type Tarefa,
} from './fila.js';
import { marcarFalta } from './faltas.js';
import { agendarApuracaoDeTodas, apuracaoPendente, apurarDiaDaBarbearia } from './metricas.js';
import { agendarRetencaoDeTodas, retencaoPendente } from './retencao.js';
import {
  agendarAutomacaoDeTodas,
  agendarConciliacaoDeNotasDeTodas,
  cabeVoltaFiscal,
  agendarEntregaDeNotasDeTodas,
  entregaDeNotasPendente,
} from './fiscal.js';
import { agendarConciliacaoDoWhatsApp } from './whatsapp-conciliacao.js';
import { agendarAlertasDeTodas, alertaPendente } from './alerta-agendado.js';
import {
  agendarCobrancaDoClubeDeTodas,
  agendarLiquidacaoDeTodas,
  cobrancaDoClubePendente,
} from './clube.js';
import { alertasDaBarbearia } from './alertas.js';
// REPARO DA VALIDAÇÃO: o ZIP criou observabilidade.ts e usou os três
// símbolos no worker sem importá-los — cinco erros de compilação.
import {
  ehPulo,
  identificarErroDaTarefa,
  resumoPersistivelDoErro,
  PULO_POR_RECURSO,
  type EventoDaTarefa,
  type PuloDaTarefa,
} from './observabilidade.js';
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

/**
 * `PuloDaTarefa` no retorno: handler que decide não fazer nada **diz por quê**.
 *
 * `void` continua valendo para quem sempre faz o trabalho. Quem tem porteiro —
 * hoje o `recursoLigado` — devolve o motivo, e o laço o publica em vez de
 * concluir em silêncio.
 */
export type Handler = (tarefa: Tarefa, contexto: Contexto) => Promise<void | PuloDaTarefa>;

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
  /**
   * A entrega das notas autorizadas de uma barbearia (bloco 54), injetada.
   *
   * Mesma razão de `varrerRetencao`: ela vive em `packages/finance`, decide com
   * `packages/core` e manda pelo provedor de mensagem. Obrigatória e não
   * opcional no tipo — opcional, ela seria esquecida no primeiro worker novo, e
   * a nota deixaria de chegar ao cliente sem nada ficar vermelho.
   */
  readonly entregarNotas: (tenantId: string, agora: Date) => Promise<void>;
  /**
   * A conciliação das notas paradas em voo (bloco 121), injetada.
   *
   * Obrigatória no tipo pela razão de sempre: opcional, o primeiro worker novo
   * a esqueceria e a nota cuja tarefa morreu voltaria a ficar presa — sem erro,
   * sem alerta, e com a venda sem aceitar emissão nova.
   */
  readonly conciliarNotas: (tenantId: string) => Promise<void>;
  /**
   * Esta instalação tem emissor fiscal contratado? (bloco 134)
   *
   * ## O vermelho de hora em hora
   *
   * `FISCAL_MODO` é da instalação e nasce `nenhum`. Mesmo assim o laço
   * enfileirava `fiscal.entregar` e `fiscal.conciliar` para **toda** barbearia
   * a cada hora, e `conciliarNotas` chamava `exigirEmissorFiscal()`, que lança.
   * Medido em produção: três tentativas por hora, nas duas barbearias, desde
   * sempre, terminando em `tarefa.falhou`.
   *
   * Nada quebrava — não há nota para conciliar sem emissor. Mas é o pior tipo
   * de log: vermelho constante e inofensivo, que ensina quem opera a não olhar.
   * Quando um erro de verdade aparecer, ele vai estar no meio desses.
   *
   * Booleano e não função porque a resposta não muda durante a vida do
   * processo: o modo é lido do ambiente no arranque, e trocá-lo exige subir de
   * novo. Obrigatório no tipo pela razão de sempre — opcional, o primeiro
   * worker novo o esqueceria e o vermelho voltaria.
   */
  readonly emiteNotaFiscal: boolean;
  /**
   * Uma volta do motor de automação (bloco 56), injetada.
   *
   * Mesma razão de `varrerRetencao`: ela lê em `packages/crm`, decide com
   * `packages/core` e manda pelo provedor de mensagem. Obrigatória no tipo —
   * opcional, o primeiro worker novo esqueceria dela e as automações ficariam
   * ligadas sem nunca disparar.
   */
  readonly rodarAutomacoes: (tenantId: string, agora: Date) => Promise<void>;
  /**
   * O despacho de uma campanha (bloco 82), injetado.
   *
   * Mesma razão de `rodarAutomacoes`: o público mora em `packages/crm`, a
   * decisão de mandar é de `packages/core` e a mensagem sai pelo `provider`.
   * Obrigatória no tipo — opcional, o primeiro worker novo a esqueceria e o
   * botão "Enviar" marcaria a campanha como `enviando` para sempre, sem nada
   * ficar vermelho e sem ninguém receber nada.
   */
  readonly enviarCampanha: (tenantId: string, campanhaId: string, agora: Date) => Promise<void>;
  /**
   * O toque no botão da mensagem virando ação (bloco 55), injetado.
   *
   * Mesma razão de `varrerRetencao` e de `entregarNotas`: ela lê em
   * `packages/crm`, decide com `packages/core` e mexe na agenda por
   * `packages/scheduling` — três pacotes que `jobs` não conhece. Obrigatória no
   * tipo: opcional, o primeiro worker novo esqueceria dela e o botão de
   * cancelar viraria um toque que não faz nada.
   */
  readonly responderWhatsApp: (
    tenantId: string,
    inboundId: string,
    agora: Date,
  ) => Promise<void>;
  /**
   * Pergunta à Meta o que ela ainda não respondeu desta barbearia (bloco 90).
   *
   * Injetada e **obrigatória no tipo**, pela mesma razão de `varrerRetencao`:
   * quem sabe falar com a Meta é `packages/crm`, e `jobs` não pode aprender
   * isso. Opcional, o primeiro worker novo esqueceria dela — e o sintoma seria
   * o de antes: o cadastro preso em "falta confirmar" e o texto preso em "Na
   * Meta", sem nada ficar vermelho.
   */
  readonly conciliarWhatsApp: (
    tenantId: string,
    agora: Date,
  ) => Promise<{ readonly promovido: boolean; readonly templates: number }>;
  /**
   * Leva um texto à Meta, fora da requisição (bloco 133).
   *
   * Medido em produção, o `POST` que fazia isso no caminho do balcão levava
   * **7.039 ms** contra um teto de 10 s — e estourar o teto significava o `web`
   * mostrar recusa sobre um texto que a Meta **já tinha recebido**, com a
   * tentativa seguinte batendo em "nome repetido". É o precedente da nota
   * fiscal: emissão nunca bloqueia a venda.
   *
   * Injetada e obrigatória no tipo, como `conciliarWhatsApp` e pelo mesmo
   * motivo: quem sabe falar com a Meta é `packages/crm`. Opcional, o primeiro
   * worker novo a esqueceria e o texto ficaria em `sending` para sempre — que é
   * o estado que **bloqueia a submissão seguinte**, então a barbearia perderia
   * o texto e o caminho de refazê-lo ao mesmo tempo.
   */
  readonly entregarTemplate: (
    tenantId: string,
    templateId: string,
    claim: string,
  ) => Promise<void>;
  /**
   * Inscreve o app nos eventos da WABA desta unidade (bloco 134).
   *
   * Injetada e obrigatória, como as outras: quem sabe falar com a Meta é
   * `packages/crm`. Opcional, o primeiro worker novo a esqueceria — e o sintoma
   * é o pior que existe, porque **nada quebra**: as mensagens saem, a Meta
   * aceita, e o produto simplesmente nunca fica sabendo se elas chegaram.
   */
  readonly assinarWaba: (tenantId: string, locationId: string) => Promise<void>;
  readonly varrerRetencao: (
    tenantId: string,
    agora: Date,
  ) => Promise<{ readonly avisados: number; readonly anonimizados: number }>;
  /**
   * A entrega de um webhook para terceiro (bloco 79), injetada.
   *
   * Mesma razão de todas as anteriores: ela decifra o segredo com
   * `WEBHOOK_SECRET_KEY` e fala com a internet, e nada disso é assunto de
   * `jobs` — que continua sabendo enfileirar e nada mais. Obrigatória no tipo:
   * opcional, o primeiro worker novo esqueceria dela e o aviso ao sistema do
   * cliente pararia de sair sem nada ficar vermelho.
   */
  readonly entregarWebhook: (
    entregaId: string,
    agora: Date,
  ) => Promise<'entregue' | 'retentar' | 'desistiu' | 'sumiu'>;
  /** As entregas vencidas, para a varredura. Injetada pelo mesmo motivo. */
  readonly varrerWebhooks: (agora: Date) => Promise<readonly string[]>;
  /**
   * Poda o contador de vazão da API pública.
   *
   * `api_key_usage` é uma linha por chave e por minuto, e o teto do bloco 78 lê
   * só o minuto corrente — o passado fica na tabela para sempre. A função que a
   * limpa existia em `identity` desde então, com o comentário *"Roda na
   * varredura, como `login_attempts`"* e **nenhum chamador em todo o
   * repositório**. É o defeito de `varrerVitrine` do bloco 70 repetido:
   * varredura prometida num comentário tem chamador e tem teste, ou é
   * comentário.
   *
   * Obrigatória e não opcional, como as outras: opcional, ela nasce esquecida
   * no primeiro worker novo e a poda deixa de acontecer sem nada ficar vermelho.
   */
  readonly limparUsoDaApi: (antesDe: Date) => Promise<number>;
  /**
   * Refaz a vitrine do marketplace — preço e nota de cada card.
   *
   * Obrigatória no `Contexto` e não opcional, pelo motivo de sempre: opcional,
   * ela seria esquecida no primeiro worker novo e a varredura voltaria a não ter
   * chamador — que é exatamente o estado em que ela passou do bloco 70 ao 110,
   * com o cabeçalho da migração afirmando o contrário.
   */
  readonly varrerVitrine: (agora: Date) => Promise<number>;
  /**
   * A vitrine do marketplace refeita (bloco 70), injetada.
   *
   * Mesma razão da retenção: ela vive em `packages/platform`, que é camada de
   * cima, e `jobs` não pode conhecê-la sem inverter a seta.
   *
   * **Obrigatória no tipo.** Opcional, ela seria esquecida no primeiro worker
   * novo, e o card do marketplace passaria a mostrar preço e nota de meses atrás
   * sem nada ficar vermelho — que é exatamente o que a revisão deste bloco
   * apontou quando ela ainda não tinha chamador nenhum.
   */
  readonly atualizarVitrine: (tenantId: string, agora: Date) => Promise<number>;
  /**
   * A comissão do marketplace (bloco 72), injetada pela mesma razão.
   *
   * Ela mora em `packages/platform`, e não pode nascer no fechamento do
   * atendimento: `scheduling` precisaria da alíquota, que é de `platform`, e a
   * seta voltaria. Vem em duas partes porque são dois fatos — atribuir o
   * cliente novo, e cobrar o mês fechado.
   *
   * **Obrigatórias no tipo.** Opcionais, seriam esquecidas no primeiro worker
   * novo, e a plataforma pararia de faturar a própria comissão sem nada ficar
   * vermelho — o defeito que a revisão do bloco 70 apontou na vitrine.
   */
  readonly atribuirClientesNovos: (tenantId: string, agora: Date) => Promise<number>;
  readonly cobrarComissaoDoMarketplace: (tenantId: string, agora: Date) => Promise<void>;
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
  /**
   * Manda a nota ao emissor e devolve o estado que ele respondeu (bloco 53).
   *
   * Injetada pela razão de sempre: ela vive em `packages/finance`, que é camada
   * de cima, e `jobs` não pode conhecê-la sem inverter a seta. O que chega aqui
   * é a função pronta; quem a liga é `apps/worker`.
   *
   * **Obrigatória no tipo.** Opcional, ela seria esquecida no primeiro worker
   * novo e as notas ficariam paradas em `pendente` sem nada ficar vermelho — é o
   * mesmo critério de `varrerRetencao` e de `expirarEsperas`.
   */
  readonly processarNota: (tenantId: string, invoiceId: string) => Promise<EstadoDaNota>;
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
    if (!(await contexto.recursoLigado(tarefa.tenantId, 'avisos'))) return PULO_POR_RECURSO;
    await executarAvisoDeAgendamento({
      tenantId: tarefa.tenantId,
      appointmentId,
      tipo,
      provider: contexto.provider,
      agora: contexto.relogio.agora(),
    });
  };

export const HANDLERS: Readonly<Record<string, Handler>> = {
  /**
   * A nota vai ao emissor **fora** da transação que fechou a comanda.
   *
   * A prefeitura pode levar minutos e pode estar fora do ar, e o cliente está
   * esperando o troco: pendurá-la na frente do balcão é o defeito que a SPEC
   * §3.11 evita ao delegar a um emissor, e que o bloco 50 já aprendeu com o KYC.
   *
   * A tarefa **se reprograma** enquanto a nota não tem desfecho, como a
   * varredura de retorno do bloco 22. É por isso que não existe varredura de
   * plataforma para notas pendentes: `fiscal_invoices` tem RLS, e um processo
   * sem tenant no contexto enxergaria zero linhas — sempre.
   */
  /**
   * Entrega um webhook. Quem reprograma é a **varredura**, não esta tarefa.
   *
   * A nota fiscal se reprograma sozinha porque `fiscal_invoices` tem RLS e um
   * processo sem tenant enxergaria zero linhas. Aqui é o contrário:
   * `webhook_deliveries` é legível sem tenant de propósito, e `next_attempt_at`
   * já é a resposta para *"quando tentar de novo"*.
   *
   * Reprogramar aqui **também** seria a segunda noção do mesmo instante — e a
   * entrega cuja tarefa se perdesse entre a falha e a reprogramação ficaria
   * pendente para sempre, sem erro. Uma fonte só, e a varredura é a rede.
   */
  'webhook.entregar': async (tarefa, contexto) => {
    const entregaId = String(tarefa.payload['entregaId'] ?? '');
    if (!entregaId) throw new Error('tarefa de webhook sem entrega');
    await contexto.entregarWebhook(entregaId, contexto.relogio.agora());
  },

  'fiscal.emitir': async (tarefa, contexto) => {
    const invoiceId = String(tarefa.payload['invoiceId'] ?? '');
    if (!invoiceId) throw new Error('tarefa fiscal sem nota');

    const estado = await contexto.processarNota(tarefa.tenantId, invoiceId);
    if (!notaEmCurso(estado)) return;

    /**
     * Ainda na prefeitura: pergunta de novo daqui a pouco.
     *
     * Cinco minutos porque é a ordem de grandeza da resposta municipal — um
     * intervalo curto viraria dezenas de consultas por nota, e o emissor cobra
     * por chamada. A chave carrega a tentativa para a próxima não colidir com
     * esta.
     */
    const proxima = new Date(contexto.relogio.agora().getTime() + 5 * 60_000);
    await withTenant(tarefa.tenantId, async (tx) => {
      await enfileirar(tx, {
        kind: 'fiscal.emitir',
        payload: { invoiceId },
        rodarApos: proxima,
        idempotencyKey: `fiscal:${invoiceId}:${tarefa.attempts + 1}`,
      });
    });
  },

  /**
   * A nota autorizada chegando ao cliente (bloco 54).
   *
   * Uma tarefa por barbearia, por hora, porque `fiscal_invoices` tem RLS — a
   * mesma razão de `lgpd.retencao`. O que ela alcança e o `fiscal.emitir` não
   * alcança é a nota cuja tarefa se perdeu: aquela ficaria com o link gravado e
   * nunca sairia, sem erro e sem alerta.
   *
   * Quem decide se cada nota sai agora, mais tarde ou nunca é
   * `entregarNotas`, injetada — `jobs` não conhece `finance`, e é a mesma seta
   * de `varrerRetencao`.
   */
  /**
   * O cliente tocou um botão da mensagem (bloco 55).
   *
   * A tarefa nasce **dentro** da transação que grava a resposta, e o webhook
   * devolve 200 sem esperar: a Meta desiste da entrega se demorarmos, e
   * reentrega — o que faria o mesmo cancelamento chegar duas vezes.
   *
   * Quem mexe na agenda é `packages/scheduling`, pela função injetada. `jobs`
   * não sabe cancelar horário nenhum, e é o mesmo desenho de `varrerRetencao`.
   */
  'whatsapp.responder': async (tarefa, contexto) => {
    const inboundId = String(tarefa.payload['inboundId'] ?? '');
    if (!inboundId) throw new Error('resposta de WhatsApp sem id');
    await contexto.responderWhatsApp(tarefa.tenantId, inboundId, contexto.relogio.agora());
  },

  /**
   * Uma volta da automação para uma barbearia (bloco 56).
   *
   * Marca os disparos e manda o que já venceu. As duas coisas na mesma tarefa
   * porque são a mesma volta do relógio — separá-las criaria uma segunda cadeia
   * de agendamento para não fazer nada novo.
   */
  'automacao.varrer': async (tarefa, contexto) => {
    await contexto.rodarAutomacoes(tarefa.tenantId, contexto.relogio.agora());
  },

  /**
   * O que a Meta ainda não respondeu desta barbearia (bloco 90).
   *
   * O número que espera a prova de posse e os textos que esperam aprovação: a
   * mesma pergunta, o mesmo token, a mesma volta do relógio. Antes desta tarefa
   * as duas respostas nunca eram pedidas, e as duas telas mentiam em silêncio.
   */
  'whatsapp.conciliar': async (tarefa, contexto) => {
    await contexto.conciliarWhatsApp(tarefa.tenantId, contexto.relogio.agora());
  },

  /**
   * A ida à Meta que saiu do balcão (bloco 133).
   *
   * A tarefa nasce dentro da transação que reserva a linha e carrega **ids**:
   * `jobs` não tem RLS, e o texto que a barbearia escreveu é dela. O `claim`
   * viaja junto porque a entrega precisa provar que ainda é a dela — uma tarefa
   * atrasada, depois de a barbearia ter corrigido o texto, gravaria a resposta
   * da Meta sobre a reserva errada.
   *
   * Tarefa sem os dois é defeito de quem enfileirou, e lançar é o certo: sem
   * eles não há o que entregar, e engolir deixaria o texto em `sending` para
   * sempre, sem erro e sem alerta.
   */
  /**
   * A inscrição do app na WABA, fora da requisição (bloco 134).
   *
   * A tarefa nasce dentro da transação que grava o cadastro e carrega **o id da
   * unidade**: o token mora cifrado no banco, e `jobs` não tem RLS — pôr
   * credencial no `payload` seria um segredo em repouso legível sem tenant.
   */
  'whatsapp.assinar_waba': async (tarefa, contexto) => {
    const locationId = String(tarefa.payload['locationId'] ?? '');
    if (!locationId) throw new Error('tarefa de inscrição sem unidade');
    await contexto.assinarWaba(tarefa.tenantId, locationId);
  },

  'whatsapp.submeter_template': async (tarefa, contexto) => {
    const templateId = String(tarefa.payload['templateId'] ?? '');
    const claim = String(tarefa.payload['claim'] ?? '');
    if (!templateId || !claim) throw new Error('tarefa de template sem template ou sem claim');
    await contexto.entregarTemplate(tarefa.tenantId, templateId, claim);
  },

  /**
   * O despacho de uma campanha (bloco 82).
   *
   * A tarefa nasce dentro da transação que põe a campanha em `enviando`, e
   * carrega **o id** — o público é dado de cliente, e `jobs` não tem RLS.
   */
  'campanha.enviar': async (tarefa, contexto) => {
    const campanhaId = String(tarefa.payload['campanhaId'] ?? '');
    if (!campanhaId) throw new Error('tarefa de campanha sem campanha');
    await contexto.enviarCampanha(tarefa.tenantId, campanhaId, contexto.relogio.agora());
  },

  'fiscal.entregar': async (tarefa, contexto) => {
    await contexto.entregarNotas(tarefa.tenantId, contexto.relogio.agora());
  },

  /**
   * A rede para a nota cuja tarefa morreu (bloco 121).
   *
   * `fiscal.emitir` acompanha uma nota e se reprograma; esgotadas as tentativas
   * ele desiste, e nada mais olhava aquela linha. Separada de `fiscal.entregar`
   * porque são duas perguntas: uma é "esta nota já saiu da prefeitura?", a
   * outra é "esta nota autorizada já chegou ao cliente?".
   */
  'fiscal.conciliar': async (tarefa, contexto) => {
    await contexto.conciliarNotas(tarefa.tenantId);
  },

  'notificacao.confirmacao': avisoDeAgendamento('confirmacao'),
  'notificacao.lembrete_24h': avisoDeAgendamento('lembrete_24h'),
  'notificacao.lembrete_2h': avisoDeAgendamento('lembrete_2h'),

  'notificacao.sua_vez': async (tarefa, contexto) => {
    const queueEntryId = String(tarefa.payload['queueEntryId'] ?? '');
    if (!queueEntryId) throw new Error('tarefa de fila sem entrada');
    if (!(await contexto.recursoLigado(tarefa.tenantId, 'avisos'))) return PULO_POR_RECURSO;
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
    const ligado = await contexto.recursoLigado(tarefa.tenantId, 'avisos');
    if (ligado) {
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
    /**
     * O pulo vem **depois** de reprogramar, e a ordem é a decisão.
     *
     * Este é o único porteiro que não pode sair cedo: a varredura de retorno se
     * reprograma sozinha, e devolver antes mataria a corrente — religar o
     * recurso passaria a exigir que alguém lembrasse de reenfileirar a primeira.
     */
    if (!ligado) return PULO_POR_RECURSO;
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
     * A vitrine do marketplace é refeita na mesma volta (bloco 70).
     *
     * Preço, nota e clube mudam por caminhos que não conhecem a vitrine — um
     * serviço editado no catálogo, uma avaliação que completa 48 horas e entra
     * na média, um plano desativado. Chamar a atualização de dentro de cada um
     * espalharia a vitrine por cinco pacotes que não a conhecem, e o primeiro
     * caminho novo esqueceria dela.
     *
     * Aqui, e não numa tarefa própria, pela mesma razão da lista de espera: é a
     * mesma natureza — varredura diária, uma por barbearia, de madrugada.
     */
    await contexto.atualizarVitrine(tarefa.tenantId, contexto.relogio.agora());

    /**
     * A comissão do marketplace sai na mesma volta (bloco 72).
     *
     * Atribuir primeiro, cobrar depois, e nesta ordem: a emissão do mês fechado
     * precisa encontrar as linhas do último dia do mês já gravadas. Invertida,
     * o atendimento do dia 31 só seria cobrado no mês seguinte, e a barbearia
     * receberia uma fatura de agosto com um cliente de julho dentro.
     */
    await contexto.atribuirClientesNovos(tarefa.tenantId, contexto.relogio.agora());
    await contexto.cobrarComissaoDoMarketplace(tarefa.tenantId, contexto.relogio.agora());

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
    if (!(await contexto.recursoLigado(tarefa.tenantId, 'avisos'))) return PULO_POR_RECURSO;

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
    if (!(await contexto.recursoLigado(tarefa.tenantId, 'avisos'))) return PULO_POR_RECURSO;

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
    if (!(await contexto.recursoLigado(tarefa.tenantId, 'avisos'))) return PULO_POR_RECURSO;

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
  opcoes: {
    readonly lote?: number;
    readonly quem?: string;
    readonly aoEvento?: (evento: EventoDaTarefa) => void;
  } = {},
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
    const inicio = Date.now();
    const base = {
      tarefaId: tarefa.id,
      tenantId: tarefa.tenantId,
      kind: tarefa.kind,
      tentativa: tarefa.attempts,
      maxTentativas: tarefa.maxAttempts,
    } as const;
    opcoes.aoEvento?.({ fase: 'inicio', ...base });

    // A janela do reaper é 15 min. Renovar a cada 5 deixa margem para uma
    // rodada lenta do event loop sem permitir que um segundo worker execute a
    // mesma tarefa enquanto o primeiro ainda está falando com a rede.
    let heartbeatEmCurso = false;
    const heartbeat = setInterval(() => {
      if (heartbeatEmCurso) return;
      heartbeatEmCurso = true;
      void renovarTarefa(tarefa, contexto.relogio.agora()).catch(() => false).finally(() => {
        heartbeatEmCurso = false;
      });
    }, 5 * 60_000);
    heartbeat.unref?.();

    try {
      if (!handler) throw new Error(`tarefa sem handler: ${tarefa.kind}`);
      const desfechoDoHandler = await handler(tarefa, contexto);
      await concluirTarefa(tarefa);
      concluidas += 1;
      /**
       * Pulo é conclusão, não erro — e por isso a tarefa fecha do mesmo jeito.
       * O que muda é o evento: `pulada` com o motivo, em vez de `concluida`,
       * que dizia exatamente a mesma coisa de trabalho feito e de trabalho que
       * nem começou.
       */
      opcoes.aoEvento?.(
        ehPulo(desfechoDoHandler)
          ? { fase: 'pulada', ...base, duracaoMs: Date.now() - inicio, motivo: desfechoDoHandler.pulada }
          : { fase: 'concluida', ...base, duracaoMs: Date.now() - inicio },
      );
    } catch (erro) {
      const desfecho = await falharTarefa(
        tarefa,
        resumoPersistivelDoErro(erro),
        contexto.relogio.agora(),
      );
      const seguro = identificarErroDaTarefa(erro);
      if (desfecho === 'failed') falhadas += 1;
      else reagendadas += 1;
      opcoes.aoEvento?.({
        fase: desfecho === 'failed' ? 'falhou' : 'reagendada',
        ...base,
        duracaoMs: Date.now() - inicio,
        ...seguro,
      });
    } finally {
      clearInterval(heartbeat);
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
    readonly aoEvento?: (evento: EventoDaTarefa) => void;
    /** Falha de manutenção global: sanitizada e isolada do laço principal. */
    readonly aoErroGlobal?: (evento: {
      readonly operacao: string;
      readonly erroTipo: string;
      readonly erroCodigo?: string;
    }) => void;
  } = {},
): Promise<void> {
  const intervalo = opcoes.intervaloMs ?? 5_000;
  const parar = opcoes.parar ?? (() => false);

  // Uma integração externa indisponível não pode matar lembretes, agenda e
  // todas as outras filas. Falha global entra em backoff curto e o processo
  // continua; o marcador de periodicidade só avança depois do sucesso.
  const tentarDepoisDe = new Map<string, number>();
  // REPARO DA VALIDAÇÃO: o retorno é descartado (`await executar()`), e cinco
  // chamadores devolvem a contagem do que enfileiraram. `Promise<void>`
  // recusava todos eles.
  const executarGlobal = async (operacao: string, executar: () => Promise<unknown>): Promise<boolean> => {
    const agora = contexto.relogio.agora().getTime();
    if ((tentarDepoisDe.get(operacao) ?? 0) > agora) return false;
    try {
      await executar();
      tentarDepoisDe.delete(operacao);
      return true;
    } catch (erro) {
      tentarDepoisDe.set(operacao, agora + Math.max(intervalo, 60_000));
      const seguro = identificarErroDaTarefa(erro);
      opcoes.aoErroGlobal?.({ operacao, ...seguro });
      return false;
    }
  };
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
  let ultimaEntregaDeNotas: string | null = null;
  let ultimaConciliacaoDoWhatsApp: string | null = null;
  let ultimaAutomacao: string | null = null;
  let ultimaVarreduraGlobal: string | null = null;
  /** E a de alerta, que roda de manhã em vez de de madrugada. */
  let ultimoAlerta: string | null = null;
  /** E a da cobrança do clube, que roda de madrugada e fala com o adquirente. */
  let ultimoClube: string | null = null;

  while (!parar()) {
    await executarGlobal('fila.soltar_orfas', async () => {
      await soltarOrfas(15, contexto.relogio.agora());
    });

    const hoje = contexto.relogio.agora().toISOString().slice(0, 10);
    if (hoje !== ultimaRegua) {
      const ok = await executarGlobal('cobranca.regua', () => contexto.rodarRegua(contexto.relogio.agora()));
      if (ok) ultimaRegua = hoje;
    }

    // A apuração diária mora aqui, ao lado da varredura de órfãs, porque é a
    // outra coisa que o worker faz **sem** ser uma tarefa: alguém precisa
    // enfileirar a primeira, e uma barbearia criada hoje não estaria em
    // nenhuma corrente iniciada ontem.
    const pendente = apuracaoPendente(contexto.relogio.agora());
    if (pendente.dia !== ultimaApuracao) {
      const ok = await executarGlobal('metricas.agendar_apuracao', () => agendarApuracaoDeTodas(pendente));
      if (ok) ultimaApuracao = pendente.dia;
    }

    // A retenção mora ao lado da apuração pelo mesmo motivo: alguém precisa
    // enfileirar a primeira, e uma barbearia criada hoje não está em nenhuma
    // corrente iniciada ontem.
    const retencao = retencaoPendente(contexto.relogio.agora());
    if (retencao.dia !== ultimaRetencao) {
      const ok = await executarGlobal('lgpd.agendar_retencao', () => agendarRetencaoDeTodas(retencao));
      if (ok) ultimaRetencao = retencao.dia;
    }

    /**
     * A entrega da nota é de hora em hora, e não diária como as outras.
     *
     * É mensagem sobre uma venda que acabou de acontecer: quem corta às 10h não
     * recebe a nota no dia seguinte. O que segura o que cai de madrugada é a
     * janela de silêncio, decidida **por nota** com o fuso da unidade — o
     * horário do laço é UTC e valeria a mesma hora para Salvador e Rio Branco.
     */
    // A automação acompanha a entrega da nota: mesma cadência, mesma razão.
    if (entregaDeNotasPendente(contexto.relogio.agora()).hora !== ultimaAutomacao) {
      const automacao = entregaDeNotasPendente(contexto.relogio.agora());
      const ok = await executarGlobal('crm.agendar_automacao', () => agendarAutomacaoDeTodas(automacao));
      if (ok) ultimaAutomacao = automacao.hora;
    }

    const entrega = entregaDeNotasPendente(contexto.relogio.agora());
    if (
      cabeVoltaFiscal({
        emiteNotaFiscal: contexto.emiteNotaFiscal,
        hora: entrega.hora,
        ultima: ultimaEntregaDeNotas,
      })
    ) {
      const ok = await executarGlobal('fiscal.agendar_entrega_conciliacao', async () => {
        await agendarEntregaDeNotasDeTodas(entrega);
        // A conciliação na mesma cadência: a prefeitura responde em minutos ou
        // em horas, e uma volta de hora em hora é a ordem de grandeza certa.
        await agendarConciliacaoDeNotasDeTodas(entrega);
      });
      if (ok) ultimaEntregaDeNotas = entrega.hora;
    }

    /**
     * As duas varreduras que **não podem ser tarefa** (bloco 110).
     *
     * `jobs.tenant_id` é `NOT NULL` de propósito, e o comentário da migração 20
     * diz por quê: *"quem não tem tenant não tem o que fazer aqui"*. Uma
     * varredura global não tem dono, então não há linha de `jobs` que a
     * represente — e era exatamente por isso que ninguém enfileirava
     * `webhook.varrer`, que tinha tratador e nenhum produtor desde que nasceu.
     * O tratador saiu junto: guardar código que nada pode alcançar é a mesma
     * promessa vazia que a guarda do bloco 108 existe para pegar.
     *
     * Aqui elas ficam ao lado de `soltarOrfas` e da régua de cobrança, que são
     * as outras duas coisas que o worker faz **sem** ser uma tarefa.
     *
     * De hora em hora: a vitrine é cópia derivada com carimbo de defasagem, e
     * a entrega vencida é a rede que pega o que a tarefa perdeu. Nenhuma das
     * duas justifica correr a cada volta do laço.
     */
    if (entrega.hora !== ultimaVarreduraGlobal) {
      const agora = contexto.relogio.agora();
      const ok = await executarGlobal('integracoes.varredura_global', async () => {
        await contexto.varrerVitrine(agora);
        // Duas horas para trás, e não "o minuto anterior": o teto lê o minuto
        // corrente, então tudo antes disso é histórico — e a folga cobre o
        // relógio do banco andar diferente do relógio do processo.
        await contexto.limparUsoDaApi(new Date(agora.getTime() - 2 * 60 * 60 * 1000));
        for (const entregaId of await contexto.varrerWebhooks(agora)) {
          await contexto.entregarWebhook(entregaId, agora);
        }
      });
      if (ok) ultimaVarreduraGlobal = entrega.hora;
    }

    /**
     * A conciliação com a Meta acompanha a mesma cadência (bloco 90).
     *
     * De hora em hora e não diária: quem acabou de digitar o código do SMS no
     * painel da Meta está olhando a nossa tela esperando ela mudar, e um ciclo
     * diário faria "falta confirmar o número" durar até amanhã sobre um número
     * já confirmado. É o mesmo argumento da entrega da nota, que é a linha
     * acima.
     */
    if (entrega.hora !== ultimaConciliacaoDoWhatsApp) {
      const ok = await executarGlobal('whatsapp.agendar_conciliacao', () => agendarConciliacaoDoWhatsApp(entrega));
      if (ok) ultimaConciliacaoDoWhatsApp = entrega.hora;
    }

    const alerta = alertaPendente(contexto.relogio.agora());
    if (alerta.dia !== ultimoAlerta) {
      const ok = await executarGlobal('operacao.agendar_alertas', () => agendarAlertasDeTodas(alerta));
      if (ok) ultimoAlerta = alerta.dia;
    }

    // A cobrança do clube, pelo mesmo motivo das duas acima: alguém precisa
    // enfileirar a primeira. Ela é a única das três que fala com o adquirente,
    // e por isso roda de madrugada e sozinha na volta.
    const clube = cobrancaDoClubePendente(contexto.relogio.agora());
    if (clube.dia !== ultimoClube) {
      const ok = await executarGlobal('finance.agendar_clube_split', async () => {
        await agendarCobrancaDoClubeDeTodas(clube);
        // Na mesma volta: as duas falam com o adquirente, e é de madrugada que
        // isso não disputa rede com o balcão.
        await agendarLiquidacaoDeTodas(clube);
      });
      if (ok) ultimoClube = clube.dia;
    }

    let resultado: ResultadoDaRodada = { tomadas: 0, concluidas: 0, falhadas: 0, reagendadas: 0 };
    const rodadaOk = await executarGlobal('fila.rodada', async () => {
      // REPARO DA VALIDAÇÃO: com `exactOptionalPropertyTypes`, a chave presente
      // valendo `undefined` não é o mesmo que a chave ausente.
      resultado = await rodada(contexto, opcoes.aoEvento ? { aoEvento: opcoes.aoEvento } : {});
    });
    if (rodadaOk) opcoes.aoRodar?.(resultado);

    // Só dorme quando não havia nada: com fila cheia, a próxima volta é
    // imediata. Dormir sempre atrasaria o lembrete em até um intervalo por
    // tarefa, e a fila nunca alcançaria um pico.
    if (resultado.tomadas === 0 && !parar()) {
      await new Promise((resolve) => setTimeout(resolve, intervalo));
    }
  }
}
