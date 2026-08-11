import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  MESES_DA_JANELA,
  POLITICA_SEM_SINAL,
  decidirSinal,
  pontuacaoDeConfianca,
  type AgendamentoNoHistorico,
  type Confiabilidade,
  type DecisaoDeSinal,
  type DesfechoDoAgendamento,
  type ModalidadeDeSinal,
  type PoliticaDeSinal,
} from '@barbearia/core';

/**
 * O sinal seletivo, do banco para a decisão (bloco 37).
 *
 * A regra inteira mora em `packages/core` e não sabe que existe banco. Aqui só
 * se carrega o estado — histórico, política da unidade, serviços — e se chama o
 * domínio. É a mesma divisão do resto do repositório.
 *
 * ## Uma consulta, não uma por agendamento
 *
 * O score é pedido **na marcação**, com o cliente esperando a grade carregar. O
 * histórico de doze meses sai numa consulta só, servida pelo índice que a
 * migração 0039 criou. Um laço com ida ao banco por agendamento seria o N+1 que
 * o CLAUDE.md §3 proíbe, e ele custaria justamente no momento mais sensível.
 */

/** Como o banco chama cada desfecho, traduzido para o que o score entende. */
interface LinhaDoHistorico {
  readonly service_starts_at: Date;
  readonly status: string;
  readonly cancelled_at: Date | null;
  readonly checked_in_at: Date | null;
}

const MS_POR_HORA = 3_600_000;
const MS_POR_MINUTO = 60_000;

/**
 * Traduz uma linha em desfecho.
 *
 * `rescheduled` fica de fora, e é decisão: aquele agendamento virou outro, que
 * está na mesma lista com o desfecho de verdade. Contá-lo somaria duas vezes a
 * mesma intenção do cliente — e o remarcado nunca tem desfecho próprio, então
 * entraria como um evento neutro diluindo a taxa de falta de quem falta.
 */
function desfechoDe(linha: LinhaDoHistorico): DesfechoDoAgendamento | null {
  switch (linha.status) {
    case 'completed':
      return 'compareceu';
    case 'no_show':
      return 'faltou';
    case 'cancelled_business':
      return 'cancelado_pela_casa';
    case 'cancelled_customer': {
      if (!linha.cancelled_at) {
        // Anterior à migração 0039, que passou a carimbar. "Não sei" pende para
        // o lado do cliente: tratar como cancelamento em cima da hora puniria
        // alguém por um registro que a casa não fez.
        return 'cancelou_cedo';
      }
      const horas =
        (linha.service_starts_at.getTime() - linha.cancelled_at.getTime()) / MS_POR_HORA;
      return horas < 4 ? 'cancelou_em_cima' : 'cancelou_cedo';
    }
    default:
      // `pending`, `confirmed`, `checked_in`, `waiting`, `in_progress` ainda não
      // aconteceram, e `rescheduled` virou outro agendamento.
      return null;
  }
}

/** Minutos de atraso na chegada. Nulo quando não houve chegada registrada. */
function atrasoDe(linha: LinhaDoHistorico): number | null {
  if (!linha.checked_in_at) return null;
  const minutos =
    (linha.checked_in_at.getTime() - linha.service_starts_at.getTime()) / MS_POR_MINUTO;
  return Math.max(0, Math.round(minutos));
}

/**
 * O histórico de doze meses, numa consulta.
 *
 * O recorte da janela é feito **no banco** e refeito no domínio. Não é
 * redundância: aqui ele existe para a consulta não trazer dez anos de linhas
 * pela rede; lá, para a regra de justiça 6 valer mesmo quando alguém chamar o
 * domínio com outra lista.
 */
export async function historicoDoCliente(
  tx: TransactionClient,
  customerId: string,
  agora: Date,
): Promise<readonly AgendamentoNoHistorico[]> {
  const desde = new Date(agora);
  desde.setUTCMonth(desde.getUTCMonth() - MESES_DA_JANELA);

  const linhas = await tx.$queryRaw<LinhaDoHistorico[]>`
    SELECT a.service_starts_at, a.status::text AS status, a.cancelled_at, a.checked_in_at
      FROM appointments a
     WHERE a.customer_id = ${customerId}::uuid
       AND a.service_starts_at >= ${desde}
       AND a.service_starts_at <= ${agora}
     ORDER BY a.service_starts_at DESC
  `;

  const historico: AgendamentoNoHistorico[] = [];
  for (const linha of linhas) {
    const desfecho = desfechoDe(linha);
    if (!desfecho) continue;
    historico.push({
      comecariaEm: linha.service_starts_at,
      desfecho,
      atrasoMinutos: atrasoDe(linha),
    });
  }
  return historico;
}

export interface ConfiancaDoCliente extends Confiabilidade {
  /** Verdadeiro quando o número veio de um override do gerente, não da fórmula. */
  readonly ajustadoAMao: boolean;
}

/**
 * O score do cliente, com o override do gerente por cima.
 *
 * O override existe para o que a fórmula não vê (SPEC §2.13, regra 7): o cliente
 * que faltou três vezes por causa de uma internação, e o que tem histórico
 * impecável e sumiu com a chave da barbearia. Ele **substitui** o cálculo, e
 * `ajustadoAMao` diz isso a quem consome — um número que a fórmula não explica
 * precisa poder ser identificado na tela.
 *
 * Um override sempre tem efeito, mesmo com menos de três agendamentos: quem o
 * escreveu conhecia o caso, e o mínimo de histórico existe para proteger de
 * **estatística rasa**, não da decisão de um gerente.
 */
export async function confiancaDoCliente(
  tx: TransactionClient,
  customerId: string,
  agora: Date,
): Promise<ConfiancaDoCliente> {
  const overrides = await tx.$queryRaw<{ reliability_override: number | null }[]>`
    SELECT reliability_override FROM customers WHERE id = ${customerId}::uuid
  `;
  const aMao = overrides[0]?.reliability_override ?? null;

  const historico = await historicoDoCliente(tx, customerId, agora);
  const calculado = pontuacaoDeConfianca(historico, agora);

  if (aMao === null) return { ...calculado, ajustadoAMao: false };
  return {
    score: aMao,
    considerados: calculado.considerados,
    temEfeito: true,
    ajustadoAMao: true,
  };
}

/** A política de sinal da unidade. */
export async function politicaDeSinal(
  tx: TransactionClient,
  locationId: string,
): Promise<PoliticaDeSinal> {
  const linhas = await tx.$queryRaw<
    {
      deposit_mode: ModalidadeDeSinal;
      deposit_fixed_cents: number;
      deposit_percent_bps: number;
      deposit_score_threshold: number;
      deposit_ticket_over_cents: number;
      deposit_refund_hours: number;
    }[]
  >`
    SELECT deposit_mode, deposit_fixed_cents, deposit_percent_bps,
           deposit_score_threshold, deposit_ticket_over_cents, deposit_refund_hours
      FROM locations WHERE id = ${locationId}::uuid
  `;
  const linha = linhas[0];
  // Unidade inexistente ou de outra barbearia (a RLS não a devolve) cai na
  // política que não cobra nada. Recusar seria mais estrito e pior: quem chama
  // isto está montando uma grade, e a grade não pode deixar de existir porque a
  // política não foi encontrada.
  if (!linha) return POLITICA_SEM_SINAL;

  return {
    modalidade: linha.deposit_mode,
    valorFixoCents: linha.deposit_fixed_cents,
    percentualBps: linha.deposit_percent_bps,
    limiarDeScore: linha.deposit_score_threshold,
    tetoSemSinalCents: linha.deposit_ticket_over_cents,
    horasParaReembolso: linha.deposit_refund_hours,
  };
}

export interface PedidoDeAvaliacaoDeSinal {
  readonly tenantId: string;
  readonly locationId: string;
  readonly customerId: string | null;
  readonly serviceIds: readonly string[];
  readonly ticketCents: number;
  readonly now: Date;
}

export interface SinalDoAgendamento extends DecisaoDeSinal {
  readonly confianca: ConfiancaDoCliente;
}

/**
 * Se este agendamento pede sinal, e quanto — com tudo carregado.
 *
 * ## Sem cliente identificado não há sinal
 *
 * O balcão marca para quem chegou sem cadastro, e o score de alguém que não
 * existe é o score de ninguém. Cobrar sinal ali seria cobrar de quem a
 * barbearia acabou de conhecer — o oposto do seletivo.
 */
export async function avaliarSinal(
  pedido: PedidoDeAvaliacaoDeSinal,
): Promise<SinalDoAgendamento> {
  return withTenant(pedido.tenantId, async (tx) => {
    const politica = await politicaDeSinal(tx, pedido.locationId);

    const semCliente: ConfiancaDoCliente = {
      score: 100,
      considerados: 0,
      temEfeito: false,
      ajustadoAMao: false,
    };

    if (!pedido.customerId || politica.modalidade === 'nenhum') {
      return { exigido: false, motivo: null, valorCents: 0, confianca: semCliente };
    }

    const [confianca, sempreExige] = await Promise.all([
      confiancaDoCliente(tx, pedido.customerId, pedido.now),
      algumServicoSempreExige(tx, pedido.serviceIds),
    ]);

    const decisao = decidirSinal({
      politica,
      confianca,
      ticketCents: pedido.ticketCents,
      servicoSempreExige: sempreExige,
    });

    return { ...decisao, confianca };
  });
}

/** Um `IN` só, não uma consulta por serviço. */
async function algumServicoSempreExige(
  tx: TransactionClient,
  serviceIds: readonly string[],
): Promise<boolean> {
  if (serviceIds.length === 0) return false;
  const linhas = await tx.$queryRaw<{ existe: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM services
       WHERE id = ANY(${[...serviceIds]}::uuid[])
         AND always_require_deposit
    ) AS existe
  `;
  return linhas[0]?.existe ?? false;
}
