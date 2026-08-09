import { semTenant, type TransactionClient } from '@barbearia/db';
import { PlataformaError, registrarNaTrilha } from './plataforma.js';
import { faturasEmCobranca, pagarFatura } from './cobranca.js';
import { EstornoRecusado, type EstadoDaCobranca, type PspProvider } from './psp.js';

/**
 * A conciliação (bloco 29, SPEC §9.1).
 *
 * ## Webhook é a fonte da verdade; polling é a rede de segurança
 *
 * A regra é do CLAUDE.md e as duas metades importam. O webhook chega em
 * segundos e é o caminho normal — esperar o polling faria o dono ver "em
 * aberto" por horas depois de pagar. Mas webhook se perde: proxy fora do ar,
 * deploy no meio da entrega, resposta 500 que o adquirente desiste de repetir.
 * Sem a rede, uma fatura paga ficaria aberta até alguém reclamar — e a régua do
 * bloco 28 suspenderia uma barbearia adimplente.
 *
 * ## E as duas escrevem pelo mesmo caminho
 *
 * `aplicarEvento` é a única função que muda o estado de uma fatura por conta do
 * adquirente, e ela é chamada tanto pelo webhook quanto pelo polling. Duas
 * implementações divergiriam no primeiro ajuste, e a divergência aqui é
 * "pagamento contado duas vezes".
 *
 * ## Quem carrega a idempotência, de verdade
 *
 * A **máquina de estados**, e vale escrever porque a primeira versão deste
 * arquivo afirmava outra coisa. Quebrar a chave de `psp_events` de propósito
 * deixou todos os testes de reentrega verdes: depois de `charge.paid` a fatura
 * está `paid` e a segunda entrega esbarra no estado; depois de `charge.failed`
 * o `psp_charge_id` foi limpo e a segunda entrega não encontra a fatura.
 *
 * `psp_events` continua valendo por duas razões que não são essa: ela é a
 * trilha do que o adquirente disse e quando — o que se abre numa divergência de
 * valor —, e é a trava para a entrega **concorrente**, em que as duas passariam
 * pela consulta antes de qualquer uma escrever. Esta segunda não tem teste:
 * o pool serializa as transações e o caso não se reproduz aqui.
 */

export type TipoDeEvento = 'charge.paid' | 'charge.failed' | 'charge.pending';

export interface EventoDoPsp {
  readonly eventoId: string;
  readonly tipo: TipoDeEvento;
  readonly chargeId: string;
  readonly payload: Record<string, unknown>;
}

export type DesfechoDoEvento = 'paid' | 'failed' | 'ignored';

/**
 * Aplica um evento do adquirente, uma vez só.
 *
 * Devolve `ignored` quando o evento já tinha sido aplicado ou quando não há
 * fatura aberta correspondente. As duas coisas são normais e nenhuma é erro: o
 * adquirente reentrega por desenho, e um evento sobre fatura já quitada é
 * exatamente o que a reentrega produz.
 */
export async function aplicarEvento(evento: EventoDoPsp): Promise<DesfechoDoEvento> {
  const novo = await semTenant(async (tx) => registrarEvento(tx, evento));
  // A chave primária é a trava. Já registrado é entrega repetida, e a única
  // resposta certa é não fazer nada de novo.
  if (!novo) return 'ignored';

  const alvo = await semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string; tenant_id: string; status: string }[]>`
      SELECT id, tenant_id, status::text FROM invoices
       WHERE psp_charge_id = ${evento.chargeId}
    `;
    return linhas[0] ?? null;
  });

  if (!alvo || alvo.status !== 'open') {
    await encerrarEvento(evento.eventoId, alvo?.tenant_id ?? null, alvo?.id ?? null, 'ignored');
    return 'ignored';
  }

  if (evento.tipo === 'charge.paid') {
    await pagarFatura({ adminId: null, faturaId: alvo.id, metodo: 'card' });
    await encerrarEvento(evento.eventoId, alvo.tenant_id, alvo.id, 'paid');
    return 'paid';
  }

  if (evento.tipo === 'charge.failed') {
    /**
     * A recusa **solta a fatura** para a próxima tentativa.
     *
     * Enquanto houver `psp_charge_id`, a régua não retenta — é o que impede um
     * Pix por dia. Limpar aqui é o que devolve a fatura para a escada, agora
     * com um degrau a menos.
     */
    await semTenant(async (tx) => {
      await tx.$executeRaw`
        UPDATE invoices
           SET attempts = attempts + 1, psp_charge_id = NULL, updated_at = now()
         WHERE id = ${alvo.id}::uuid AND status = 'open'
      `;
      await registrarNaTrilha(tx, null, alvo.tenant_id, 'invoice.charge_failed', {
        faturaId: alvo.id,
        chargeId: evento.chargeId,
      });
    });
    await encerrarEvento(evento.eventoId, alvo.tenant_id, alvo.id, 'failed');
    return 'failed';
  }

  await encerrarEvento(evento.eventoId, alvo.tenant_id, alvo.id, 'ignored');
  return 'ignored';
}

/**
 * Grava o evento. `false` quer dizer "este id já passou por aqui".
 *
 * `ON CONFLICT DO NOTHING` sobre a chave primária, e não um `SELECT` antes: a
 * reentrega do adquirente é concorrente com a original mais vezes do que se
 * imagina, e a janela entre consultar e inserir é onde nasce o pagamento
 * contado duas vezes.
 */
async function registrarEvento(tx: TransactionClient, evento: EventoDoPsp): Promise<boolean> {
  const gravadas = await tx.$executeRaw`
    INSERT INTO psp_events (event_id, type, payload)
    VALUES (${evento.eventoId}, ${evento.tipo}, ${JSON.stringify(evento.payload)}::jsonb)
    ON CONFLICT (event_id) DO NOTHING
  `;
  return gravadas > 0;
}

async function encerrarEvento(
  eventoId: string,
  tenantId: string | null,
  faturaId: string | null,
  desfecho: DesfechoDoEvento,
): Promise<void> {
  await semTenant(async (tx) => {
    await tx.$executeRaw`
      UPDATE psp_events
         SET processed_at = now(), outcome = ${desfecho},
             tenant_id = ${tenantId}::uuid, invoice_id = ${faturaId}::uuid
       WHERE event_id = ${eventoId}
    `;
  });
}

const TIPO_DE: Readonly<Record<EstadoDaCobranca, TipoDeEvento>> = {
  paga: 'charge.paid',
  recusada: 'charge.failed',
  pendente: 'charge.pending',
};

export interface ResultadoDaConciliacao {
  readonly consultadas: number;
  readonly pagas: number;
  readonly recusadas: number;
}

/**
 * A rede de segurança: pergunta ao adquirente o que houve com o que está em
 * curso.
 *
 * Só faturas abertas **com cobrança amarrada**: sem `psp_charge_id` não há o
 * que perguntar, e a régua já cuida delas. Uma consulta por cobrança em curso,
 * e não uma por fatura aberta — a diferença aparece no dia em que houver mil
 * barbearias e cinquenta cobranças pendentes.
 *
 * O id do evento sintético é `recon:<chargeId>:<estado>`. Determinístico de
 * propósito: se o webhook já contou a mesma coisa, o `ON CONFLICT` engole, e
 * duas voltas da conciliação sobre o mesmo estado também.
 */
export async function conciliarPendentes(entrada: {
  readonly provider: PspProvider;
}): Promise<ResultadoDaConciliacao> {
  const abertas = (await faturasEmCobranca()).filter((f) => f.chargeId !== null);
  const contagem = { consultadas: 0, pagas: 0, recusadas: 0 };

  for (const fatura of abertas) {
    const chargeId = fatura.chargeId;
    if (!chargeId) continue;

    // Fora de transação, como toda ida ao adquirente: segurar conexão de banco
    // esperando rede é o jeito clássico de esgotar o pool.
    const estado = await entrada.provider.consultar(chargeId);
    contagem.consultadas += 1;
    if (estado === 'pendente') continue;

    const desfecho = await aplicarEvento({
      eventoId: `recon:${chargeId}:${estado}`,
      tipo: TIPO_DE[estado],
      chargeId,
      payload: { origem: 'conciliacao' },
    });
    if (desfecho === 'paid') contagem.pagas += 1;
    if (desfecho === 'failed') contagem.recusadas += 1;
  }

  return contagem;
}

// ---------------------------------------------------------------------------
// Estorno
// ---------------------------------------------------------------------------

export interface Estorno {
  readonly id: string;
  readonly tenantId: string;
  readonly valorCents: number;
  readonly motivo: string;
  readonly estado: 'pending' | 'done' | 'failed';
  readonly criadoEm: Date;
}

/**
 * Devolve em dinheiro o crédito que a descida de plano gerou.
 *
 * A lacuna que o bloco 28 declarou: lá o crédito só sabia abater a próxima
 * mensalidade, porque devolver exige adquirente.
 *
 * ## O que este código recusa a fazer
 *
 * **Estornar mais do que existe de crédito.** O saldo é debitado na **mesma
 * transação** que cria o lançamento, com a subtração condicionada ao saldo
 * atual — `credit_cents >= valor`. Sem isso, dois pedidos simultâneos leriam o
 * mesmo saldo e devolveriam o dobro; o `CHECK (credit_cents >= 0)` da migração
 * 0030 seria a última linha de defesa, e chegar até ele já é ter perdido.
 *
 * O pedido ao adquirente sai **depois** do commit, de propósito. Uma chamada de
 * rede dentro da transação a manteria aberta por dezenas de segundos, e o pior
 * caso do desenho atual — estorno gravado como `pending` que o adquirente
 * recusou — é visível e retomável. O contrário (dinheiro devolvido sem
 * lançamento) não é.
 */
export async function estornarCredito(entrada: {
  readonly adminId: string;
  readonly tenantId: string;
  readonly valorCents: number;
  readonly motivo: string;
  readonly provider: PspProvider;
}): Promise<Estorno> {
  const motivo = entrada.motivo.trim();
  if (motivo.length < 3) {
    throw new PlataformaError('reason_required', 'Escreva o motivo do estorno');
  }
  if (!Number.isInteger(entrada.valorCents) || entrada.valorCents <= 0) {
    throw new PlataformaError('invalid_amount', 'O valor do estorno tem que ser positivo');
  }

  const conta = await semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ psp_customer_id: string }[]>`
      SELECT psp_customer_id FROM billing_customers WHERE tenant_id = ${entrada.tenantId}::uuid
    `;
    return linhas[0] ?? null;
  });
  if (!conta) {
    throw new PlataformaError('no_payment_method', 'Esta barbearia não tem conta no adquirente');
  }

  /**
   * De qual cobrança o dinheiro sai — decidido **antes** de debitar o crédito.
   *
   * Adquirente nenhum estorna "da conta": ele estorna uma cobrança. Descobrir
   * isso depois do débito seria descobrir com o saldo da barbearia já reduzido
   * e nada a caminho dela. Por isso a pergunta vem primeiro, e a ausência de
   * resposta é recusa e não tentativa.
   *
   * A escolhida é a **última fatura paga**, que é a que ainda está dentro da
   * janela de estorno de qualquer adquirente. Filtra `<> ''` porque a versão
   * anterior de `amarrarCobranca` deixava esse rastro em fatura recusada.
   */
  const cobranca = await semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ psp_charge_id: string }[]>`
      SELECT psp_charge_id FROM invoices
       WHERE tenant_id = ${entrada.tenantId}::uuid
         AND status = 'paid'
         AND psp_charge_id IS NOT NULL AND psp_charge_id <> ''
       ORDER BY paid_at DESC NULLS LAST
       LIMIT 1
    `;
    return linhas[0] ?? null;
  });
  if (!cobranca) {
    throw new PlataformaError(
      'no_charge_to_refund',
      'Não há cobrança paga no adquirente para estornar',
    );
  }

  const lancamento = await semTenant(async (tx) => {
    const debitadas = await tx.$executeRaw`
      UPDATE subscriptions
         SET credit_cents = credit_cents - ${entrada.valorCents}, updated_at = now()
       WHERE tenant_id = ${entrada.tenantId}::uuid AND credit_cents >= ${entrada.valorCents}
    `;
    if (debitadas === 0) {
      throw new PlataformaError('insufficient_credit', 'O crédito disponível é menor que o pedido');
    }

    const criados = await tx.$queryRaw<
      { id: string; tenant_id: string; amount_cents: number; reason: string; created_at: Date }[]
    >`
      INSERT INTO refunds (tenant_id, amount_cents, reason, admin_id)
      VALUES (${entrada.tenantId}::uuid, ${entrada.valorCents}, ${motivo}, ${entrada.adminId}::uuid)
      RETURNING id, tenant_id, amount_cents, reason, created_at
    `;
    const criado = criados[0];
    if (!criado) throw new PlataformaError('refund_failed', 'Não foi possível registrar o estorno');

    await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'credit.refunded', {
      estornoId: criado.id,
      valorCents: entrada.valorCents,
      motivo,
    });

    return criado;
  });

  let refundId: string;
  try {
    ({ refundId } = await entrada.provider.estornar({
      tenantId: entrada.tenantId,
      pspCustomerId: conta.psp_customer_id,
      pspChargeId: cobranca.psp_charge_id,
      valorCents: entrada.valorCents,
      estornoId: lancamento.id,
    }));
  } catch (erro) {
    /**
     * Recusa definitiva devolve o crédito; indisponibilidade não.
     *
     * `EstornoRecusado` é o adquirente dizendo que **nada saiu** da conta — a
     * cobrança não existe, já foi estornada, o valor não cabe. Deixar o crédito
     * debitado nesse caso é a barbearia perdendo saldo por um estorno que
     * jamais aconteceu.
     *
     * Qualquer outra falha fica como está, e é de propósito: 5xx e queda de
     * rede são ambíguos — o estorno pode ter sido feito e a resposta ter se
     * perdido. Devolver o crédito aí pagaria a barbearia duas vezes. O
     * lançamento continua `pending`, que é visível e retomável.
     */
    if (erro instanceof EstornoRecusado) {
      await semTenant(async (tx) => {
        await tx.$executeRaw`
          UPDATE subscriptions
             SET credit_cents = credit_cents + ${entrada.valorCents}, updated_at = now()
           WHERE tenant_id = ${entrada.tenantId}::uuid
        `;
        await tx.$executeRaw`
          UPDATE refunds SET status = 'failed' WHERE id = ${lancamento.id}::uuid
        `;
      });
      throw new PlataformaError('refund_refused', 'O adquirente recusou o estorno');
    }
    throw erro;
  }

  /**
   * O desfecho, e só ele.
   *
   * `refunds` é imutável no que importa: a migração 0031 revoga `UPDATE` da
   * tabela e devolve por coluna apenas `psp_refund_id`, `status` e
   * `settled_at`. Um `UPDATE ... SET amount_cents` daqui seria recusado pelo
   * banco, não por revisão de código — que é a diferença entre uma garantia e
   * uma convenção.
   */
  await semTenant(async (tx) => {
    await tx.$executeRaw`
      UPDATE refunds SET psp_refund_id = ${refundId}, status = 'done', settled_at = now()
       WHERE id = ${lancamento.id}::uuid
    `;
  });

  return {
    id: lancamento.id,
    tenantId: lancamento.tenant_id,
    valorCents: lancamento.amount_cents,
    motivo: lancamento.reason,
    estado: 'done',
    criadoEm: lancamento.created_at,
  };
}

export async function estornosDaBarbearia(tenantId: string): Promise<readonly Estorno[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        tenant_id: string;
        amount_cents: number;
        reason: string;
        status: 'pending' | 'done' | 'failed';
        created_at: Date;
      }[]
    >`
      SELECT id, tenant_id, amount_cents, reason, status, created_at
        FROM refunds WHERE tenant_id = ${tenantId}::uuid
       ORDER BY created_at DESC LIMIT 60
    `;
    return linhas.map((l) => ({
      id: l.id,
      tenantId: l.tenant_id,
      valorCents: l.amount_cents,
      motivo: l.reason,
      estado: l.status,
      criadoEm: l.created_at,
    }));
  });
}
