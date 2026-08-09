import { semTenant, type TransactionClient } from '@barbearia/db';
import { enfileirarPara } from '@barbearia/jobs';
import { proximoPassoDaRegua, type EstadoDaFatura, type PassoDaRegua } from '@barbearia/core';
import { PlataformaError, marcarCiclo, registrarNaTrilha } from './plataforma.js';

/**
 * A cobrança da assinatura (bloco 28, SPEC §9).
 *
 * ## O desenho em três camadas, e por que são três
 *
 * - **`packages/core/src/cobranca.ts`** decide *quando*: quando avisar, quando
 *   marcar vencida, quando retentar, quando bloquear. Puro, com o relógio por
 *   parâmetro — a régua inteira é conferível sem banco e sem esperar o mês
 *   virar.
 * - **este arquivo** faz *o quê*: lê o estado, chama a decisão, grava o
 *   resultado e enfileira o aviso na mesma transação.
 * - **o provedor** tenta *cobrar de verdade*. É abstração porque teste de régua
 *   não pode depender de rede, e porque o adquirente escolhido — a Stripe —
 *   entra por configuração (`PSP_MODO`), não por `new` espalhado.
 *
 * ## Cobrança é adiantada, e é isso que ordena o resto
 *
 * A fatura cobre o período **seguinte**: emitida às vésperas do fim do período
 * em curso, vence cinco dias depois de ele começar, e é o pagamento dela que
 * empurra a assinatura para o período novo. Sem isso o teste de catorze dias
 * viraria catorze dias grátis mais uma fatura pelos catorze dias — cobrar
 * depois de entregar é o que produz esse absurdo, e é fácil de escrever sem
 * perceber.
 *
 * ## A régua roda sem tenant, e é isso que a torna possível
 *
 * "Quem venceu hoje?" atravessa todas as barbearias, e `invoices` foi desenhada
 * para isso: leitura da plataforma sem tenant, escrita só sem tenant. É o mesmo
 * desenho de `subscriptions` — uma barbearia que escrevesse aqui se daria baixa
 * sozinha.
 */

export type MetodoDePagamento = 'manual' | 'card' | 'pix' | 'boleto';

/**
 * O motivo escrito no bloqueio automático.
 *
 * Constante e não texto montado: é ele que distingue o bloqueio da régua do
 * bloqueio posto por gente, e é a condição que impede o pagamento de uma fatura
 * de destrancar uma conta bloqueada por fraude.
 */
export const MOTIVO_DO_BLOQUEIO = 'Assinatura vencida há mais de 21 dias';

/** Dias de prazo entre o início do período cobrado e o vencimento da fatura. */
const DIAS_DE_PRAZO = 5;

/** Quantos dias antes do fim do período a fatura seguinte é emitida. */
const ANTECEDENCIA_DA_EMISSAO_DIAS = 3;

/** O tamanho do período de cobrança. Mensal, como o preço de tabela. */
const DIAS_DO_PERIODO = 30;

const DIA_MS = 86_400_000;

export interface Fatura {
  readonly id: string;
  readonly tenantId: string;
  readonly tipo: 'subscription' | 'proration';
  readonly estado: 'open' | 'paid' | 'void';
  readonly planoCode: string;
  readonly valorCents: number;
  readonly periodoInicio: Date;
  readonly periodoFim: Date;
  readonly vencimento: Date;
  readonly tentativas: number;
  readonly avisadaEm: Date | null;
  readonly vencidaEm: Date | null;
  readonly pagaEm: Date | null;
  readonly metodo: string | null;
  readonly canceladaEm: Date | null;
  readonly motivoDoCancelamento: string | null;
  /** A cobrança no adquirente, quando já existe uma em curso (bloco 29). */
  readonly chargeId: string | null;
  readonly criadaEm: Date;
}

interface LinhaDeFatura {
  id: string;
  tenant_id: string;
  kind: 'subscription' | 'proration';
  status: 'open' | 'paid' | 'void';
  plan_code: string;
  amount_cents: number;
  period_start: Date;
  period_end: Date;
  due_at: Date;
  attempts: number;
  notified_at: Date | null;
  past_due_at: Date | null;
  paid_at: Date | null;
  paid_method: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  idempotency_key: string | null;
  psp_charge_id: string | null;
  created_at: Date;
}

const paraFatura = (l: LinhaDeFatura): Fatura => ({
  id: l.id,
  tenantId: l.tenant_id,
  tipo: l.kind,
  estado: l.status,
  planoCode: l.plan_code,
  valorCents: l.amount_cents,
  periodoInicio: l.period_start,
  periodoFim: l.period_end,
  vencimento: l.due_at,
  tentativas: l.attempts,
  avisadaEm: l.notified_at,
  vencidaEm: l.past_due_at,
  pagaEm: l.paid_at,
  metodo: l.paid_method,
  canceladaEm: l.voided_at,
  motivoDoCancelamento: l.void_reason,
  chargeId: l.psp_charge_id,
  criadaEm: l.created_at,
});

/**
 * A tentativa de cobrar, que é a única parte com rede.
 *
 * Abstração como `NotificationProvider` e pelos mesmos dois motivos (CLAUDE.md
 * §4): o adquirente é bloqueio de fornecedor, e teste de régua não pode
 * depender de um sandbox de PSP no ar. O bloco 29 entregou o webhook e a
 * conciliação sobre esta interface, e o bloco 34 entregou a implementação
 * contra a **Stripe**. Ela só entra com `PSP_MODO=stripe`: sem a variável, o
 * caminho que **de fato** quita uma fatura continua sendo o Super Admin
 * registrando o pagamento que viu no extrato, que é como toda operação pequena
 * começa.
 */
export interface CobrancaProvider {
  cobrar(pedido: {
    readonly tenantId: string;
    readonly faturaId: string;
    readonly valorCents: number;
    readonly tentativa: number;
  }): Promise<ResultadoDaCobranca>;
}

export type ResultadoDaCobranca =
  | { readonly pago: true; readonly metodo: MetodoDePagamento }
  | {
      readonly pago: false;
      readonly motivo: string;
      /**
       * A cobrança saiu e a resposta vem depois (bloco 29).
       *
       * Cartão responde na hora; Pix e boleto não. Sem esta distinção, todo Pix
       * emitido gastaria um degrau da escada de retentativa, e a barbearia
       * seria suspensa por um pagamento que estava a caminho.
       */
      readonly aguardando?: boolean;
    };

/**
 * O provedor de mentira: recusa por padrão.
 *
 * Recusar é o padrão certo. Um fake que aprovasse faria toda fatura ser quitada
 * na primeira retentativa, e a régua — vencimento, escada, bloqueio — nunca
 * seria exercida por teste nenhum.
 */
export class FakeCobrancaProvider implements CobrancaProvider {
  readonly tentativas: { tenantId: string; faturaId: string; valorCents: number }[] = [];
  aprovarProxima = false;

  async cobrar(pedido: {
    readonly tenantId: string;
    readonly faturaId: string;
    readonly valorCents: number;
    readonly tentativa: number;
  }): Promise<ResultadoDaCobranca> {
    this.tentativas.push({
      tenantId: pedido.tenantId,
      faturaId: pedido.faturaId,
      valorCents: pedido.valorCents,
    });
    if (this.aprovarProxima) {
      this.aprovarProxima = false;
      return { pago: true, metodo: 'card' };
    }
    return { pago: false, motivo: 'cartão recusado' };
  }
}

/**
 * O provedor de quem ainda não tem PSP: nada é debitado automaticamente.
 *
 * É o que o worker usa até o bloco 29, e **não** é um fake disfarçado — é a
 * descrição honesta de como a plataforma cobra hoje: o dono paga por
 * transferência e alguém registra a baixa no painel. A régua continua inteira
 * em cima disso (emite, avisa, marca vencida, suspende), que é exatamente como
 * operação pequena funciona antes de integrar adquirente.
 *
 * O motivo escrito aparece na trilha e no aviso, para que "não passou" nunca
 * seja confundido com "o cartão foi recusado".
 */
export class CobrancaManualProvider implements CobrancaProvider {
  async cobrar(): Promise<ResultadoDaCobranca> {
    return { pago: false, motivo: 'sem débito automático: aguardando pagamento' };
  }
}

// ---------------------------------------------------------------------------
// Emissão
// ---------------------------------------------------------------------------

/**
 * Emite a fatura do **próximo** período da barbearia.
 *
 * Idempotente pelo índice `invoices_uma_por_periodo`, não por um `SELECT` antes
 * do `INSERT`: a régua roda todo dia, pode rodar duas vezes no mesmo dia, e a
 * janela entre consultar e inserir é onde nasce a segunda cobrança do mesmo mês.
 *
 * **O crédito da descida de plano abate aqui**, e é o único lugar em que ele é
 * consumido. Guardá-lo na assinatura em vez de emitir fatura negativa foi
 * decisão da migração 0030: fatura negativa é documento que ninguém sabe pagar.
 *
 * Devolve `null` quando não há o que emitir — cancelada, preço zero
 * (Enterprise, que é negociado fora) ou fatura do período já existente. Não é
 * erro: a régua chama isto para todo mundo, todo dia.
 */
export async function emitirFatura(entrada: {
  readonly tenantId: string;
  readonly agora: Date;
}): Promise<Fatura | null> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        plan_code: string;
        price_cents: number;
        status: string;
        period_end: Date;
        credit_cents: number;
      }[]
    >`
      SELECT plan_code, price_cents, status::text, period_end, credit_cents
        FROM subscriptions WHERE tenant_id = ${entrada.tenantId}::uuid
    `;
    const assinatura = linhas[0];
    if (!assinatura) throw new PlataformaError('unknown_tenant', 'Barbearia não encontrada');
    if (assinatura.status === 'canceled') return null;
    // Preço zero é o Enterprise: "não tem preço de tabela", não "é de graça".
    // Emitir R$ 0,00 produziria um documento que não se paga e uma régua que o
    // persegue até bloquear uma franquia que está em dia.
    if (assinatura.price_cents === 0) return null;

    const inicio = assinatura.period_end;
    const fim = new Date(inicio.getTime() + DIAS_DO_PERIODO * DIA_MS);
    const vencimento = new Date(inicio.getTime() + DIAS_DE_PRAZO * DIA_MS);

    const abatido = Math.max(0, assinatura.price_cents - assinatura.credit_cents);
    const creditoUsado = assinatura.price_cents - abatido;

    const criadas = await tx.$queryRaw<LinhaDeFatura[]>`
      INSERT INTO invoices (tenant_id, kind, plan_code, amount_cents,
                            period_start, period_end, due_at)
      VALUES (${entrada.tenantId}::uuid, 'subscription', ${assinatura.plan_code},
              ${abatido}, ${inicio}, ${fim}, ${vencimento})
      ON CONFLICT (tenant_id, period_start) WHERE kind = 'subscription' DO NOTHING
      RETURNING id, tenant_id, kind, status, plan_code, amount_cents, period_start,
                period_end, due_at, attempts, notified_at, past_due_at, paid_at,
                paid_method, voided_at, void_reason, idempotency_key, psp_charge_id, created_at
    `;
    const criada = criadas[0];
    if (!criada) return null;

    if (creditoUsado > 0) {
      await tx.$executeRaw`
        UPDATE subscriptions SET credit_cents = credit_cents - ${creditoUsado}, updated_at = now()
         WHERE tenant_id = ${entrada.tenantId}::uuid
      `;
    }

    await avisar(tx, paraFatura(criada), 'emitida');
    return paraFatura(criada);
  });
}

/**
 * Emite uma cobrança avulsa — hoje, só o acerto da troca de plano.
 *
 * Vencimento curto de propósito: o acerto é do período que já está correndo, e
 * um prazo de trinta dias faria a fatura de rateio vencer depois do período que
 * ela cobra.
 */
export async function emitirRateio(entrada: {
  readonly tx: TransactionClient;
  readonly tenantId: string;
  readonly planoCode: string;
  readonly valorCents: number;
  readonly periodoInicio: Date;
  readonly periodoFim: Date;
  readonly agora: Date;
  readonly idempotencyKey?: string | undefined;
}): Promise<Fatura> {
  const vencimento = new Date(entrada.agora.getTime() + DIAS_DE_PRAZO * DIA_MS);
  const criadas = await entrada.tx.$queryRaw<LinhaDeFatura[]>`
    INSERT INTO invoices (tenant_id, kind, plan_code, amount_cents,
                          period_start, period_end, due_at, idempotency_key)
    VALUES (${entrada.tenantId}::uuid, 'proration', ${entrada.planoCode},
            ${entrada.valorCents}, ${entrada.periodoInicio}, ${entrada.periodoFim},
            ${vencimento}, ${entrada.idempotencyKey ?? null})
    RETURNING id, tenant_id, kind, status, plan_code, amount_cents, period_start,
              period_end, due_at, attempts, notified_at, past_due_at, paid_at,
              paid_method, voided_at, void_reason, idempotency_key, psp_charge_id, created_at
  `;
  const criada = criadas[0];
  if (!criada) throw new PlataformaError('invoice_failed', 'Não foi possível emitir o acerto');
  await avisar(entrada.tx, paraFatura(criada), 'emitida');
  return paraFatura(criada);
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

const SELECT_DA_FATURA = (linhas: LinhaDeFatura[]): readonly Fatura[] => linhas.map(paraFatura);

export async function faturasDaBarbearia(tenantId: string): Promise<readonly Fatura[]> {
  return semTenant(async (tx) =>
    SELECT_DA_FATURA(
      await tx.$queryRaw<LinhaDeFatura[]>`
        SELECT id, tenant_id, kind, status, plan_code, amount_cents, period_start,
               period_end, due_at, attempts, notified_at, past_due_at, paid_at,
               paid_method, voided_at, void_reason, idempotency_key, psp_charge_id, created_at
          FROM invoices WHERE tenant_id = ${tenantId}::uuid
         ORDER BY created_at DESC
         LIMIT 60
      `,
    ),
  );
}

/** As que ainda estão em cobrança, da mais atrasada — é a fila do suporte. */
export async function faturasEmCobranca(): Promise<readonly Fatura[]> {
  return semTenant(async (tx) =>
    SELECT_DA_FATURA(
      await tx.$queryRaw<LinhaDeFatura[]>`
        SELECT id, tenant_id, kind, status, plan_code, amount_cents, period_start,
               period_end, due_at, attempts, notified_at, past_due_at, paid_at,
               paid_method, voided_at, void_reason, idempotency_key, psp_charge_id, created_at
          FROM invoices WHERE status = 'open'
         ORDER BY due_at
         LIMIT 500
      `,
    ),
  );
}

// ---------------------------------------------------------------------------
// Encerramento de fatura
// ---------------------------------------------------------------------------

/**
 * Dá baixa numa fatura.
 *
 * `adminId` nulo é a régua registrando o que o provedor aprovou; preenchido é
 * gente registrando o que viu no extrato. Os dois caminhos escrevem a mesma
 * trilha, e é ela que responde "quem deu esta fatura por paga".
 */
export async function pagarFatura(entrada: {
  readonly adminId: string | null;
  readonly faturaId: string;
  readonly metodo: MetodoDePagamento;
}): Promise<{ readonly tenantId: string }> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<LinhaDeFatura[]>`
      UPDATE invoices
         SET status = 'paid', paid_at = now(), paid_method = ${entrada.metodo}, updated_at = now()
       WHERE id = ${entrada.faturaId}::uuid AND status = 'open'
      RETURNING id, tenant_id, kind, status, plan_code, amount_cents, period_start,
                period_end, due_at, attempts, notified_at, past_due_at, paid_at,
                paid_method, voided_at, void_reason, idempotency_key, psp_charge_id, created_at
    `;
    const fatura = linhas[0];
    if (!fatura) throw new PlataformaError('not_payable', 'Fatura inexistente ou já encerrada');

    await registrarNaTrilha(tx, entrada.adminId, fatura.tenant_id, 'invoice.paid', {
      faturaId: entrada.faturaId,
      valorCents: fatura.amount_cents,
      metodo: entrada.metodo,
    });

    await encerrar(tx, fatura);
    return { tenantId: fatura.tenant_id };
  });
}

/**
 * Cancela a fatura — erro de emissão, cortesia, acordo comercial.
 *
 * Cancelar **não** é dar por paga, e a diferença aparece no relatório: numa
 * entrou dinheiro, na outra não. Misturar as duas faria a receita da plataforma
 * incluir o que ela perdoou.
 *
 * O que as duas têm em comum é o efeito no acesso: perdoada ou paga, a
 * barbearia deixa de dever aquele período. Uma cortesia que não avançasse o
 * período deixaria a régua reemitindo a mesma fatura para sempre.
 */
export async function cancelarFatura(entrada: {
  readonly adminId: string;
  readonly faturaId: string;
  readonly motivo: string;
}): Promise<{ readonly tenantId: string }> {
  const motivo = entrada.motivo.trim();
  if (motivo.length < 3) {
    throw new PlataformaError('reason_required', 'Escreva o motivo do cancelamento');
  }

  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<LinhaDeFatura[]>`
      UPDATE invoices
         SET status = 'void', voided_at = now(), void_reason = ${motivo}, updated_at = now()
       WHERE id = ${entrada.faturaId}::uuid AND status = 'open'
      RETURNING id, tenant_id, kind, status, plan_code, amount_cents, period_start,
                period_end, due_at, attempts, notified_at, past_due_at, paid_at,
                paid_method, voided_at, void_reason, idempotency_key, psp_charge_id, created_at
    `;
    const fatura = linhas[0];
    if (!fatura) throw new PlataformaError('not_voidable', 'Fatura inexistente ou já encerrada');

    await registrarNaTrilha(tx, entrada.adminId, fatura.tenant_id, 'invoice.voided', {
      faturaId: entrada.faturaId,
      valorCents: fatura.amount_cents,
      motivo,
    });

    await encerrar(tx, fatura);
    return { tenantId: fatura.tenant_id };
  });
}

/**
 * O que acontece quando uma fatura deixa de estar aberta.
 *
 * Duas coisas, e as duas condicionais:
 *
 * 1. **A mensalidade encerrada empurra o período.** Só a de mensalidade — o
 *    acerto de rateio é do período que já está correndo e avançá-lo daria um
 *    mês de brinde a quem trocou de plano.
 * 2. **Sem nenhuma fatura aberta, a barbearia volta ao normal.** Sai de
 *    `past_due` e o bloqueio da régua é desfeito. Bloqueio posto por gente
 *    (fraude, pedido judicial, abuso) **não** é desfeito aqui: quem o pôs
 *    escreveu um motivo, e a régua não tem como saber se ele acabou. É por isso
 *    que a condição olha `blocked_reason`, e não só `blocked_at`.
 */
async function encerrar(tx: TransactionClient, fatura: LinhaDeFatura): Promise<void> {
  if (fatura.kind === 'subscription') {
    await tx.$executeRaw`
      UPDATE subscriptions
         SET period_start = ${fatura.period_start}, period_end = ${fatura.period_end},
             updated_at = now()
       WHERE tenant_id = ${fatura.tenant_id}::uuid AND period_end <= ${fatura.period_start}
    `;
  }

  const pendentes = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM invoices
     WHERE tenant_id = ${fatura.tenant_id}::uuid AND status = 'open'
  `;
  if (Number(pendentes[0]?.n ?? 0) > 0) return;

  await tx.$executeRaw`
    UPDATE subscriptions SET status = 'active', updated_at = now()
     WHERE tenant_id = ${fatura.tenant_id}::uuid AND status IN ('past_due', 'trialing')
  `;

  const desbloqueadas = await tx.$executeRaw`
    UPDATE tenant_platform
       SET blocked_at = NULL, blocked_reason = NULL, updated_at = now()
     WHERE tenant_id = ${fatura.tenant_id}::uuid AND blocked_reason = ${MOTIVO_DO_BLOQUEIO}
  `;
  if (desbloqueadas > 0) {
    await registrarNaTrilha(tx, null, fatura.tenant_id, 'tenant.unblocked', { por: 'regua' });
    await marcarCiclo(tx, fatura.tenant_id, 'unblocked');
  }
}

// ---------------------------------------------------------------------------
// A régua
// ---------------------------------------------------------------------------

export interface ResultadoDaRegua {
  readonly emitidas: number;
  readonly avisadas: number;
  readonly vencidas: number;
  readonly cobradas: number;
  /** Cobranças que saíram e cuja resposta vem por webhook (bloco 29). */
  readonly aguardando: number;
  readonly pagas: number;
  readonly bloqueadas: number;
}

/**
 * Uma volta da régua.
 *
 * Roda uma vez por dia e é **reentrante**: rodar duas vezes no mesmo dia não
 * emite fatura repetida, não adianta a escada, não manda dois avisos e não
 * bloqueia mais cedo. Quem garante são o índice de emissão e as datas gravadas
 * na fatura (`notified_at`, `past_due_at`, `attempts`), lidas pela decisão pura
 * antes de cada passo.
 *
 * Um passo por fatura por volta, também de propósito: encadear "marcar vencida
 * e já retentar" faria a primeira retentativa sair no mesmo instante do
 * vencimento, o que não é o que a escada diz.
 */
export async function aplicarRegua(entrada: {
  readonly agora: Date;
  readonly provider: CobrancaProvider;
}): Promise<ResultadoDaRegua> {
  const contagem = {
    emitidas: 0,
    avisadas: 0,
    vencidas: 0,
    cobradas: 0,
    aguardando: 0,
    pagas: 0,
    bloqueadas: 0,
  };

  for (const tenantId of await aEmitir(entrada.agora)) {
    if (await emitirFatura({ tenantId, agora: entrada.agora })) contagem.emitidas += 1;
  }

  for (const fatura of await faturasEmCobranca()) {
    const estado: EstadoDaFatura = {
      status: fatura.estado,
      vencimento: fatura.vencimento,
      tentativas: fatura.tentativas,
      avisadaEm: fatura.avisadaEm,
      vencidaEm: fatura.vencidaEm,
    };
    const passo: PassoDaRegua = proximoPassoDaRegua(estado, entrada.agora);
    if (passo === 'nada') continue;

    if (passo === 'retentar') {
      /**
       * Cobrança em curso não vira segunda cobrança.
       *
       * A partir do bloco 29 a tentativa pode ficar pendente — Pix e boleto
       * respondem depois. Enquanto houver `psp_charge_id` amarrado, quem
       * resolve é o webhook (ou a conciliação, que é a rede). Insistir aqui
       * emitiria um Pix por dia para a mesma fatura.
       */
      if (fatura.chargeId) continue;

      /**
       * A cobrança acontece **fora** da transação, e é a única coisa neste
       * arquivo que sai da máquina.
       *
       * Segurar transação aberta esperando resposta de adquirente é o jeito
       * clássico de esgotar o pool: o tempo limite deles é de dezenas de
       * segundos e uma volta da régua tem centenas de faturas. O que a
       * transação faz depois é gravar o resultado, que é rápido.
       */
      const resultado = await entrada.provider.cobrar({
        tenantId: fatura.tenantId,
        faturaId: fatura.id,
        valorCents: fatura.valorCents,
        tentativa: fatura.tentativas + 1,
      });

      if (resultado.pago) {
        await pagarFatura({ adminId: null, faturaId: fatura.id, metodo: resultado.metodo });
        contagem.pagas += 1;
      } else if (resultado.aguardando) {
        /**
         * Saiu e ainda não voltou: marca a data e **não** gasta um degrau.
         *
         * Nem avisa o dono — "seu pagamento não passou" para quem acabou de
         * gerar um Pix é a mensagem que faz o próximo aviso ser ignorado.
         */
        await semTenant(async (tx) => {
          await tx.$executeRaw`
            UPDATE invoices SET last_attempt_at = ${entrada.agora}, updated_at = now()
             WHERE id = ${fatura.id}::uuid AND status = 'open'
          `;
        });
        contagem.aguardando += 1;
      } else {
        await semTenant(async (tx) => {
          await tx.$executeRaw`
            UPDATE invoices SET attempts = attempts + 1, last_attempt_at = ${entrada.agora},
                                updated_at = now()
             WHERE id = ${fatura.id}::uuid AND status = 'open'
          `;
          await avisar(tx, fatura, 'tentativa_recusada');
        });
        contagem.cobradas += 1;
      }
      continue;
    }

    await semTenant(async (tx) => {
      if (passo === 'avisar_vencimento') {
        await tx.$executeRaw`
          UPDATE invoices SET notified_at = ${entrada.agora}, updated_at = now()
           WHERE id = ${fatura.id}::uuid AND notified_at IS NULL
        `;
        await avisar(tx, fatura, 'vence_em_breve');
        contagem.avisadas += 1;
        return;
      }

      if (passo === 'marcar_vencida') {
        await tx.$executeRaw`
          UPDATE invoices SET past_due_at = ${entrada.agora}, updated_at = now()
           WHERE id = ${fatura.id}::uuid AND past_due_at IS NULL
        `;
        await tx.$executeRaw`
          UPDATE subscriptions SET status = 'past_due', updated_at = now()
           WHERE tenant_id = ${fatura.tenantId}::uuid AND status IN ('trialing', 'active')
        `;
        await avisar(tx, fatura, 'venceu');
        contagem.vencidas += 1;
        return;
      }

      const bloqueadas = await tx.$executeRaw`
        UPDATE tenant_platform
           SET blocked_at = ${entrada.agora}, blocked_reason = ${MOTIVO_DO_BLOQUEIO},
               updated_at = now()
         WHERE tenant_id = ${fatura.tenantId}::uuid AND blocked_at IS NULL
      `;
      if (bloqueadas > 0) {
        /**
         * `admin_id` nulo é a régua. Este é o único evento do produto que tira
         * uma empresa do ar sem ninguém ter clicado — sem a linha, a resposta
         * ao dono que liga perguntando por que a agenda sumiu seria "não sei".
         */
        await registrarNaTrilha(tx, null, fatura.tenantId, 'tenant.blocked', {
          motivo: MOTIVO_DO_BLOQUEIO,
          faturaId: fatura.id,
          por: 'regua',
        });
        await marcarCiclo(tx, fatura.tenantId, 'blocked');
        await avisar(tx, fatura, 'bloqueada');
        contagem.bloqueadas += 1;
      }
    });
  }

  return contagem;
}

/**
 * De quem a próxima fatura já pode ser emitida.
 *
 * Uma consulta, não um laço com ida ao banco por barbearia: a régua roda contra
 * a base inteira, e um N+1 aqui cresce com o número de clientes do produto.
 * O `NOT EXISTS` evita chamar `emitirFatura` para quem já tem a fatura do
 * período — o índice único garantiria a idempotência de qualquer jeito, mas a
 * consulta economiza uma transação por barbearia em dia.
 */
async function aEmitir(agora: Date): Promise<readonly string[]> {
  const corte = new Date(agora.getTime() + ANTECEDENCIA_DA_EMISSAO_DIAS * DIA_MS);
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ tenant_id: string }[]>`
      SELECT s.tenant_id
        FROM subscriptions s
       WHERE s.status <> 'canceled'
         AND s.price_cents > 0
         AND s.period_end <= ${corte}
         AND NOT EXISTS (
           SELECT 1 FROM invoices i
            WHERE i.tenant_id = s.tenant_id
              AND i.kind = 'subscription'
              AND i.period_start = s.period_end
         )
       ORDER BY s.period_end
       LIMIT 500
    `;
    return linhas.map((l) => l.tenant_id);
  });
}

export type AssuntoDoAviso =
  | 'emitida'
  | 'vence_em_breve'
  | 'venceu'
  | 'tentativa_recusada'
  | 'bloqueada';

/**
 * O aviso ao dono entra na fila **dentro** da transação que muda o estado.
 *
 * Regra do projeto e, aqui, a diferença entre avisar e não avisar: mandar
 * depois do commit cria a janela em que a barbearia foi bloqueada e ninguém
 * soube. O `payload` leva id e assunto, nunca conteúdo — `jobs` não tem RLS.
 */
async function avisar(
  tx: TransactionClient,
  fatura: Fatura,
  assunto: AssuntoDoAviso,
): Promise<void> {
  await enfileirarPara(tx, fatura.tenantId, {
    kind: 'cobranca.aviso',
    payload: { faturaId: fatura.id, assunto },
    // A chave é a fatura mais o assunto, e o índice de `jobs` é global — daí o
    // prefixo. A recusa leva o número da tentativa junto: cada uma é um aviso
    // legítimo, e sem o número a segunda recusa seria engolida pela primeira.
    idempotencyKey:
      assunto === 'tentativa_recusada'
        ? `cobranca:${fatura.id}:recusada:${fatura.tentativas + 1}`
        : `cobranca:${fatura.id}:${assunto}`,
  });
}
