import { horaCheia } from './ocupacao.js';
import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  MESES_DA_JANELA,
  POLITICA_SEM_SINAL,
  SCORE_QUE_DISPENSA_SINAL,
  decidirSinal,
  podeMarcarOnline,
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
  /**
   * O instante em que o serviço começa, para saber se a hora é de pico.
   *
   * Opcional porque nem todo caminho o tem em mãos — e ausente significa "não
   * consulte o pico", que é o comportamento anterior. Padrão de configuração
   * que mexe em dinheiro é sempre o que já valia.
   */
  readonly comecaEm?: Date;
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
  return withTenant(pedido.tenantId, (tx) => avaliarSinalEm(tx, pedido));
}

/**
 * A mesma avaliação, dentro de uma transação que já está aberta.
 *
 * É esta que a reserva usa. O sinal precisa ser decidido e gravado **na mesma
 * transação** que cria o agendamento: decidir antes deixaria a política mudar
 * entre a decisão e o INSERT, e decidir depois criaria a janela em que o
 * horário existe sem o sinal que ele exigia — e é justamente nessa janela que
 * o cliente fecha a tela.
 */
export async function avaliarSinalEm(
  tx: TransactionClient,
  pedido: PedidoDeAvaliacaoDeSinal,
): Promise<SinalDoAgendamento> {
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

  /**
   * O pico só é consultado quando pode mudar a resposta.
   *
   * A grade custa uma consulta de agregação sobre a agenda, e ela é inútil se o
   * cliente já tem histórico: o quarto termo só vale para cliente **novo**.
   * Perguntá-la sempre poria peso no caminho de reserva — que é o mais chamado
   * do produto — em troca de nada na maior parte das vezes.
   */
  const clienteNovoEmPico =
    !confianca.temEfeito && pedido.comecaEm
      ? await horaCheia(tx, pedido.locationId, pedido.comecaEm, pedido.now)
      : false;

  const decisao = decidirSinal({
    politica,
    confianca,
    ticketCents: pedido.ticketCents,
    servicoSempreExige: sempreExige,
    clienteNovoEmPico,
  });

  return { ...decisao, confianca };
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

// ---------------------------------------------------------------------------
// A recusa de marcação online em hora cheia (bloco 60, SPEC §2.13)
// ---------------------------------------------------------------------------

/** Os dois limiares que a unidade guarda. Nulo no primeiro é desligado. */
export async function limiaresDoScore(
  tx: TransactionClient,
  locationId: string,
): Promise<{ readonly bloqueioOnline: number | null; readonly confiavelNaEspera: number }> {
  const linhas = await tx.$queryRaw<
    { online_block_score: number | null; waitlist_trusted_score: number }[]
  >`
    SELECT online_block_score, waitlist_trusted_score
      FROM locations WHERE id = ${locationId}::uuid
  `;
  const linha = linhas[0];
  // Unidade inexistente ou de outra barbearia cai no desligado, pela mesma razão
  // de `politicaDeSinal`: quem chama está montando uma reserva, e ela não pode
  // ser recusada porque a configuração não foi encontrada.
  if (!linha) return { bloqueioOnline: null, confiavelNaEspera: SCORE_QUE_DISPENSA_SINAL };
  return {
    bloqueioOnline: linha.online_block_score,
    confiavelNaEspera: linha.waitlist_trusted_score,
  };
}

/**
 * Esta pessoa pode marcar sozinha este horário?
 *
 * Roda **dentro da transação que cria o agendamento**, como o sinal e pelo mesmo
 * motivo: entre a decisão e o `INSERT` o horário pode virar de pico — a grade é
 * derivada do movimento e o movimento muda — e a recusa precisa valer sobre o
 * que está sendo gravado, não sobre o que se leu antes.
 *
 * ## A leitura da grade é evitada quando não pode mudar a resposta
 *
 * A grade de ocupação é a consulta mais cara deste caminho, e ela só importa
 * quando a regra está ligada **e** o score já decide alguma coisa **e** está
 * abaixo do limiar. Nos outros casos a resposta é sim sem ir ao banco — é o
 * mesmo cuidado de `horaCheia`, no caminho mais chamado do produto.
 */
export async function conferirMarcacaoOnline(
  tx: TransactionClient,
  pedido: {
    readonly locationId: string;
    readonly customerId: string | null;
    readonly comecaEm: Date;
    readonly peloBalcao: boolean;
    readonly now: Date;
  },
): Promise<{ readonly pode: true } | { readonly pode: false; readonly score: number; readonly limiar: number }> {
  if (pedido.peloBalcao || !pedido.customerId) return { pode: true };

  const limiares = await limiaresDoScore(tx, pedido.locationId);
  if (limiares.bloqueioOnline === null) return { pode: true };

  const confianca = await confiancaDoCliente(tx, pedido.customerId, pedido.now);
  if (!confianca.temEfeito || confianca.score >= limiares.bloqueioOnline) return { pode: true };

  const decisao = podeMarcarOnline({
    confianca,
    limiar: limiares.bloqueioOnline,
    ehHorarioDePico: await horaCheia(tx, pedido.locationId, pedido.comecaEm, pedido.now),
    peloBalcao: false,
  });
  if (decisao.pode) return { pode: true };

  return { pode: false, score: confianca.score, limiar: limiares.bloqueioOnline };
}

/**
 * Registra a recusa, com o score congelado.
 *
 * Fora da transação da reserva de propósito: a reserva foi **recusada**, então
 * não há transação para carregar isto — e uma falha ao registrar não pode
 * transformar uma recusa explicada num erro genérico na tela do cliente.
 */
export async function registrarRecusaOnline(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly customerId: string;
  readonly score: number;
  readonly limiar: number;
  readonly comecaEm: Date;
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO online_blocks
        (tenant_id, location_id, customer_id, score, threshold, wanted_at)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.locationId}::uuid, ${params.customerId}::uuid,
        ${params.score}, ${params.limiar}, ${params.comecaEm}
      )
    `;
  });
}

/**
 * A confiabilidade de várias pessoas, **numa consulta** (bloco 60).
 *
 * A lista de espera pergunta isso de todo mundo que cabe na vaga, e uma ida ao
 * banco por candidato seria o N+1 dentro da transação do cancelamento — o
 * caminho em que a vaga precisa ser oferecida antes de outro cliente marcar
 * pelo site. Vazio devolve mapa vazio sem consultar nada.
 *
 * O score continua saindo de `packages/core`: o SQL carrega o histórico, a conta
 * é do domínio. Calculá-lo na consulta seria regra de negócio em SQL, onde o
 * teste não alcança e a faixa de janela não cabe.
 */
export async function confiancaDeVarios(
  tx: TransactionClient,
  customerIds: readonly string[],
  agora: Date,
): Promise<ReadonlyMap<string, Confiabilidade>> {
  const ids = [...new Set(customerIds)];
  if (ids.length === 0) return new Map();

  const desde = new Date(agora);
  desde.setUTCMonth(desde.getUTCMonth() - MESES_DA_JANELA);

  const linhas = await tx.$queryRaw<(LinhaDoHistorico & { customer_id: string })[]>`
    SELECT a.customer_id, a.service_starts_at, a.status::text AS status,
           a.cancelled_at, a.checked_in_at
      FROM appointments a
     WHERE a.customer_id = ANY(${ids}::uuid[])
       AND a.service_starts_at >= ${desde}
       AND a.service_starts_at <= ${agora}
     ORDER BY a.service_starts_at DESC
  `;

  const porCliente = new Map<string, AgendamentoNoHistorico[]>();
  for (const linha of linhas) {
    const desfecho = desfechoDe(linha);
    if (!desfecho) continue;
    const lista = porCliente.get(linha.customer_id) ?? [];
    lista.push({
      comecariaEm: linha.service_starts_at,
      desfecho,
      atrasoMinutos: atrasoDe(linha),
    });
    porCliente.set(linha.customer_id, lista);
  }

  // Quem não tem nenhuma linha entra igual: a presunção de boa-fé vale para
  // quem nunca veio, e deixá-lo fora do mapa faria o chamador ter que repetir
  // a regra 1 da SPEC §2.13 por conta própria.
  return new Map(ids.map((id) => [id, pontuacaoDeConfianca(porCliente.get(id) ?? [], agora)]));
}

/** Uma recusa registrada, para a tela do dono medir a regra. */
export interface RecusaNaTela {
  readonly id: string;
  readonly clienteNome: string | null;
  readonly score: number;
  readonly limiar: number;
  readonly quando: string;
  readonly queria: string;
}

/**
 * As recusas recentes.
 *
 * Existe para o dono **medir a regra que ligou**: sem ela, "abaixo de 40 não
 * marca online no pico" é um interruptor cujo efeito só aparece pela reclamação.
 * O score sai congelado da linha, não recalculado — a pergunta é "quem eu
 * recusei", não "quem eu recusaria hoje".
 */
export async function recusasRecentes(
  tenantId: string,
  limite = 30,
): Promise<readonly RecusaNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        nome: string | null;
        score: number;
        threshold: number;
        created_at: Date;
        wanted_at: Date;
      }[]
    >`
      SELECT b.id, c.name AS nome, b.score, b.threshold, b.created_at, b.wanted_at
        FROM online_blocks b
        LEFT JOIN customers c ON c.id = b.customer_id
       ORDER BY b.created_at DESC
       LIMIT ${limite}
    `;
    return linhas.map((l) => ({
      id: l.id,
      clienteNome: l.nome,
      score: l.score,
      limiar: l.threshold,
      quando: l.created_at.toISOString(),
      queria: l.wanted_at.toISOString(),
    }));
  });
}
