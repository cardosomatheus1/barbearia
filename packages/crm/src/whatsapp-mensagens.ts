import { withTenant } from '@barbearia/db';
import {
  lerPayload,
  montarPayload,
  templateUtilizavel,
  whatsappDisponivel,
  variaveisDoCorpo,
  botaoConhecido,
  WhatsAppDeliveryUnknownError,
  type BotaoDaMensagem,
  type EstadoDoTemplate,
  type TipoDeNotificacao,
  type WhatsAppProvider,
} from '@barbearia/core';
import { enfileirarPara } from '@barbearia/jobs';
import { registrarConsentimento } from './lgpd.js';
import { cadastroDoWhatsApp } from './whatsapp-cadastro.js';

/**
 * O que fica gravado como "versão do texto" quando a saída foi por botão.
 *
 * Marcador fixo e não a versão do texto de marketing: a pessoa não leu nada,
 * ela apertou. Afirmar que leu seria prova falsa; nulo o `CHECK` recusa.
 */
const VERSAO_DA_SAIDA_PELO_BOTAO = 'saida-pelo-botao-do-whatsapp';

export interface PedidoDeMensagem {
  readonly tenantId: string;
  readonly locationId: string;
  readonly tipo: TipoDeNotificacao;
  readonly telefone: string;
  readonly variaveis: readonly string[];
  readonly customerId: string | null;
  readonly appointmentId: string | null;
  readonly provider: WhatsAppProvider;
  /**
   * Qual texto mandar, quando quem chama escolheu (bloco 94).
   *
   * Ausente resolve por tipo, que é o caminho do motor — ele dispara sozinho e
   * não tem quem escolha. A automação e a campanha escolhem, e é isso que faz
   * onze gatilhos diferentes deixarem de mandar a mesma frase.
   */
  readonly templateId?: string | null;
}

/**
 * Manda um aviso pelo WhatsApp, se der.
 *
 * Devolve `null` quando o canal não está disponível — cadastro inativo, template
 * não aprovado — e **não lança**: quem chama é o motor de aviso, que tem um
 * canal de reserva. A SPEC §4.12 pede isso em letras (*"fallback para SMS/push
 * quando o WhatsApp falha"*), e transformar canal indisponível em exceção faria
 * a tarefa da fila morrer em vez de cair para o outro caminho.
 *
 * A linha em `whatsapp_messages` nasce **depois** do envio, porque é o `wamid`
 * que a identifica e ele só existe depois. O que protege contra duplicata é a
 * unicidade dele: uma retentativa que já tinha enviado grava o mesmo id e
 * esbarra na constraint em vez de contar duas vezes.
 */
/**
 * Os botões gravados na linha do template, conferidos um a um.
 *
 * `jsonb` não tem tipo do lado de cá, e o que estiver ali foi escrito por uma
 * versão anterior deste código ou por uma migração. Um valor que não é botão
 * conhecido é descartado em silêncio — mandá-lo à Meta seria erro de envio, e
 * recusar a mensagem inteira por um botão estranho tiraria do ar um texto que
 * funciona.
 */
function botoesDaLinha(bruto: unknown): readonly BotaoDaMensagem[] {
  if (!Array.isArray(bruto)) return [];
  return bruto.filter((b): b is BotaoDaMensagem => typeof b === 'string' && botaoConhecido(b));
}

export async function enviarPeloWhatsApp(
  pedido: PedidoDeMensagem,
): Promise<{ readonly wamid: string } | null> {
  const cadastro = await cadastroDoWhatsApp(pedido.tenantId, pedido.locationId);
  if (!cadastro || !whatsappDisponivel(cadastro.estado)) return null;

  /**
   * O texto **escolhido**, quando quem chama escolheu (bloco 94).
   *
   * Sem escolha, resolve por tipo como sempre — é o caminho do motor, que
   * dispara sozinho e não tem quem escolha. Com escolha, é a automação ou a
   * campanha dizendo qual dos textos daquele tipo ela manda: até este bloco
   * existia um só por tipo, e as onze automações possíveis saíam todas com a
   * mesma frase.
   *
   * O `location_id` continua no filtro nos dois casos: o id vem de uma linha
   * desta barbearia pela RLS, e a unidade é outra coisa — numa rede, o texto da
   * filial não é o da matriz.
   */
  const template = await withTenant(pedido.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        name: string;
        language: string;
        status: EstadoDoTemplate;
        body: string;
        buttons: unknown;
      }[]
    >`
      SELECT id, name, language, status::text AS status, body, buttons
        FROM whatsapp_templates
       WHERE location_id = ${pedido.locationId}::uuid
         AND status = 'aprovado'
         AND (
           (${pedido.templateId ?? null}::uuid IS NOT NULL AND id = ${pedido.templateId ?? null}::uuid)
           OR (${pedido.templateId ?? null}::uuid IS NULL
               AND kind = ${pedido.tipo}::notification_kind)
         )
       LIMIT 1
    `;
    return linhas[0] ?? null;
  });
  if (!template || !templateUtilizavel(template.status)) return null;

  /**
   * Quantas variáveis o texto **aprovado** pede — e é ele quem manda.
   *
   * A Meta recusa o envio quando a quantidade de parâmetros não bate com a do
   * template: mandar três para um texto sem nenhuma variável falha igual a
   * mandar nenhuma para um texto que tem três.
   *
   * Escrever variável é opcional, e a barbearia que escreve "seu agendamento
   * está confirmado, te esperamos em breve!" tem um texto perfeitamente válido.
   * Sem esta conta, ele seria **aprovado** pela Meta e falharia em todo envio —
   * a pior combinação possível, porque a tela diria "aprovado" e o cliente não
   * receberia nada.
   *
   * Pedidas a mais são cortadas; pedidas a menos deixam o canal indisponível,
   * que cai no de reserva em vez de queimar a chamada.
   */
  const pedidas = variaveisDoCorpo(template.body);
  if (pedidas > pedido.variaveis.length) return null;
  const variaveis = pedido.variaveis.slice(0, pedidas);

  /**
   * Os botões saem da **linha**, e não mais do tipo.
   *
   * O que a Meta aprovou é o que está gravado ali: `BOTOES_DO_AVISO` é o que se
   * pede na criação, e a linha é o que ela devolveu. Com textos escritos pela
   * barbearia — cada um com o seu conjunto — derivar do tipo mandaria os botões
   * de um texto junto do corpo de outro, e a Meta casa a resposta pela
   * **posição**: o cliente apertaria o primeiro e o produto entenderia outro.
   */
  const botoes = botoesDaLinha(template.buttons);
  /**
   * Os botões saem **sempre**, com ou sem agendamento.
   *
   * A versão anterior mandava zero quando `appointmentId` era nulo — que é o
   * caso de toda campanha, toda automação e toda mensagem avulsa. O texto era
   * aprovado com botão, a Meta o desenhava no cadastro, e o cliente recebia uma
   * mensagem sem botão nenhum. Ninguém do lado de cá via a diferença.
   */
  const respostas = botoes.map((botao) => ({
    botao,
    payload: montarPayload(botao, pedido.appointmentId),
  }));

  const enviada = await pedido.provider.enviar({
    para: pedido.telefone,
    template: template.name,
    idioma: template.language,
    variaveis,
    respostas,
  });

  try {
    await withTenant(pedido.tenantId, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO whatsapp_messages (tenant_id, wamid, customer_id, template_id)
        VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                ${enviada.wamid}, ${pedido.customerId}::uuid, ${template.id}::uuid)
        ON CONFLICT (wamid) DO NOTHING
      `;
    });
  } catch {
    /**
     * A Meta já confirmou o envio. Falhar **só** ao registrar o wamid localmente
     * não transforma esse fato em uma recusa segura: repetir agora pode mandar
     * a mesma mensagem duas vezes. Quem chama precisa manter a intenção como
     * ambígua, exatamente como num timeout depois do POST da Meta.
     */
    throw new WhatsAppDeliveryUnknownError(
      'a Meta confirmou a mensagem, mas o Barberdock não conseguiu registrar o wamid',
    );
  }

  return { wamid: enviada.wamid };
}

// ---------------------------------------------------------------------------
// O que a Meta conta de volta
// ---------------------------------------------------------------------------

export type EstadoDaMensagem = 'enviada' | 'entregue' | 'lida' | 'falhou';

/**
 * Atualiza o que aconteceu com uma mensagem.
 *
 * Idempotente por `wamid`, e **só avança**: a Meta entrega os eventos fora de
 * ordem com frequência, e um `lida` chegando antes do `entregue` não pode fazer
 * a mensagem voltar. É o mesmo cuidado do espelho de consentimento no bloco 31,
 * que só avança se a decisão for a mais recente.
 */
const ORDEM: Readonly<Record<EstadoDaMensagem, number>> = {
  enviada: 0,
  entregue: 1,
  lida: 2,
  // Falha é terminal e vem de outro caminho: ela não compete com as três acima.
  falhou: 3,
};

/**
 * A Meta desconectou o número da Cloud API (bloco 85).
 *
 * ## Quando isto acontece
 *
 * Na coexistência, o número continua no aplicativo WhatsApp Business — e se o
 * cliente **registrar o aplicativo em outro aparelho**, a Meta desfaz o
 * pareamento e manda `ACCOUNT_OFFBOARDED`. O número volta a ser só do
 * aplicativo, e o produto para de conseguir mandar mensagem.
 *
 * ## Por que precisa de estado, e não de silêncio
 *
 * Sem tratar este evento, a tela continuaria dizendo **Ativo** enquanto toda
 * mensagem cai no canal de reserva — o defeito da §6 pergunta 6, com a
 * diferença de que aqui quem mente é o mundo, não a nossa consulta. O barbeiro
 * trocaria de celular numa terça e a barbearia descobriria pela falta que os
 * clientes não confirmam mais.
 *
 * Vai para `suspenso`, que é o estado que já significa "a Meta tirou o número
 * do ar, o motivo está escrito, e os avisos voltaram ao canal antigo". O token
 * **não** é apagado: reconectar é refazer o fluxo, e apagar a credencial aqui
 * só tiraria a informação de que ela existiu.
 */
export async function desconectarNumero(params: {
  readonly tenantId: string;
  readonly phoneNumberId: string;
  readonly motivo: string;
}): Promise<boolean> {
  return withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE whatsapp_settings
         SET status = 'suspenso', status_reason = ${params.motivo}, updated_at = now()
       WHERE phone_number_id = ${params.phoneNumberId}
         AND status <> 'suspenso'
    `;
    return afetadas === 1;
  });
}

export async function registrarEstadoDaMensagem(params: {
  readonly tenantId: string;
  readonly wamid: string;
  readonly estado: EstadoDaMensagem;
  readonly motivo?: string | null;
}): Promise<boolean> {
  /**
   * Sob `withTenant`, e a primeira versão não era — foi o teste que pegou.
   *
   * A tentação era usar `semTenant`, porque o webhook chega antes de sabermos
   * de quem é: a Meta manda o id da mensagem, não o nosso id de barbearia. Mas
   * sem tenant no contexto a política de RLS não casa com **nenhuma** linha, e
   * o `UPDATE` não achava nada — a função devolvia `false` para tudo, em
   * silêncio, e a mensagem ficaria "enviada" para sempre.
   *
   * Quem resolve o tenant é a porta do webhook, por `tenantDoNumero`, antes de
   * chamar aqui. É o mesmo desenho do webhook da Stripe: o metadado abre o
   * tenant, e o id procurado **dentro** dele é quem confirma.
   */
  return withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE whatsapp_messages
         SET status = ${params.estado}::whatsapp_message_status,
             failure_reason = COALESCE(${params.motivo ?? null}, failure_reason),
             delivered_at = CASE WHEN ${params.estado} IN ('entregue', 'lida')
                                 THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
             read_at = CASE WHEN ${params.estado} = 'lida'
                            THEN COALESCE(read_at, now()) ELSE read_at END
       WHERE wamid = ${params.wamid}
         AND (
           -- falhou é terminal só antes de qualquer prova de entrega.
           -- Um evento atrasado/contraditório não pode transformar uma mensagem
           -- já entregue ou lida em falha.
           (${params.estado} = 'falhou' AND status = 'enviada')
           OR
           (${params.estado} <> 'falhou' AND status <> 'falhou'
             AND ${ORDEM[params.estado]} > CASE status::text
                   WHEN 'enviada' THEN 0 WHEN 'entregue' THEN 1
                   WHEN 'lida' THEN 2 ELSE 3 END)
         )
    `;
    return afetadas === 1;
  });
}

/**
 * Grava o toque no botão e enfileira o tratamento.
 *
 * Grava **antes** de tratar, e devolve rápido: a Meta desiste da entrega se o
 * webhook demorar, e reentrega — o que faria o mesmo cancelamento chegar duas
 * vezes. A unicidade por `wamid` é quem barra a segunda, e é por isso que ela
 * existe no banco e não só aqui.
 *
 * Quem mexe na agenda é `packages/scheduling`, pela tarefa. Este arquivo não
 * sabe cancelar horário nenhum, e é de propósito.
 */
export async function registrarResposta(params: {
  readonly tenantId: string;
  readonly wamid: string;
  readonly telefone: string;
  readonly payload: string | null;
  readonly texto: string | null;
}): Promise<{ readonly novo: boolean }> {
  return withTenant(params.tenantId, async (tx) => {
    const lido = lerPayload(params.payload);

    /**
     * O agendamento é **provado** antes de virar coluna, e a prova tem duas
     * partes.
     *
     * `lerPayload` confere forma — botão conhecido, UUID bem formado — e nada
     * mais. Gravá-lo direto na chave estrangeira seria confiar num id que
     * voltou pelo aparelho do cliente por um endereço público: a checagem de
     * integridade referencial do Postgres roda como dono da tabela e **ignora
     * row security**, então a chave aceitaria o horário de outra barbearia sem
     * reclamar. É a regra escrita do projeto, e a `/security-review` deste bloco
     * a cobrou aqui.
     *
     * A consulta abaixo dá as duas partes: a RLS filtra a barbearia, e o
     * `customer_id` — resolvido pelo telefone que a Meta mandou — filtra a
     * pessoa. A RLS separa barbearias e **não** separa clientes dentro de uma;
     * sem a segunda metade, quem descobrisse um id cancelaria o horário de
     * qualquer outro cliente da mesma casa.
     *
     * Não casou, grava nulo: a linha continua existindo — é o registro de que
     * alguém respondeu — e o desfecho explica por que nada foi feito. Recusar a
     * gravação inteira apagaria o rastro justamente do caso suspeito.
     */
    const donos = await tx.$queryRaw<{ id: string }[]>`
      SELECT a.id
        FROM appointments a
        JOIN customers c ON c.id = a.customer_id
       WHERE a.id = ${lido?.agendamentoId ?? null}::uuid
         AND c.phone_e164 = ${params.telefone}
    `;
    const agendamentoProvado = donos[0]?.id ?? null;

    const linhas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO whatsapp_inbound
        (tenant_id, wamid, from_phone, payload, body, appointment_id, customer_id)
      SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid,
             ${params.wamid}, ${params.telefone}, ${params.payload}, ${params.texto},
             ${agendamentoProvado}::uuid,
             (SELECT id FROM customers WHERE phone_e164 = ${params.telefone} LIMIT 1)
      ON CONFLICT (wamid) DO NOTHING
      RETURNING id
    `;
    const linha = linhas[0];
    if (!linha) return { novo: false };

    await enfileirarPara(tx, params.tenantId, {
      kind: 'whatsapp.responder',
      // Id, nunca conteúdo: `jobs` não tem RLS, e o texto que o cliente digitou
      // é conversa dele com a casa.
      payload: { inboundId: linha.id },
      idempotencyKey: `whatsapp-inbound:${linha.id}`,
    });
    return { novo: true };
  });
}

export interface RespostaAExecutar {
  readonly id: string;
  readonly botao: BotaoDaMensagem | null;
  readonly agendamentoId: string | null;
  readonly customerId: string | null;
  readonly telefone: string;
  readonly texto: string | null;
}

export async function respostaAExecutar(
  tenantId: string,
  inboundId: string,
): Promise<RespostaAExecutar | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        payload: string | null;
        appointment_id: string | null;
        customer_id: string | null;
        from_phone: string;
        body: string | null;
      }[]
    >`
      SELECT id, payload, appointment_id, customer_id, from_phone, body
        FROM whatsapp_inbound
       WHERE id = ${inboundId}::uuid AND handled_at IS NULL
    `;
    const linha = linhas[0];
    if (!linha) return null;
    const lido = lerPayload(linha.payload);
    return {
      id: linha.id,
      botao: lido?.botao ?? null,
      agendamentoId: linha.appointment_id,
      customerId: linha.customer_id,
      telefone: linha.from_phone,
      texto: linha.body,
    };
  });
}

/**
 * Fecha a resposta com o que foi feito.
 *
 * O desfecho é escrito **sempre**, inclusive quando nada foi feito: "o horário
 * já tinha passado" e "o cliente escreveu um texto livre" são coisas diferentes,
 * e o balcão que abre a caixa de entrada precisa saber qual das duas foi. Sem o
 * carimbo, a linha voltaria à fila a cada volta do laço.
 */
export async function fecharResposta(params: {
  readonly tenantId: string;
  readonly inboundId: string;
  readonly desfecho: string;
}): Promise<boolean> {
  return withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE whatsapp_inbound
         SET handled_at = now(), outcome = ${params.desfecho}
       WHERE id = ${params.inboundId}::uuid AND handled_at IS NULL
    `;
    return afetadas === 1;
  });
}

// ---------------------------------------------------------------------------
// O botão virando ação
// ---------------------------------------------------------------------------

/**
 * O que fazer com o toque, decidido aqui e executado por quem sabe.
 *
 * Esta função **não** cancela nem remarca: ela lê a resposta, decide, chama a
 * ação que recebeu por parâmetro e fecha a linha com o desfecho. `crm` não
 * conhece `scheduling`, e a seta não vai voltar por causa de um botão.
 *
 * ## O filtro por cliente não é detalhe
 *
 * O payload volta **pelo aparelho do cliente** e chega por um endereço público.
 * A RLS separa barbearias e **não separa clientes dentro de uma**: sem o
 * `customerId`, quem descobrisse o id de um agendamento cancelaria o horário de
 * qualquer outra pessoa da mesma barbearia mandando um webhook forjado. É a
 * mesma regra que o cancelamento pelo site já cumpre desde o bloco 8.
 *
 * Resposta de quem não é cliente conhecido não vira ação nenhuma — e isso é
 * estado legítimo, não erro: gente escreve para o número da barbearia o tempo
 * todo, e o texto livre fica na caixa de entrada para alguém ler.
 */
export async function executarResposta(params: {
  readonly tenantId: string;
  readonly inboundId: string;
  readonly agora: Date;
  readonly cancelar: (entrada: {
    readonly tenantId: string;
    readonly appointmentId: string;
    readonly customerId: string;
    readonly agora: Date;
  }) => Promise<void>;
  readonly confirmar: (entrada: {
    readonly tenantId: string;
    readonly appointmentId: string;
    readonly customerId: string;
  }) => Promise<void>;
}): Promise<string> {
  const resposta = await respostaAExecutar(params.tenantId, params.inboundId);
  if (!resposta) return 'ja tratada';

  const fechar = async (desfecho: string) => {
    await fecharResposta({ tenantId: params.tenantId, inboundId: params.inboundId, desfecho });
    return desfecho;
  };

  /**
   * `agendamentoId` aqui é o **provado**, lido da coluna que só foi escrita
   * depois de casar barbearia e cliente. O que veio no payload não chega até
   * este ponto: sem prova, a coluna é nula e a resposta cai no caminho de baixo.
   */
  if (!resposta.botao) {
    // Texto livre: a pessoa escreveu em vez de tocar. Fica para alguém ler.
    return fechar('mensagem de texto, sem ação automática');
  }

  /**
   * Sem cliente conhecido, nada acontece.
   *
   * O telefone que a Meta manda é o do aparelho, e ele pode não estar no
   * cadastro — número novo, pessoa que nunca marcou, ou um webhook forjado.
   *
   * A ordem importa: esta pergunta vem **antes** da do agendamento porque as
   * duas dão nulo no mesmo caso, e sem separá-las quem tocou um botão de
   * número desconhecido lia "mensagem de texto" no balcão — que é falso e manda
   * procurar um texto que não existe.
   */
  if (!resposta.customerId) {
    return fechar('quem respondeu não está no cadastro — nada foi alterado');
  }

  /**
   * Sair da lista age **sem** horário, e por isso vem antes da checagem dele.
   *
   * É o único botão deste produto que não fala de um agendamento: quem recebeu
   * uma campanha não tem horário marcado, e exigir um faria o pedido de parar
   * cair em "o horário não é de quem respondeu" — a pessoa apertaria, nada
   * aconteceria, e a mensagem seguinte chegaria igual. Depois disso ela não
   * aperta de novo: marca como spam, que derruba a qualidade do número e leva
   * o lembrete de horário junto.
   *
   * Revogação é **inserção** no histórico, nunca apagamento da concessão — é a
   * regra de `customer_consents` desde o bloco 33, e o espelho em
   * `customers.accepts_marketing` é atualizado por gatilho.
   *
   * A versão é um marcador fixo porque não houve texto lido: a pessoa apertou
   * um botão. Escrever a versão do texto de marketing afirmaria que ela leu
   * aquilo agora, o que é falso; nulo o `CHECK` recusa, e com razão. É a decisão
   * do motivo do ajuste de saldo, pela mesma razão.
   */
  if (resposta.botao === 'parar_de_receber') {
    await registrarConsentimento({
      tenantId: params.tenantId,
      customerId: resposta.customerId,
      finalidade: 'marketing',
      concedido: false,
      versaoDoTexto: VERSAO_DA_SAIDA_PELO_BOTAO,
    });
    return fechar('saiu da lista de promoções');
  }

  /**
   * Botão com dono conhecido, mas sem horário provado.
   *
   * A coluna só foi escrita depois de casar barbearia **e** cliente. Nulo aqui
   * significa que o id que voltou não é um horário desta pessoa — horário de
   * outro cliente, de outra barbearia, ou que já não existe.
   */
  if (!resposta.agendamentoId) {
    return fechar('o horário não é de quem respondeu — nada foi alterado');
  }

  const entrada = {
    tenantId: params.tenantId,
    appointmentId: resposta.agendamentoId,
    customerId: resposta.customerId,
  };

  try {
    if (resposta.botao === 'cancelar') {
      await params.cancelar({ ...entrada, agora: params.agora });
      return fechar('horário cancelado pelo cliente');
    }
    if (resposta.botao === 'confirmar') {
      await params.confirmar(entrada);
      return fechar('presença confirmada');
    }
    /**
     * Remarcar e agendar de novo não têm ação automática, e é decisão.
     *
     * Escolher horário exige ver a grade, e uma mensagem de texto não tem grade.
     * Fingir que remarca — pegando o próximo horário livre, por exemplo — poria
     * a pessoa num horário que ela não escolheu. O que a mensagem faz é levá-la
     * ao site, e o que fica aqui é o registro de que ela quis.
     */
    return fechar(
      resposta.botao === 'remarcar' ? 'quer remarcar' : 'quer agendar de novo',
    );
  } catch (erro) {
    /**
     * A recusa do domínio é desfecho, não falha da tarefa.
     *
     * "Cancelou depois do prazo" e "o horário já passou" são respostas
     * legítimas, e relançá-las faria a tarefa ser retentada até esgotar as
     * tentativas — cinco chamadas que já sabem a resposta, e a linha ficaria
     * para sempre sem desfecho na caixa de entrada.
     */
    const motivo = erro instanceof Error ? erro.message : 'não deu para aplicar';
    return fechar(`não aplicado: ${motivo}`);
  }
}

// ---------------------------------------------------------------------------
// A assinatura do webhook da Meta
// ---------------------------------------------------------------------------

/**
 * A conta da Meta é **outra** que a do adquirente, e não dá para reaproveitar.
 *
 * Mora aqui e não em `packages/core` por duas razões, e as duas são regra
 * escrita: `core` não depende de nada — nem de `node:crypto` —, e o precedente
 * do adquirente põe `conferirAssinaturaDoWebhook` em `packages/platform`, ao
 * lado de quem consome o webhook.
 *
 * A Stripe assina `${instante}.${corpo}` e manda o instante no cabeçalho, o que
 * permite recusar reenvio antigo por janela de tempo. A Meta assina **só o
 * corpo cru**, em `X-Hub-Signature-256: sha256=<hex>`, com o *app secret* — não
 * há instante, então não há janela.
 *
 * O que substitui a janela é a idempotência por id de mensagem: reenviar um
 * evento capturado grava o mesmo `wamid`, esbarra na unicidade e não faz nada.
 * É por isso que aquela constraint existe no banco e não só no código.
 *
 * O segredo vem do ambiente e **falha alto quando ausente**: cair num padrão
 * vazio faria toda assinatura conferir, e o endereço é público.
 */
