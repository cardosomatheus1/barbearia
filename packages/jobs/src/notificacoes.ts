import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  chaveDaNotificacao,
  WhatsAppDeliveryUnknownError,
  decidirEnvioDeAgendamento,
  decidirRetorno,
  maskPhone,
  naturezaDe,
  TIPOS_DE_NOTIFICACAO,
  type MotivoDeNaoEnviar,
  type TipoDeNotificacao,
} from '@barbearia/core';
import { enfileirar, cancelarTarefas } from './fila.js';
import { chaveDaFalta } from './faltas.js';

/**
 * As notificações do agendamento.
 *
 * A regra de **quando** está em `packages/core`, pura. Aqui está o **como**:
 * ler o estado sob RLS, chamar o domínio, mandar pelo provedor e registrar.
 *
 * A decisão que atravessa o arquivo: **conferir de novo na hora de enviar**. A
 * tarefa foi criada ontem; entre lá e agora o cliente pode ter cancelado,
 * remarcado ou pedido para não receber. Cancelar a tarefa na hora do
 * cancelamento é a primeira defesa e resolve o caso comum; reconferir aqui é a
 * segunda, e é ela que cobre o cancelamento que aconteceu enquanto a tarefa já
 * estava sendo executada.
 */

/**
 * De quem é a mensagem, e por qual número ela pode sair (bloco 82).
 *
 * As duas coisas viajam juntas porque o canal da casa é **por unidade**: o
 * cadastro do WhatsApp, o token cifrado e os templates aprovados moram em
 * `whatsapp_settings`, com uma linha por `location_id`. Sem elas, o provedor
 * recebe uma mensagem pronta e não tem como descobrir por qual número mandá-la.
 *
 * Só as formas que carregam um `TipoDeNotificacao` estendem isto, e é o
 * critério certo: a Meta exige **um template aprovado por tipo**, e uma
 * mensagem sem tipo não tem template a escolher. Convite de vaga, recado,
 * aviso do clube e nota continuam pelo canal de reserva — não por esquecimento,
 * mas porque `notification_kind` não os nomeia.
 */
export interface DeQuem {
  readonly tenantId: string;
  readonly locationId: string;
}

export interface MensagemDeAgendamento extends DeQuem {
  readonly phoneE164: string;
  readonly tipo: TipoDeNotificacao;
  readonly clienteNome: string;
  readonly barbearia: string;
  readonly profissional: string;
  readonly quandoTexto: string;
}

export interface MensagemDeFila extends DeQuem {
  readonly phoneE164: string;
  readonly clienteNome: string;
  readonly barbearia: string;
  readonly posicao: number;
}

/**
 * O convite de vaga da lista de espera (bloco 39, SPEC §2.9).
 *
 * Transacional, não promocional: é resposta a um pedido explícito da pessoa —
 * "me avise se surgir uma vaga". Por isso não olha o consentimento de
 * marketing, exatamente como o lembrete de horário.
 *
 * O `link` carrega o token em claro, e é a única vez que ele existe fora da
 * cabeça de quem o gerou. Ele **não** é gravado: `notifications` guarda que a
 * mensagem saiu, nunca o conteúdo dela.
 */
export interface MensagemDeVaga {
  readonly phoneE164: string;
  readonly clienteNome: string;
  readonly barbearia: string;
  readonly profissional: string;
  readonly quandoTexto: string;
  readonly minutosParaResponder: number;
  readonly link: string;
}

/**
 * A resposta a um recado do cliente (bloco 40).
 *
 * Transacional pelo motivo mais direto que existe: a pessoa escreveu para a
 * barbearia e está esperando resposta. Não olha consentimento de marketing —
 * seria pedir autorização para responder uma pergunta.
 *
 * O texto da resposta viaja aqui e **não** é gravado em `notifications`: a
 * conversa entre o cliente e a casa mora em `feedbacks`, sob RLS, e repeti-la
 * no registro de envio multiplicaria a superfície sem responder nada.
 */
export interface MensagemDeRecado {
  readonly phoneE164: string;
  readonly clienteNome: string;
  readonly barbearia: string;
  readonly resposta: string;
}

/**
 * O provedor, estendido para além do OTP.
 *
 * Continua abstração pelo mesmo motivo do bloco 4: o WhatsApp oficial exige
 * número verificado e template aprovado — bloqueio de fornecedor, não de
 * código. O `fake` é o que roda em teste e em desenvolvimento, e é o que
 * permite provar as regras de silêncio e de teto sem rede.
 *
 * A senha de primeiro acesso **não** está aqui, e é decisão, não esquecimento:
 * ela sai inline por `MessagingProvider` em `packages/identity`, porque a fila é
 * durável e guardar credencial viva num `payload` é criar segredo em repouso.
 */
/**
 * O aviso do clube: cobrança recusada, atraso, pausa, cartão vencendo (bloco 47).
 *
 * `texto` já vem pronto de `packages/core` — é a mesma frase que a tela do
 * cliente e a lista do balcão leem, e três textos para o mesmo fato é como o
 * treinamento vira folclore. `motivo` viaja ao lado porque o WhatsApp oficial
 * exige **um template aprovado por tipo de mensagem**, e é por ele que a
 * implementação de verdade escolhe qual usar.
 */
export interface MensagemDoClube {
  readonly phoneE164: string;
  readonly barbearia: string;
  readonly motivo: string;
  readonly texto: string;
}

/**
 * A nota fiscal chegando ao cliente (bloco 54).
 *
 * `link` é o documento na prefeitura, e é o conteúdo inteiro da mensagem: não
 * existe "sua nota está pronta" sem o link, porque a única coisa que a pessoa
 * faz com esse aviso é abrir o PDF. `numero` viaja ao lado porque é o que o
 * contador do cliente pede, e porque o WhatsApp oficial exige um template
 * aprovado por tipo de mensagem — com o número como variável, não no corpo.
 */
export interface MensagemDeNota {
  readonly phoneE164: string;
  readonly barbearia: string;
  readonly numero: string | null;
  readonly link: string;
}

/**
 * A mensagem de automação (bloco 56).
 *
 * Contrato próprio e não `MensagemDeAgendamento`, porque ela **não é sobre um
 * agendamento**: "sentimos sua falta" e "parabéns" não têm profissional nem
 * horário, e reusar aquela forma obrigaria a inventar os dois. Campo inventado
 * é o que vira texto errado na mensagem — e texto errado sobre horário é o que
 * faz o cliente parar de ler os próximos.
 *
 * `tipo` viaja porque o WhatsApp oficial exige **um template aprovado por tipo
 * de mensagem**, e é por ele que a implementação de verdade escolhe qual usar.
 */
export interface MensagemDeAutomacao extends DeQuem {
  readonly phoneE164: string;
  readonly clienteNome: string;
  readonly barbearia: string;
  readonly tipo: TipoDeNotificacao;
  /**
   * Qual texto a automação escolheu (bloco 94).
   *
   * Nulo é automação anterior ao bloco, que resolve por tipo como antes. Sem
   * este campo, as onze automações possíveis saíam todas com a mesma frase —
   * o motor pegava o único aprovado do tipo, e os gatilhos existem justamente
   * porque as situações são diferentes.
   */
  readonly templateId?: string | null;
}

/**
 * A mensagem de uma campanha.
 *
 * Tem a mesma forma da automação — e é um tipo próprio de propósito. As duas
 * são promocionais e passam pelas mesmas travas, mas quem as decide é
 * diferente: a automação dispara sozinha quando um fato acontece, a campanha é
 * o dono escolhendo um público hoje. Reaproveitar `enviarDeAutomacao` faria o
 * provedor de verdade — que escolhe o **template aprovado na Meta** pelo método
 * chamado — mandar campanha com o texto da automação.
 */
export interface MensagemDeCampanha extends DeQuem {
  readonly phoneE164: string;
  readonly clienteNome: string;
  readonly barbearia: string;
  readonly tipo: TipoDeNotificacao;
  /**
   * Qual texto esta campanha manda (bloco 96).
   *
   * A automação ganhou este campo no bloco 94 e a campanha ficou para trás,
   * ainda resolvendo por tipo — e o motor pega o primeiro aprovado daquele tipo
   * com `LIMIT 1`. Com três convites de retorno cadastrados, a campanha da
   * célula fria saía com "seu pacote está acabando" para quem nunca comprou
   * pacote: a tela mostrava a prévia de um texto e o motor mandava outro.
   *
   * Nulo é campanha anterior ao bloco, que resolve por tipo como antes.
   */
  readonly templateId?: string | null;
}

export interface NotificationProvider {
  enviarDeAgendamento(mensagem: MensagemDeAgendamento): Promise<void>;
  enviarDeFila(mensagem: MensagemDeFila): Promise<void>;
  enviarDeVaga(mensagem: MensagemDeVaga): Promise<void>;
  enviarDeRecado(mensagem: MensagemDeRecado): Promise<void>;
  enviarDoClube(mensagem: MensagemDoClube): Promise<void>;
  enviarDeNota(mensagem: MensagemDeNota): Promise<void>;
  enviarDeAutomacao(mensagem: MensagemDeAutomacao): Promise<void>;
  /**
   * Devolve o `wamid` quando a mensagem saiu pela Meta, `null` pelo reserva.
   *
   * Só esta forma devolve algo, e é assimetria de propósito: é a campanha que
   * precisa ligar cada alvo ao webhook de entrega, porque a tela dela promete
   * "entregues" e "lidos". Os outros avisos gravam o próprio envio em
   * `notifications` e não têm coluna esperando por id nenhum.
   */
  enviarDeCampanha(mensagem: MensagemDeCampanha): Promise<string | null>;
}

export class FakeNotificationProvider implements NotificationProvider {
  readonly agendamentos: MensagemDeAgendamento[] = [];
  readonly filas: MensagemDeFila[] = [];
  readonly vagas: MensagemDeVaga[] = [];
  readonly recados: MensagemDeRecado[] = [];
  readonly avisosDoClube: MensagemDoClube[] = [];
  readonly notas: MensagemDeNota[] = [];
  readonly automacoes: MensagemDeAutomacao[] = [];
  readonly campanhas: MensagemDeCampanha[] = [];
  /** Para provar o caminho de falha sem depender de rede fora do ar. */
  falharProxima = false;

  async enviarDeAgendamento(mensagem: MensagemDeAgendamento): Promise<void> {
    this.derrubarSePedido();
    this.agendamentos.push(mensagem);
  }

  async enviarDeFila(mensagem: MensagemDeFila): Promise<void> {
    this.derrubarSePedido();
    this.filas.push(mensagem);
  }

  async enviarDeVaga(mensagem: MensagemDeVaga): Promise<void> {
    this.derrubarSePedido();
    this.vagas.push(mensagem);
  }

  async enviarDeRecado(mensagem: MensagemDeRecado): Promise<void> {
    this.derrubarSePedido();
    this.recados.push(mensagem);
  }

  async enviarDoClube(mensagem: MensagemDoClube): Promise<void> {
    this.derrubarSePedido();
    this.avisosDoClube.push(mensagem);
  }

  async enviarDeNota(mensagem: MensagemDeNota): Promise<void> {
    this.derrubarSePedido();
    this.notas.push(mensagem);
  }

  async enviarDeAutomacao(mensagem: MensagemDeAutomacao): Promise<void> {
    this.derrubarSePedido();
    this.automacoes.push(mensagem);
  }

  async enviarDeCampanha(mensagem: MensagemDeCampanha): Promise<string | null> {
    this.derrubarSePedido();
    this.campanhas.push(mensagem);
    return null;
  }

  private derrubarSePedido(): void {
    if (this.falharProxima) {
      this.falharProxima = false;
      throw new Error('provedor indisponível');
    }
  }

  clear(): void {
    this.agendamentos.length = 0;
    this.filas.length = 0;
    this.vagas.length = 0;
    this.recados.length = 0;
    this.avisosDoClube.length = 0;
    this.notas.length = 0;
    this.automacoes.length = 0;
    // Faltava, e o que ela esconde é um teste passando pelo motivo errado: a
    // campanha do caso anterior continuava na lista que o caso seguinte lê.
    this.campanhas.length = 0;
  }
}

/**
 * Provedor de desenvolvimento: escreve no log o que teria mandado.
 *
 * O telefone sai mascarado, como no `ConsoleMessagingProvider` do OTP. O texto
 * da mensagem não é segredo, mas o número é dado pessoal, e log costuma ir para
 * lugares que a política de dado pessoal não cobre.
 */
export class ConsoleNotificationProvider implements NotificationProvider {
  constructor(private readonly log: (message: string) => void = console.log) {}

  private assegurarDesenvolvimento(): void {
    // Console é instrumento de desenvolvimento, não canal de entrega. Em
    // produção, tratá-lo como sucesso faria `notifications.status='sent'`
    // afirmar ao dono que o cliente foi avisado quando só houve uma linha de log.
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('notification_console_forbidden_in_production');
    }
  }

  async enviarDeAgendamento(mensagem: MensagemDeAgendamento): Promise<void> {
    this.assegurarDesenvolvimento();
    this.log(
      `[aviso] ${mensagem.tipo} para ${maskPhone(mensagem.phoneE164)} ` +
        `(${mensagem.barbearia}${mensagem.quandoTexto ? `, ${mensagem.quandoTexto}` : ''})`,
    );
  }

  async enviarDeFila(mensagem: MensagemDeFila): Promise<void> {
    this.assegurarDesenvolvimento();
    this.log(
      `[aviso] sua_vez para ${maskPhone(mensagem.phoneE164)} ` +
        `(${mensagem.barbearia}, posição ${mensagem.posicao})`,
    );
  }

  /**
   * O link **inteiro** vai para o log, e só aqui.
   *
   * Este provedor é de desenvolvimento: sem o link, não há como abrir a tela de
   * aceite numa máquina local, e o caminho inteiro do bloco 39 ficaria sem
   * jeito de exercitar. O provedor de verdade não escreve token em log nenhum —
   * ele o entrega na mensagem e esquece.
   */
  async enviarDeVaga(mensagem: MensagemDeVaga): Promise<void> {
    this.assegurarDesenvolvimento();
    this.log(
      `[aviso] vaga_liberada para ${maskPhone(mensagem.phoneE164)} ` +
        `(${mensagem.barbearia}, ${mensagem.quandoTexto}, ` +
        `${mensagem.minutosParaResponder} min) ${mensagem.link}`,
    );
  }

  /**
   * O texto da resposta **não** vai para o log, ao contrário do link da vaga.
   *
   * O link é credencial e está aqui por necessidade — sem ele não há como
   * exercitar o aceite numa máquina local. A resposta a uma reclamação é
   * conteúdo de conversa entre o cliente e a casa, e não há nada a exercitar
   * com ela impressa.
   */
  async enviarDeRecado(mensagem: MensagemDeRecado): Promise<void> {
    this.assegurarDesenvolvimento();
    this.log(
      `[aviso] resposta_recado para ${maskPhone(mensagem.phoneE164)} ` +
        `(${mensagem.barbearia}, ${mensagem.resposta.length} caracteres)`,
    );
  }

  async enviarDoClube(mensagem: MensagemDoClube): Promise<void> {
    this.assegurarDesenvolvimento();
    this.log(
      `[aviso] clube_${mensagem.motivo} para ${maskPhone(mensagem.phoneE164)} ` +
        `(${mensagem.barbearia})`,
    );
  }

  /**
   * O link da nota **não** vai para o log, ao contrário do link da vaga.
   *
   * O da vaga é credencial e está lá por necessidade: sem ele não há como
   * exercitar o aceite numa máquina local. O da nota é um documento público na
   * prefeitura, e o que ele identifica é uma pessoa e o que ela comprou — o log
   * costuma ir para lugares que a política de dado pessoal não cobre.
   */
  async enviarDeNota(mensagem: MensagemDeNota): Promise<void> {
    this.assegurarDesenvolvimento();
    this.log(
      `[aviso] nota_fiscal para ${maskPhone(mensagem.phoneE164)} ` +
        `(${mensagem.barbearia}${mensagem.numero ? `, nota ${mensagem.numero}` : ''})`,
    );
  }

  async enviarDeAutomacao(mensagem: MensagemDeAutomacao): Promise<void> {
    this.assegurarDesenvolvimento();
    this.log(
      `[aviso] automacao_${mensagem.tipo} para ${maskPhone(mensagem.phoneE164)} ` +
        `(${mensagem.barbearia})`,
    );
  }

  /** Quem recebeu é dado de cliente; o log fica com a contagem e o tipo. */
  async enviarDeCampanha(mensagem: MensagemDeCampanha): Promise<string | null> {
    this.assegurarDesenvolvimento();
    this.log(
      `[aviso] campanha_${mensagem.tipo} para ${maskPhone(mensagem.phoneE164)} ` +
        `(${mensagem.barbearia})`,
    );
    // O canal de reserva não tem id de mensagem, e inventar um faria a tela
    // contar como "entregue" o que a Meta nunca viu.
    return null;
  }
}

/** Os avisos que nascem de um agendamento novo. */
const DO_AGENDAMENTO = ['confirmacao', 'lembrete_24h', 'lembrete_2h'] as const;

/**
 * Só o que a fila de trabalho executa.
 *
 * `senha_de_acesso` é tipo de notificação e não é tarefa: ela sai inline, e
 * mapeá-la aqui daria a entender que existe um handler esperando por ela.
 */
const TAREFA_DE: Readonly<Record<(typeof DO_AGENDAMENTO)[number] | 'sua_vez', string>> = {
  confirmacao: 'notificacao.confirmacao',
  lembrete_24h: 'notificacao.lembrete_24h',
  lembrete_2h: 'notificacao.lembrete_2h',
  sua_vez: 'notificacao.sua_vez',
};

/**
 * Enfileira os avisos de um agendamento, **dentro da transação que o cria**.
 *
 * Fora dela existiria a janela em que o corte está marcado e nenhum lembrete
 * foi programado — e o defeito só apareceria no dia seguinte, como uma falta
 * que o lembrete existia para evitar.
 *
 * O `run_after` de cada um sai do domínio, já com a janela de silêncio
 * aplicada. Quem decide *se* vale a pena enviar é o handler, na hora — aqui só
 * se decide *quando* olhar de novo.
 */
export async function agendarAvisosDoAgendamento(
  tx: TransactionClient,
  params: {
    readonly appointmentId: string;
    readonly comecaEm: Date;
    readonly timeZone: string;
    readonly agora: Date;
    readonly ligados: Readonly<Record<TipoDeNotificacao, boolean>>;
  },
): Promise<number> {
  let criados = 0;

  for (const tipo of DO_AGENDAMENTO) {
    if (!params.ligados[tipo]) continue;

    const decisao = decidirEnvioDeAgendamento({
      tipo,
      comecaEm: params.comecaEm,
      timeZone: params.timeZone,
      agora: params.agora,
      temTelefone: true,
      aindaVale: true,
      jaEnviada: false,
    });
    if (!decisao.enviar || !decisao.quando) continue;

    await enfileirar(tx, {
      kind: TAREFA_DE[tipo],
      payload: { appointmentId: params.appointmentId },
      rodarApos: decisao.quando,
      idempotencyKey: chaveDaNotificacao(tipo, params.appointmentId),
    });
    criados += 1;
  }

  return criados;
}

/**
 * Enfileira o "você é o próximo" de uma entrada da fila.
 *
 * A chave é da **entrada**, não do momento: quem passa a ser o primeiro, é
 * chamado e volta a esperar não recebe três mensagens. Uma por visita, e o
 * índice único é quem garante.
 *
 * Sem `rodarApos`: o aviso da fila é o único do bloco que não é agendamento — a
 * pessoa está a três minutos de distância e um lembrete adiantado não existe.
 */
export async function agendarAvisoDeFila(
  tx: TransactionClient,
  queueEntryId: string,
): Promise<void> {
  await enfileirar(tx, {
    kind: TAREFA_DE.sua_vez,
    payload: { queueEntryId },
    idempotencyKey: chaveDaNotificacao('sua_vez', queueEntryId),
  });
}

/**
 * Cancela tudo o que ainda não saiu para um agendamento.
 *
 * Chamado ao cancelar e ao remarcar. No remarcar, os novos são enfileirados em
 * seguida com as chaves recalculadas — sem apagar antes, o cliente receberia o
 * lembrete do horário antigo, que é pior do que não receber nenhum.
 *
 * A falta entra na mesma lista, e não é detalhe: ela é a única tarefa daqui que
 * **escreve** no agendamento. Deixá-la pendente depois de um remarcar mandaria o
 * worker olhar o horário antigo — que agora está `rescheduled` e por isso
 * sobrevive ao `WHERE` de status, mas por sorte, não por desenho.
 */
export async function cancelarTarefasDoAgendamento(
  tx: TransactionClient,
  appointmentId: string,
): Promise<number> {
  return cancelarTarefas(tx, {
    chaves: [
      ...TIPOS_DE_NOTIFICACAO.map((tipo) => chaveDaNotificacao(tipo, appointmentId)),
      chaveDaFalta(appointmentId),
    ],
  });
}

interface EstadoDoAviso {
  starts_at: Date;
  status: string;
  timezone: string;
  location_id: string;
  customer_id: string | null;
  customer_name: string | null;
  phone: string | null;
  accepts_marketing: boolean;
  professional_name: string;
  tenant_name: string;
  ja_enviada: boolean;
}

/** Status que desligam o lembrete: o corte não vai acontecer como marcado. */
const TERMINAIS: ReadonlySet<string> = new Set([
  'cancelled_customer',
  'cancelled_business',
  'no_show',
  'rescheduled',
]);


type EstadoDaIntencaoDeEnvio = 'sending' | 'uncertain' | 'sent';

/**
 * Reserva uma intenção **antes** da rede.
 *
 * `notifications` é histórico do desfecho; não pode ser a trava porque só
 * nasce depois que o provider retorna. Uma linha `sending` que ficou para trás
 * após crash também é conservadoramente considerada ambígua: sem idempotência
 * oferecida pela Meta, retentá-la poderia duplicar uma mensagem que já saiu.
 */
async function reivindicarIntencaoDeEnvio(
  tx: TransactionClient,
  intentKey: string,
): Promise<{ readonly nossa: boolean; readonly status: EstadoDaIntencaoDeEnvio }> {
  const novas = await tx.$queryRaw<{ status: EstadoDaIntencaoDeEnvio }[]>`
    INSERT INTO notification_send_intents (tenant_id, intent_key, status)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${intentKey}, 'sending'
    )
    ON CONFLICT (tenant_id, intent_key) DO NOTHING
    RETURNING status
  `;
  if (novas[0]) return { nossa: true, status: novas[0].status };

  const existentes = await tx.$queryRaw<{ status: EstadoDaIntencaoDeEnvio }[]>`
    SELECT status
      FROM notification_send_intents
     WHERE intent_key = ${intentKey}
  `;
  return { nossa: false, status: existentes[0]?.status ?? 'uncertain' };
}

async function finalizarIntencaoDeEnvio(
  tx: TransactionClient,
  intentKey: string,
  status: 'uncertain' | 'sent',
): Promise<void> {
  await tx.$executeRaw`
    UPDATE notification_send_intents
       SET status = ${status}, updated_at = now()
     WHERE intent_key = ${intentKey}
  `;
}

/** Falha **definitiva** libera a intenção para a fila tentar de novo. */
async function liberarIntencaoDeEnvio(tx: TransactionClient, intentKey: string): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM notification_send_intents
     WHERE intent_key = ${intentKey} AND status = 'sending'
  `;
}

/**
 * Executa um aviso de agendamento.
 *
 * Devolve o que aconteceu para que o worker registre — inclusive quando **não**
 * enviou. "Nada foi enviado" sem motivo transforma toda pergunta do dono numa
 * investigação; com motivo, ela vira uma linha na tela.
 */
export async function executarAvisoDeAgendamento(params: {
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly tipo: TipoDeNotificacao;
  readonly provider: NotificationProvider;
  readonly agora: Date;
}): Promise<{ readonly enviado: boolean; readonly motivo: MotivoDeNaoEnviar | null }> {
  const intentKey = chaveDaNotificacao(params.tipo, params.appointmentId);
  const preparo = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<EstadoDoAviso[]>`
      SELECT a.starts_at, a.status::text AS status, l.timezone, a.location_id,
             a.customer_id, c.name AS customer_name, c.phone_e164 AS phone,
             c.accepts_marketing,
             p.name AS professional_name, t.name AS tenant_name,
             EXISTS (
               SELECT 1 FROM notifications n
                WHERE n.appointment_id = a.id
                  AND n.kind = ${params.tipo}::notification_kind
                  AND n.status = 'sent'
             ) AS ja_enviada
        FROM appointments a
        JOIN locations l ON l.id = a.location_id
        JOIN professionals p ON p.id = a.professional_id
        JOIN tenants t ON t.id = a.tenant_id
        LEFT JOIN customers c ON c.id = a.customer_id
       WHERE a.id = ${params.appointmentId}::uuid
    `;

    const estado = linhas[0];
    if (!estado) return { pronto: await registrar(tx, params, null, 'cancelado') } as const;

    const decisao = decidirEnvioDeAgendamento({
      tipo: params.tipo,
      comecaEm: estado.starts_at,
      timeZone: estado.timezone,
      agora: params.agora,
      temTelefone: Boolean(estado.phone),
      aindaVale: !TERMINAIS.has(estado.status),
      jaEnviada: estado.ja_enviada,
      aceitaPromocional: estado.accepts_marketing,
    });
    if (!decisao.enviar) return { pronto: await registrar(tx, params, estado, decisao.motivo) } as const;

    const intencao = await reivindicarIntencaoDeEnvio(tx, intentKey);
    if (!intencao.nossa) {
      return {
        pronto: {
          enviado: false,
          motivo: intencao.status === 'sent' ? 'ja_enviada' : 'entrega_incerta',
        },
      } as const;
    }
    return { estado } as const;
  });

  if ('pronto' in preparo) return preparo.pronto;
  const estado = preparo.estado;

  try {
    await params.provider.enviarDeAgendamento({
      tenantId: params.tenantId,
      locationId: estado.location_id,
      phoneE164: estado.phone ?? '',
      tipo: params.tipo,
      clienteNome: estado.customer_name ?? 'cliente',
      barbearia: estado.tenant_name,
      profissional: estado.professional_name,
      quandoTexto: horaLocal(estado.starts_at, estado.timezone),
    });
  } catch (erro) {
    if (erro instanceof WhatsAppDeliveryUnknownError) {
      return withTenant(params.tenantId, async (tx) => {
        await finalizarIntencaoDeEnvio(tx, intentKey, 'uncertain');
        return registrar(tx, params, estado, 'entrega_incerta');
      });
    }
    await withTenant(params.tenantId, (tx) => liberarIntencaoDeEnvio(tx, intentKey));
    throw erro;
  }

  return withTenant(params.tenantId, async (tx) => {
    await finalizarIntencaoDeEnvio(tx, intentKey, 'sent');
    return registrar(tx, params, estado, null);
  });
}

/**
 * Grava o que aconteceu — enviado ou não.
 *
 * Na mesma transação da leitura, e **depois** do envio: registrar antes faria o
 * sistema afirmar que avisou quando o provedor recusou. A ordem inversa é pior
 * do que parece, porque o registro é o que o `jaEnviada` consulta.
 */
async function registrar(
  tx: TransactionClient,
  params: { readonly appointmentId: string; readonly tipo: TipoDeNotificacao },
  estado: EstadoDoAviso | null,
  motivo: MotivoDeNaoEnviar | null,
): Promise<{ enviado: boolean; motivo: MotivoDeNaoEnviar | null }> {
  const enviado = motivo === null;
  // Já enviada não vira segunda linha: ela poluiria o teto mensal e a contagem
  // de "quantas vezes avisamos este cliente".
  if (motivo === 'ja_enviada') return { enviado: false, motivo };

  await tx.$executeRaw`
    INSERT INTO notifications
      (tenant_id, kind, customer_id, appointment_id, status, reason, phone_masked)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${params.tipo}::notification_kind,
      ${estado?.customer_id ?? null}::uuid,
      ${params.appointmentId}::uuid,
      -- entrega_incerta grava failed, como os caminhos de sua_vez e de retorno
      -- ja fazem: a mensagem pode ter saido e nao vamos repetir, e skipped diria
      -- que a casa decidiu nao mandar, que e outra coisa e a que a recepcao le
      -- como "entao mando eu". Sem crase: ela fecharia o template.
      ${enviado ? 'sent' : motivo === 'entrega_incerta' ? 'failed' : 'skipped'}::notification_status,
      ${motivo},
      ${estado?.phone ? maskPhone(estado.phone) : null}
    )
  `;

  return { enviado, motivo };
}

/** "quinta, 11 de setembro às 15:00" — o texto que o cliente lê. */
function horaLocal(instante: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(instante);
}

/**
 * "Você é o próximo" — a lacuna aberta desde o bloco 14.
 *
 * A posição e a estimativa existiam, com link próprio por pessoa. O que faltava
 * era o empurrão: quem sai para dar uma volta não recarrega a página, e a SPEC
 * §2.10 pede a mensagem **entregue**, não só exibida.
 */
export async function executarAvisoDeFila(params: {
  readonly tenantId: string;
  readonly queueEntryId: string;
  readonly provider: NotificationProvider;
}): Promise<{ readonly enviado: boolean; readonly motivo: MotivoDeNaoEnviar | null }> {
  const intentKey = chaveDaNotificacao('sua_vez', params.queueEntryId);
  const preparo = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        status: string;
        customer_id: string;
        customer_name: string;
        phone: string | null;
        tenant_name: string;
        posicao: bigint;
        ja_enviada: boolean;
        location_id: string;
      }[]
    >`
      SELECT q.status::text AS status, q.customer_id, c.name AS customer_name, q.location_id,
             c.phone_e164 AS phone, t.name AS tenant_name,
             (
               SELECT count(*) + 1 FROM queue_entries anterior
                WHERE anterior.location_id = q.location_id
                  AND anterior.status = 'waiting'
                  AND anterior.created_at < q.created_at
             )::bigint AS posicao,
             EXISTS (
               SELECT 1 FROM notifications n
                WHERE n.customer_id = q.customer_id
                  AND n.kind = 'sua_vez'
                  AND n.sent_at > q.created_at
                  AND n.status = 'sent'
             ) AS ja_enviada
        FROM queue_entries q
        JOIN tenants t ON t.id = q.tenant_id
        JOIN customers c ON c.id = q.customer_id
       WHERE q.id = ${params.queueEntryId}::uuid
    `;

    const entrada = linhas[0];
    if (!entrada) return { pronto: { enviado: false, motivo: 'cancelado' as const } };
    if (entrada.ja_enviada) return { pronto: { enviado: false, motivo: 'ja_enviada' as const } };
    const telefone = entrada.phone;
    if (!telefone) return { pronto: { enviado: false, motivo: 'sem_telefone' as const } };
    if (entrada.status !== 'waiting' && entrada.status !== 'called') {
      return { pronto: { enviado: false, motivo: 'cancelado' as const } };
    }

    const intencao = await reivindicarIntencaoDeEnvio(tx, intentKey);
    if (!intencao.nossa) {
      return {
        pronto: {
          enviado: false,
          motivo: intencao.status === 'sent' ? ('ja_enviada' as const) : ('entrega_incerta' as const),
        },
      };
    }
    return { entrada: { ...entrada, phone: telefone } };
  });

  if ('pronto' in preparo) return preparo.pronto;
  const entrada = preparo.entrada;

  try {
    await params.provider.enviarDeFila({
      tenantId: params.tenantId,
      locationId: entrada.location_id,
      phoneE164: entrada.phone,
      clienteNome: entrada.customer_name,
      barbearia: entrada.tenant_name,
      posicao: Number(entrada.posicao),
    });
  } catch (erro) {
    if (erro instanceof WhatsAppDeliveryUnknownError) {
      return withTenant(params.tenantId, async (tx) => {
        await finalizarIntencaoDeEnvio(tx, intentKey, 'uncertain');
        await tx.$executeRaw`
          INSERT INTO notifications (tenant_id, kind, customer_id, status, reason, phone_masked)
          VALUES (
            NULLIF(current_setting('app.tenant_id', true), '')::uuid,
            'sua_vez', ${entrada.customer_id}::uuid, 'failed', 'entrega_incerta', ${maskPhone(entrada.phone)}
          )
        `;
        return { enviado: false, motivo: 'entrega_incerta' as const };
      });
    }
    await withTenant(params.tenantId, (tx) => liberarIntencaoDeEnvio(tx, intentKey));
    throw erro;
  }

  return withTenant(params.tenantId, async (tx) => {
    await finalizarIntencaoDeEnvio(tx, intentKey, 'sent');
    await tx.$executeRaw`
      INSERT INTO notifications (tenant_id, kind, customer_id, status, phone_masked)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        'sua_vez', ${entrada.customer_id}::uuid, 'sent', ${maskPhone(entrada.phone)}
      )
    `;
    return { enviado: true, motivo: null };
  });
}

/**
 * A mensagem de retorno, varrida periodicamente.
 *
 * Diferente das outras: não nasce de um evento, e sim de uma **ausência**. Por
 * isso é uma varredura, e por isso ela é a única que precisa do teto mensal e
 * do opt-out — é a única promocional do bloco.
 */
export async function varrerRetornos(params: {
  readonly tenantId: string;
  readonly provider: NotificationProvider;
  readonly agora: Date;
  readonly limite?: number;
}): Promise<{ readonly enviados: number }> {
  const limite = Math.min(Math.max(1, params.limite ?? 50), 200);

  /**
   * Só a leitura dos candidatos fica dentro da transação. A chamada à Meta
   * **nunca** segura a conexão/lock do banco — além de desperdiçar pool, uma
   * demora de rede transformava a varredura promocional numa transação longa.
   */
  const linhas = await withTenant(params.tenantId, (tx) =>
    tx.$queryRaw<
      {
        customer_id: string;
        customer_name: string;
        phone: string;
        accepts_marketing: boolean;
        tenant_name: string;
        timezone: string;
        comeback_after_days: number;
        ultima_visita: Date | null;
        promocionais_no_mes: bigint;
        ja_enviada: boolean;
        location_id: string;
      }[]
    >`
      SELECT c.id AS customer_id, c.name AS customer_name, c.phone_e164 AS phone,
             c.accepts_marketing, t.name AS tenant_name,
             l.timezone, l.comeback_after_days, l.location_id,
             (SELECT max(a.starts_at) FROM appointments a
               WHERE a.customer_id = c.id AND a.status = 'completed') AS ultima_visita,
             (SELECT count(*) FROM notifications n
               WHERE n.customer_id = c.id AND n.kind = 'retorno'
                 AND (n.status = 'sent' OR n.reason = 'entrega_incerta')
                 AND n.sent_at > ${params.agora} - interval '30 days')::bigint
               AS promocionais_no_mes,
             EXISTS (
               SELECT 1 FROM notifications n
                WHERE n.customer_id = c.id AND n.kind = 'retorno'
                  AND (n.status = 'sent' OR n.reason = 'entrega_incerta')
                  AND n.sent_at > ${params.agora} - interval '60 days'
             ) AS ja_enviada
        FROM customers c
        JOIN tenants t ON t.id = c.tenant_id
        -- Uma unidade, não todas. A tabela customers é do tenant, não da
        -- unidade: com duas unidades, um JOIN comum devolveria o mesmo cliente
        -- duas vezes, e as duas linhas leriam ja_enviada = false na mesma
        -- consulta — a mesma pessoa receberia a mensagem em dobro na mesma
        -- varredura. É a unidade principal, a mesma que a tela mostra.
        JOIN LATERAL (
          SELECT id AS location_id, timezone, comeback_after_days, notify_comeback
            FROM locations ORDER BY created_at LIMIT 1
        ) l ON true
       WHERE c.phone_e164 IS NOT NULL
         AND c.accepts_marketing
         AND l.notify_comeback
       ORDER BY c.id
       LIMIT ${limite}
    `,
  );

  let enviados = 0;

  for (const linha of linhas) {
    const decisao = decidirRetorno({
      ultimaVisita: linha.ultima_visita,
      diasParaRetorno: linha.comeback_after_days,
      agora: params.agora,
      timeZone: linha.timezone,
      temTelefone: Boolean(linha.phone),
      aceitaPromocional: linha.accepts_marketing,
      promocionaisNoMes: Number(linha.promocionais_no_mes),
      jaEnviada: linha.ja_enviada,
    });
    if (!decisao.enviar) continue;

    /**
     * A identidade é a **ausência atual**: cliente + última visita concluída.
     * Enquanto ele não voltar, uma intenção `sending/uncertain` sobrevivente a
     * crash bloqueia qualquer reenvio automático. Se o envio der certo, a linha
     * de `notifications` passa a ser a trava dos próximos 60 dias e a intenção
     * pode ser liberada; depois desse prazo o produto continua podendo fazer o
     * convite novamente, como já fazia antes.
     */
    const episodio = linha.ultima_visita?.toISOString() ?? 'sem-visita';
    const intentKey = `retorno:${linha.customer_id}:${episodio}`;
    const intencao = await withTenant(params.tenantId, (tx) =>
      reivindicarIntencaoDeEnvio(tx, intentKey),
    );
    if (!intencao.nossa) continue;

    try {
      await params.provider.enviarDeAgendamento({
        tenantId: params.tenantId,
        locationId: linha.location_id,
        phoneE164: linha.phone,
        tipo: 'retorno',
        clienteNome: linha.customer_name,
        barbearia: linha.tenant_name,
        profissional: '',
        quandoTexto: '',
      });
    } catch (erro) {
      if (erro instanceof WhatsAppDeliveryUnknownError) {
        await withTenant(params.tenantId, async (tx) => {
          await finalizarIntencaoDeEnvio(tx, intentKey, 'uncertain');
          await tx.$executeRaw`
            INSERT INTO notifications
              (tenant_id, kind, customer_id, status, reason, phone_masked)
            VALUES (
              NULLIF(current_setting('app.tenant_id', true), '')::uuid,
              'retorno', ${linha.customer_id}::uuid, 'failed', 'entrega_incerta',
              ${maskPhone(linha.phone)}
            )
          `;
        });
        continue;
      }
      // Recusa definitiva: sabemos que não saiu, portanto a fila pode tentar de
      // novo sem risco de duplicar uma mensagem aceita pela Meta.
      await withTenant(params.tenantId, (tx) => liberarIntencaoDeEnvio(tx, intentKey));
      throw erro;
    }

    await withTenant(params.tenantId, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO notifications (tenant_id, kind, customer_id, status, phone_masked)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          'retorno', ${linha.customer_id}::uuid, 'sent', ${maskPhone(linha.phone)}
        )
      `;
      // Depois que o fato `sent` existe, ele próprio barra os próximos 60 dias.
      // Remover a intenção preserva o comportamento histórico de poder convidar
      // novamente depois do prazo, sem sacrificar a segurança da janela ambígua.
      await liberarIntencaoDeEnvio(tx, intentKey);
    });
    enviados += 1;
  }

  return { enviados };
}

export { naturezaDe };
