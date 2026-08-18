import {
  EXPLICACAO_DE_NAO_DISPARAR,
  decidirDisparo,
  maskPhone,
  tipoDeCampanhaValido,
  type TipoDeNotificacao,
} from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import { audit } from '@barbearia/identity';

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
  | 'recusado';

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
 * `wamid` quando saiu pelo canal de verdade e `null` quando caiu no de reserva
 * — e as duas coisas são envio, não falha.
 */
export async function enviarMensagemAvulsa(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly customerId: string;
  readonly tipo: TipoDeNotificacao;
  readonly agora: Date;
  readonly timeZone: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly enviar: (destino: {
    readonly telefone: string;
    readonly clienteNome: string;
    readonly barbearia: string;
  }) => Promise<string | null>;
}): Promise<ResultadoDoEnvioAvulso> {
  if (!tipoDeCampanhaValido(params.tipo)) {
    throw new EnvioAvulsoError(
      'tipo_invalido',
      'Este texto não serve para mensagem avulsa: ele fala de um horário marcado.',
    );
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
                 AND (n.sent_at AT TIME ZONE 'UTC')::date
                   = (${params.agora}::timestamptz AT TIME ZONE 'UTC')::date) AS hoje,
             (SELECT count(*) FROM notifications n
               WHERE n.customer_id = c.id AND n.status = 'sent'
                 AND n.sent_at > ${params.agora}::timestamptz - interval '30 days') AS no_mes,
             EXISTS (SELECT 1 FROM whatsapp_templates t
                      WHERE t.location_id = ${params.locationId}::uuid
                        AND t.kind = ${params.tipo}::notification_kind
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
    tipo: params.tipo,
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
  const wamid = await params.enviar({
    telefone,
    clienteNome: dados.nome ?? 'cliente',
    barbearia: dados.barbearia,
  });

  /**
   * A linha em `notifications` é o que faz esta mensagem **contar** no teto.
   *
   * Sem ela o envio avulso seria o furo do teto do mês: quatro pelo motor e
   * quantas quisessem pelo balcão, com a Meta somando todas do lado dela.
   */
  await withTenant(params.tenantId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO notifications (tenant_id, kind, customer_id, status, phone_masked)
      VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
              ${params.tipo}::notification_kind, ${params.customerId}::uuid,
              'sent', ${maskPhone(telefone)})
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'campaign.sent',
      entity: 'customers',
      entityId: params.customerId,
      after: { tipo: params.tipo, avulsa: true },
    });
  });

  return { enviado: true, wamid, motivo: null };
}
