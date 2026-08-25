import {
  EXPLICACAO_DE_NAO_DISPARAR,
  decidirDisparo,
  maskPhone,
  tipoDeCampanhaValido,
  TIPOS_PROMOCIONAIS,
  type TipoDeCampanha,
  type TipoDeNotificacao,
  WhatsAppDeliveryUnknownError,
} from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import { audit } from '@barbearia/identity';
import {
  confirmarDisparoPromocional,
  liberarDisparoPromocional,
  marcarDisparoPromocionalIncerto,
  reservarDisparoPromocional,
} from './disparo-promocional.js';

/**
 * Mandar uma mensagem para **uma** pessoa, do balcão (bloco 92).
 *
 * ## O que faltava
 *
 * Uma mensagem só saía por quatro caminhos, e os quatro decidem sozinhos quem
 * recebe: lembrete de agendamento, "sua vez" na fila, automação e campanha em
 * massa. Não havia como a recepção abrir a ficha do Carlos e falar com **ele** —
 * e é o que se pede o dia inteiro no balcão: "avisa o Carlos que abriu vaga",
 * "manda o endereço para a moça de ontem".
 *
 * O que a barbearia fazia era pegar o celular pessoal e mandar por fora. Aí a
 * conversa sai de um número que não é o da casa, não conta no teto, não aparece
 * em relatório nenhum e não respeita quem pediu para não receber promoção.
 *
 * ## Por que passa pelas mesmas guardas
 *
 * A tentação é isentar o envio manual: tem gente decidindo, então seria "de
 * verdade". Mas as três guardas existem por motivos que a decisão humana não
 * apaga:
 *
 * - **Consentimento** é lei, e quem revogou revogou para a casa, não para o
 *   robô da casa.
 * - **Teto do mês** existe para o número não ser queimado por spam — e a Meta
 *   pausa quem é marcado como spam, o que derruba o canal inteiro, inclusive os
 *   lembretes que reduzem falta.
 * - **Janela de silêncio** é sobre o cliente dormindo. Quem manda às 22h47 do
 *   balcão manda pelo mesmo número que manda o lembrete.
 *
 * Isentar o manual faria dele o caminho mais curto para furar as três, e o
 * caminho mais curto é o que todo mundo passa a usar.
 *
 * ## Por que só tipo de campanha
 *
 * Mesma razão da automação (bloco 88): quem recebe uma mensagem avulsa **não
 * tem horário marcado**, então `lembrete_24h` prometeria um horário que não
 * existe — e `senha_de_acesso` é credencial.
 */

export type FalhaDoEnvioAvulso =
  | 'sem_canal'
  | 'sem_texto_aprovado'
  | 'tipo_invalido'
  | 'cliente_nao_encontrado'
  | 'recusado'
  | 'envio_em_andamento'
  | 'envio_incerto'
  | 'idempotency_key_reutilizada';

export class EnvioAvulsoError extends Error {
  constructor(
    readonly code: FalhaDoEnvioAvulso,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = 'EnvioAvulsoError';
  }
}

export interface ResultadoDoEnvioAvulso {
  readonly enviado: boolean;
  readonly wamid: string | null;
  /** Por que não saiu, quando não saiu. A tela mostra esta frase. */
  readonly motivo: string | null;
}

/**
 * Manda o texto aprovado de um tipo para um cliente, agora.
 *
 * `enviar` é injetado pelo mesmo motivo de `despacharCampanha`: quem sabe falar
 * com a Meta é a camada de cima, e o domínio não tem provedor. Ele devolve o
 * `wamid` quando a Meta confirmou o envio. Nesta entrada administrativa não
 * existe canal de reserva: `null` significa que nada foi confirmado e portanto
 * nunca pode ser carimbado como sucesso.
 */
export async function enviarMensagemAvulsa(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly customerId: string;
  /**
   * O tipo, quando não há texto escolhido.
   *
   * Opcional desde o bloco 96, pelo par de `templateId`: quem escolhe o texto
   * já disse o tipo, porque o texto tem um.
   */
  readonly tipo?: TipoDeNotificacao;
  /**
   * Qual dos textos aprovados o balcão apertou (bloco 96).
   *
   * A ficha listava os três convites de retorno cadastrados, cada um com um
   * botão "Mandar", e os três mandavam **o mesmo**: o formulário postava o
   * `tipo`, e o motor pegava o primeiro aprovado daquele tipo. A recepção lia
   * "volte que sentimos sua falta", apertava, e o cliente recebia "seu pacote
   * está acabando".
   */
  readonly templateId?: string | null;
  readonly agora: Date;
  readonly timeZone: string;
  readonly staffId: string;
  readonly staffName: string;
  /**
   * Identifica **esta intenção**, não o cliente para sempre.
   *
   * A mesma página reutiliza a chave em duplo clique/reenvio; uma nova renderização
   * recebe outra. A tabela também trava uma segunda chave enquanto o primeiro envio
   * estiver em voo ou incerto, que é o que fecha o buraco do refresh após timeout.
   */
  readonly idempotencyKey: string;
  readonly enviar: (destino: {
    readonly telefone: string;
    readonly clienteNome: string;
    readonly barbearia: string;
    /** Qual texto mandar; nulo cai no primeiro aprovado do tipo, como antes. */
    readonly templateId: string | null;
    /**
     * O tipo **resolvido**, que é o do texto quando há um.
     *
     * Quem chama não pode relê-lo do corpo da requisição: ali ele pode nem
     * existir, e quando existe é o campo que o texto vence.
     */
    readonly tipo: TipoDeNotificacao;
  }) => Promise<string | null>;
}): Promise<ResultadoDoEnvioAvulso> {
  if (params.tipo !== undefined && !tipoDeCampanhaValido(params.tipo)) {
    throw new EnvioAvulsoError(
      'tipo_invalido',
      'Este texto não serve para mensagem avulsa: ele fala de um horário marcado.',
    );
  }

  /**
   * O tipo sai do texto escolhido, conferido sob RLS **e pela unidade**.
   *
   * A checagem de integridade referencial do Postgres ignora row security, e a
   * RLS separa barbearias e não separa lojas dentro de uma: sem as duas
   * conferências, o id de outra casa — ou o texto aprovado no número da filial
   * — viraria a mensagem que sai daqui.
   */
  let tipo: TipoDeCampanha | undefined = params.tipo;
  if (params.templateId) {
    const doTexto = await withTenant(params.tenantId, async (tx) => {
      const linhas = await tx.$queryRaw<{ kind: TipoDeNotificacao }[]>`
        SELECT kind::text AS kind FROM whatsapp_templates
         WHERE id = ${params.templateId}::uuid
           AND location_id = ${params.locationId}::uuid
           AND status = 'aprovado'
      `;
      return linhas[0] ?? null;
    });
    if (!doTexto) {
      throw new EnvioAvulsoError('sem_texto_aprovado', 'Este texto não existe ou não foi aprovado.');
    }
    if (!tipoDeCampanhaValido(doTexto.kind)) {
      throw new EnvioAvulsoError(
        'tipo_invalido',
        'Este texto não serve para mensagem avulsa: ele fala de um horário marcado.',
      );
    }
    tipo = doTexto.kind;
  }
  if (tipo === undefined) {
    throw new EnvioAvulsoError('tipo_invalido', 'Escolha o texto que vai ser mandado.');
  }

  const dados = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        nome: string | null;
        telefone: string | null;
        aceita: boolean;
        barbearia: string;
        hoje: bigint;
        no_mes: bigint;
        aprovado: boolean;
      }[]
    >`
      SELECT c.name AS nome,
             c.phone_e164 AS telefone,
             c.accepts_marketing AS aceita,
             (SELECT name FROM tenants LIMIT 1) AS barbearia,
             (SELECT count(*) FROM notifications n
               WHERE n.customer_id = c.id AND n.status = 'sent'
                 AND n.kind = ANY(${[...TIPOS_PROMOCIONAIS]}::notification_kind[])
                 AND (n.sent_at AT TIME ZONE ${params.timeZone})::date
                   = (${params.agora}::timestamptz AT TIME ZONE ${params.timeZone})::date) AS hoje,
             (SELECT count(*) FROM notifications n
               WHERE n.customer_id = c.id AND n.status = 'sent'
                 AND n.kind = ANY(${[...TIPOS_PROMOCIONAIS]}::notification_kind[])
                 AND n.sent_at > ${params.agora}::timestamptz - interval '30 days') AS no_mes,
             EXISTS (SELECT 1 FROM whatsapp_templates t
                      WHERE t.location_id = ${params.locationId}::uuid
                        AND t.kind = ${tipo}::notification_kind
                        AND t.status = 'aprovado') AS aprovado
        FROM customers c
       WHERE c.id = ${params.customerId}::uuid AND c.anonymized_at IS NULL
    `;
    return linhas[0] ?? null;
  });

  if (!dados) {
    throw new EnvioAvulsoError('cliente_nao_encontrado', 'Este cliente não existe.');
  }
  if (!dados.aprovado) {
    throw new EnvioAvulsoError(
      'sem_texto_aprovado',
      'Não há texto aprovado para este aviso. Mande um para aprovação antes.',
    );
  }

  /**
   * A mesma decisão do disparo automático, com a natureza **forçada**.
   *
   * Forçada pelo motivo já escrito em `despacharCampanha`: `naturezaDe` chama
   * de transacional tudo que não é `retorno`, e um tipo novo acrescentado à
   * lista de campanha sem mexer nela voltaria a furar o opt-out em silêncio.
   */
  const decisao = decidirDisparo({
    ativa: true,
    tipo,
    natureza: 'promocional',
    jaDisparouPorEsteFato: false,
    jaRecebeuHoje: Number(dados.hoje) > 0,
    temTelefone: Boolean(dados.telefone),
    aceitaPromocional: dados.aceita,
    promocionaisNoMes: Number(dados.no_mes),
    atrasoMinutos: 0,
    fatoEm: params.agora,
    agora: params.agora,
    timeZone: params.timeZone,
  });

  /**
   * Fora da janela de silêncio **recusa**, e não agenda.
   *
   * O disparo automático empurra para as 8h porque ninguém está esperando. Aqui
   * há alguém no balcão que acabou de apertar o botão: gravar em silêncio para
   * amanhã de manhã faria a recepção achar que mandou, e dizer ao cliente que
   * mandou. A frase é escrita e a decisão volta para quem apertou.
   */
  const foraDaJanela =
    decisao.disparar && decisao.quando !== null && decisao.quando.getTime() > params.agora.getTime();

  if (!decisao.disparar || foraDaJanela) {
    const motivo = foraDaJanela
      ? 'Entre 21h e 8h nada sai — é a janela de silêncio da barbearia.'
      : (EXPLICACAO_DE_NAO_DISPARAR[decisao.motivo ?? 'sem_telefone'] ?? 'Não deu para mandar.');
    return { enviado: false, wamid: null, motivo };
  }

  const telefone = dados.telefone ?? '';
  const fingerprint = `${params.customerId}:${params.templateId ?? `tipo:${tipo}`}`;

  /**
   * A intenção nasce **antes da rede**.
   *
   * `wamid` só existe depois que a Meta responde, portanto ele não pode proteger
   * "aceitou e a resposta sumiu". Além da chave da requisição, o fingerprint
   * bloqueia uma chave nova para o mesmo cliente+texto enquanto o desfecho estiver
   * em voo/incerto — refresh da ficha não vira um segundo disparo.
   */
  const intencao = await withTenant(params.tenantId, async (tx) => {
    const novas = await tx.$queryRaw<{
      id: string;
      customer_id: string;
      template_id: string | null;
      kind: TipoDeNotificacao;
      intent_fingerprint: string;
      status: 'enviando' | 'incerto' | 'enviado';
      wamid: string | null;
    }[]>`
      INSERT INTO whatsapp_manual_send_intents
        (tenant_id, location_id, customer_id, template_id, kind,
         idempotency_key, intent_fingerprint, status)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.locationId}::uuid, ${params.customerId}::uuid,
        ${params.templateId ?? null}::uuid, ${tipo}::notification_kind,
        ${params.idempotencyKey}, ${fingerprint}, 'enviando'
      )
      ON CONFLICT DO NOTHING
      RETURNING id, customer_id, template_id, kind::text AS kind,
                intent_fingerprint, status, wamid
    `;
    if (novas[0]) {
      return { linha: novas[0], mesmaChave: true, nossa: true } as const;
    }

    const porChave = await tx.$queryRaw<{
      id: string;
      customer_id: string;
      template_id: string | null;
      kind: TipoDeNotificacao;
      intent_fingerprint: string;
      status: 'enviando' | 'incerto' | 'enviado';
      wamid: string | null;
    }[]>`
      SELECT id, customer_id, template_id, kind::text AS kind,
             intent_fingerprint, status, wamid
        FROM whatsapp_manual_send_intents
       WHERE location_id = ${params.locationId}::uuid
         AND idempotency_key = ${params.idempotencyKey}
       LIMIT 1
    `;
    if (porChave[0]) return { linha: porChave[0], mesmaChave: true, nossa: false } as const;

    const ativa = await tx.$queryRaw<{
      id: string;
      customer_id: string;
      template_id: string | null;
      kind: TipoDeNotificacao;
      intent_fingerprint: string;
      status: 'enviando' | 'incerto' | 'enviado';
      wamid: string | null;
    }[]>`
      SELECT id, customer_id, template_id, kind::text AS kind,
             intent_fingerprint, status, wamid
        FROM whatsapp_manual_send_intents
       WHERE location_id = ${params.locationId}::uuid
         AND intent_fingerprint = ${fingerprint}
         AND status IN ('enviando', 'incerto')
       ORDER BY created_at DESC
       LIMIT 1
    `;
    return { linha: ativa[0] ?? null, mesmaChave: false, nossa: false } as const;
  });

  if (!intencao.linha) {
    throw new EnvioAvulsoError('envio_em_andamento', 'Já existe um envio deste texto sendo processado.');
  }
  if (
    intencao.mesmaChave &&
    (intencao.linha.customer_id !== params.customerId ||
      intencao.linha.template_id !== (params.templateId ?? null) ||
      intencao.linha.kind !== tipo ||
      intencao.linha.intent_fingerprint !== fingerprint)
  ) {
    throw new EnvioAvulsoError(
      'idempotency_key_reutilizada',
      'Esta chave de envio já foi usada para outra mensagem.',
    );
  }
  if (intencao.linha.status === 'enviado') {
    return { enviado: true, wamid: intencao.linha.wamid, motivo: null };
  }
  if (!intencao.nossa) {
    throw new EnvioAvulsoError(
      intencao.linha.status === 'incerto' ? 'envio_incerto' : 'envio_em_andamento',
      intencao.linha.status === 'incerto'
        ? 'A Meta pode ter recebido esta mensagem, mas o Barberdock não conseguiu confirmar. Não envie novamente agora.'
        : 'Este mesmo texto já está sendo enviado para o cliente. Aguarde antes de tentar de novo.',
    );
  }

  const promoIntentKey = `promo:manual:${intencao.linha.id}`;
  const reserva = await withTenant(params.tenantId, (tx) =>
    reservarDisparoPromocional(tx, {
      tenantId: params.tenantId,
      customerId: params.customerId,
      intentKey: promoIntentKey,
      tipo,
      agora: params.agora,
      timeZone: params.timeZone,
    }),
  );
  if (!reserva.nossa) {
    await withTenant(params.tenantId, async (tx) => {
      await tx.$executeRaw`
        DELETE FROM whatsapp_manual_send_intents
         WHERE id = ${intencao.linha.id}::uuid AND status = 'enviando'
      `;
    });

    if (reserva.motivo === 'ja_recebeu_hoje' || reserva.motivo === 'teto_do_mes') {
      return {
        enviado: false,
        wamid: null,
        motivo: EXPLICACAO_DE_NAO_DISPARAR[reserva.motivo],
      };
    }
    throw new EnvioAvulsoError(
      reserva.motivo === 'entrega_incerta' ? 'envio_incerto' : 'envio_em_andamento',
      reserva.motivo === 'entrega_incerta'
        ? 'Já existe uma mensagem deste cliente cujo desfecho não pôde ser confirmado.'
        : 'Já existe outra mensagem promocional sendo processada para este cliente.',
    );
  }

  let wamid: string | null;
  try {
    wamid = await params.enviar({
      telefone,
      clienteNome: dados.nome ?? 'cliente',
      barbearia: dados.barbearia,
      templateId: params.templateId ?? null,
      tipo,
    });
    if (!wamid) {
      throw new EnvioAvulsoError(
        'sem_canal',
        'O WhatsApp ficou indisponível antes de confirmar o envio. Nada foi marcado como enviado.',
      );
    }
  } catch (erro) {
    if (erro instanceof WhatsAppDeliveryUnknownError) {
      await withTenant(params.tenantId, async (tx) => {
        await tx.$executeRaw`
          UPDATE whatsapp_manual_send_intents
             SET status = 'incerto', updated_at = ${params.agora}
           WHERE id = ${intencao.linha.id}::uuid AND status = 'enviando'
        `;
        await marcarDisparoPromocionalIncerto(tx, promoIntentKey, params.agora);
      });
      throw new EnvioAvulsoError(
        'envio_incerto',
        'A Meta pode ter recebido esta mensagem, mas o Barberdock não conseguiu confirmar. Não envie novamente agora.',
      );
    }

    // Recusa explícita é segura para nova tentativa: nenhuma das duas intenções
    // fica ocupando a cota quando sabemos que o provedor não aceitou o envio.
    await withTenant(params.tenantId, async (tx) => {
      await liberarDisparoPromocional(tx, promoIntentKey);
      await tx.$executeRaw`
        DELETE FROM whatsapp_manual_send_intents
         WHERE id = ${intencao.linha.id}::uuid AND status = 'enviando'
      `;
    });
    throw erro;
  }

  /**
   * Sucesso externo e histórico entram juntos. Se esta transação falhar, as
   * intenções continuam `sending` e um retry não manda de novo: o desfecho vira
   * conservadoramente ambíguo em vez de duplicar a mensagem.
   */
  await withTenant(params.tenantId, async (tx) => {
    const atualizadas = await tx.$executeRaw`
      UPDATE whatsapp_manual_send_intents
         SET status = 'enviado', wamid = ${wamid}, updated_at = ${params.agora}
       WHERE id = ${intencao.linha.id}::uuid AND status = 'enviando'
    `;
    if (atualizadas !== 1) throw new Error('intenção avulsa deixou de pertencer a este envio');

    const confirmou = await confirmarDisparoPromocional(tx, {
      intentKey: promoIntentKey,
      tipo,
      customerId: params.customerId,
      phoneMasked: maskPhone(telefone),
      wamid,
      enviadoEm: params.agora,
    });
    if (!confirmou) throw new Error('reserva promocional não pôde ser confirmada');

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'campaign.sent',
      entity: 'customers',
      entityId: params.customerId,
      after: { tipo, avulsa: true },
    });
  });

  return { enviado: true, wamid, motivo: null };
}
