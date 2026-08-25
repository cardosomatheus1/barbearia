import { semTenant, type TransactionClient } from '@barbearia/db';
import { PlataformaError, registrarNaTrilha } from './plataforma.js';
import { faturasEmCobranca, pagarFaturaNaTransacao } from './cobranca.js';
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
 * `psp_events` e a máquina de estados trabalham juntos. A chave do evento
 * serializa reentregas concorrentes e registra o que o adquirente afirmou; a
 * transição da fatura impede que um evento antigo altere um estado já fechado.
 * O ponto crítico é que **registro e efeito usam a mesma transação**: uma linha
 * de evento nunca pode ficar commitada sem o efeito financeiro correspondente.
 * Linhas legadas com `processed_at IS NULL` são retomadas com `FOR UPDATE`.
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
  /**
   * Registro do evento e efeito financeiro são uma unidade atômica.
   *
   * Antes, `psp_events` era commitado primeiro e a fatura era alterada numa
   * transação seguinte. Um crash entre os dois deixava `processed_at IS NULL`,
   * mas a reentrega via a PK já existente e retornava `ignored` para sempre.
   * Agora a PK continua serializando entregas concorrentes, só que ela só fica
   * visível depois que o mesmo commit fechou o efeito — ou tudo volta atrás.
   * Linhas legadas pendentes também são retomadas em vez de abandonadas.
   */
  return semTenant(async (tx) => {
    const inseridas = await tx.$queryRaw<{ event_id: string }[]>`
      INSERT INTO psp_events (event_id, type, payload)
      VALUES (${evento.eventoId}, ${evento.tipo}, ${JSON.stringify(evento.payload)}::jsonb)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `;

    if (inseridas.length === 0) {
      const existentes = await tx.$queryRaw<{ processed_at: Date | null }[]>`
        SELECT processed_at FROM psp_events
         WHERE event_id = ${evento.eventoId}
         FOR UPDATE
      `;
      // Processado é reentrega normal. Pendente é uma linha legada ou uma
      // execução antiga que caiu antes deste endurecimento: retomamos abaixo.
      if (existentes[0]?.processed_at) return 'ignored';
    }

    const alvos = await tx.$queryRaw<{ id: string; tenant_id: string; status: string }[]>`
      SELECT id, tenant_id, status::text
        FROM invoices
       WHERE psp_charge_id = ${evento.chargeId}
       FOR UPDATE
    `;
    const alvo = alvos[0] ?? null;

    if (!alvo || alvo.status !== 'open') {
      await encerrarEventoNaTransacao(tx, evento.eventoId, alvo?.tenant_id ?? null, alvo?.id ?? null, 'ignored');
      return 'ignored';
    }

    if (evento.tipo === 'charge.paid') {
      try {
        await pagarFaturaNaTransacao(tx, {
          adminId: null,
          faturaId: alvo.id,
          metodo: 'card',
          chargeIdEsperado: evento.chargeId,
        });
      } catch (erro) {
        if (!(erro instanceof PlataformaError) || erro.code !== 'not_payable') throw erro;
        await encerrarEventoNaTransacao(tx, evento.eventoId, alvo.tenant_id, alvo.id, 'ignored');
        return 'ignored';
      }
      await encerrarEventoNaTransacao(tx, evento.eventoId, alvo.tenant_id, alvo.id, 'paid');
      return 'paid';
    }

    if (evento.tipo === 'charge.failed') {
      const alteradas = await tx.$executeRaw`
        UPDATE invoices
           SET attempts = attempts + 1, psp_charge_id = NULL, updated_at = now()
         WHERE id = ${alvo.id}::uuid AND status = 'open'
           AND psp_charge_id = ${evento.chargeId}
      `;
      if (alteradas === 1) {
        await registrarNaTrilha(tx, null, alvo.tenant_id, 'invoice.charge_failed', {
          faturaId: alvo.id,
          chargeId: evento.chargeId,
        });
        await encerrarEventoNaTransacao(tx, evento.eventoId, alvo.tenant_id, alvo.id, 'failed');
        return 'failed';
      }
      await encerrarEventoNaTransacao(tx, evento.eventoId, alvo.tenant_id, alvo.id, 'ignored');
      return 'ignored';
    }

    await encerrarEventoNaTransacao(tx, evento.eventoId, alvo.tenant_id, alvo.id, 'ignored');
    return 'ignored';
  });
}

async function encerrarEventoNaTransacao(
  tx: TransactionClient,
  eventoId: string,
  tenantId: string | null,
  faturaId: string | null,
  desfecho: DesfechoDoEvento,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE psp_events
       SET processed_at = now(), outcome = ${desfecho},
           tenant_id = ${tenantId}::uuid, invoice_id = ${faturaId}::uuid
     WHERE event_id = ${eventoId}
  `;
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

const UNIQUE_VIOLATION = '23505';

/** SQLSTATE real quando a consulta crua atravessa o Prisma. */
function pgCode(erro: unknown): string | null {
  const meta = (erro as { meta?: { code?: unknown } })?.meta;
  if (typeof meta?.code === 'string') return meta.code;
  const code = (erro as { code?: unknown })?.code;
  if (typeof code === 'string' && !/^P\d+$/.test(code)) return code;
  return /Code: `(\w+)`/.exec(erro instanceof Error ? erro.message : '')?.[1] ?? null;
}

export async function estornarCredito(entrada: {
  readonly adminId: string;
  readonly tenantId: string;
  readonly valorCents: number;
  readonly motivo: string;
  /** Chave da requisição, já escopada pelo admin na borda HTTP. */
  readonly idempotencyKey: string;
  readonly provider: PspProvider;
}): Promise<Estorno> {
  const motivo = entrada.motivo.trim();
  if (motivo.length < 3) {
    throw new PlataformaError('reason_required', 'Escreva o motivo do estorno');
  }
  if (!Number.isInteger(entrada.valorCents) || entrada.valorCents <= 0) {
    throw new PlataformaError('invalid_amount', 'O valor do estorno tem que ser positivo');
  }
  if (!entrada.idempotencyKey || entrada.idempotencyKey.length > 200) {
    throw new PlataformaError('idempotency_key_required', 'Informe uma chave de idempotência válida');
  }
  const fingerprint = JSON.stringify([entrada.valorCents, motivo]);

  const repetido = await semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{
      id: string; tenant_id: string; amount_cents: number; reason: string;
      status: 'pending' | 'done' | 'failed'; created_at: Date; idempotency_fingerprint: string | null;
    }[]>`
      SELECT id, tenant_id, amount_cents, reason, status, created_at, idempotency_fingerprint
        FROM refunds
       WHERE tenant_id = ${entrada.tenantId}::uuid
         AND idempotency_key = ${entrada.idempotencyKey}
    `;
    return linhas[0] ?? null;
  });
  if (repetido) {
    if (repetido.idempotency_fingerprint && repetido.idempotency_fingerprint !== fingerprint) {
      throw new PlataformaError('idempotency_conflict', 'Esta Idempotency-Key já foi usada para outro estorno');
    }
    return {
      id: repetido.id,
      tenantId: repetido.tenant_id,
      valorCents: repetido.amount_cents,
      motivo: repetido.reason,
      estado: repetido.status,
      criadoEm: repetido.created_at,
    };
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

  let lancamento: { id: string; tenant_id: string; amount_cents: number; reason: string; created_at: Date };
  try {
    lancamento = await semTenant(async (tx) => {
      /**
       * A linha nasce **antes** do débito, e a ordem é a regra.
       *
       * Com o débito primeiro, o perdedor da corrida morria em
       * `insufficient_credit` sem nunca chegar ao INSERT: o vencedor já tinha
       * reduzido o saldo, o `WHERE credit_cents >= valor` recusava, e o
       * `catch` de violação de unicidade — que existe justamente para reler o
       * lançamento vencedor — nunca era alcançado. Duas requisições com a mesma
       * chave devolviam um erro de dinheiro em vez do mesmo estorno.
       *
       * Inserindo primeiro, quem decide é o índice único. A transação perdedora
       * é revertida inteira pelo Postgres, e o crédito nem chega a ser tocado.
       */
      const criados = await tx.$queryRaw<
        { id: string; tenant_id: string; amount_cents: number; reason: string; created_at: Date }[]
      >`
        INSERT INTO refunds
          (tenant_id, amount_cents, reason, admin_id, psp_charge_id, idempotency_key, idempotency_fingerprint)
        VALUES (
          ${entrada.tenantId}::uuid, ${entrada.valorCents}, ${motivo},
          ${entrada.adminId}::uuid, ${cobranca.psp_charge_id}, ${entrada.idempotencyKey}, ${fingerprint}
        )
        RETURNING id, tenant_id, amount_cents, reason, created_at
      `;
      const criado = criados[0];
      if (!criado) throw new PlataformaError('refund_failed', 'Não foi possível registrar o estorno');

      const debitadas = await tx.$executeRaw`
        UPDATE subscriptions
           SET credit_cents = credit_cents - ${entrada.valorCents}, updated_at = now()
         WHERE tenant_id = ${entrada.tenantId}::uuid AND credit_cents >= ${entrada.valorCents}
      `;
      if (debitadas === 0) {
        throw new PlataformaError('insufficient_credit', 'O crédito disponível é menor que o pedido');
      }

      await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'credit.refunded', {
        estornoId: criado.id,
        valorCents: entrada.valorCents,
        motivo,
      });

      return criado;
    });
  } catch (erro) {
    /**
     * Duas requisições com a mesma Idempotency-Key podem passar juntas pelo
     * SELECT inicial. O índice único decide a vencedora; a transação perdedora
     * (inclusive o débito do crédito) é revertida pelo Postgres. Em vez de
     * transformar a colisão correta em 500, relê o lançamento vencedor.
     */
    if (pgCode(erro) !== UNIQUE_VIOLATION) throw erro;
    const concorrente = await semTenant(async (tx) => {
      const linhas = await tx.$queryRaw<{
        id: string; tenant_id: string; amount_cents: number; reason: string;
        status: 'pending' | 'done' | 'failed'; created_at: Date; idempotency_fingerprint: string | null;
      }[]>`
        SELECT id, tenant_id, amount_cents, reason, status, created_at, idempotency_fingerprint
          FROM refunds
         WHERE tenant_id = ${entrada.tenantId}::uuid
           AND idempotency_key = ${entrada.idempotencyKey}
      `;
      return linhas[0] ?? null;
    });
    if (!concorrente) throw erro;
    if (concorrente.idempotency_fingerprint && concorrente.idempotency_fingerprint !== fingerprint) {
      throw new PlataformaError('idempotency_conflict', 'Esta Idempotency-Key já foi usada para outro estorno');
    }
    return {
      id: concorrente.id,
      tenantId: concorrente.tenant_id,
      valorCents: concorrente.amount_cents,
      motivo: concorrente.reason,
      estado: concorrente.status,
      criadoEm: concorrente.created_at,
    };
  }

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
        // A transição reivindica a compensação. O reconciliador pode estar
        // tentando o mesmo estorno ao mesmo tempo; só quem realmente muda
        // pending -> failed devolve o crédito, evitando crédito em dobro.
        const falhadas = await tx.$executeRaw`
          UPDATE refunds SET status = 'failed'
           WHERE id = ${lancamento.id}::uuid AND status = 'pending'
        `;
        if (falhadas > 0) {
          await tx.$executeRaw`
            UPDATE subscriptions
               SET credit_cents = credit_cents + ${entrada.valorCents}, updated_at = now()
             WHERE tenant_id = ${entrada.tenantId}::uuid
          `;
        }
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


/**
 * Retoma estornos cuja resposta do adquirente se perdeu.
 *
 * A chamada usa o mesmo `estornoId`, e a Stripe transforma esse id na chave de
 * idempotência. Portanto uma resposta perdida não gera uma segunda devolução:
 * a repetição reencontra a primeira. `pending` só permanece quando a rede
 * continua ambígua.
 */
export async function conciliarEstornosPendentes(entrada: {
  readonly provider: PspProvider;
  readonly limite?: number;
}): Promise<{ readonly consultados: number; readonly concluidos: number; readonly recusados: number; readonly comFalha: number }> {
  const limite = Math.min(Math.max(entrada.limite ?? 100, 1), 500);
  const pendentes = await semTenant((tx) => tx.$queryRaw<{
    id: string;
    tenant_id: string;
    amount_cents: number;
    psp_charge_id: string;
    psp_customer_id: string;
  }[]>`
    SELECT r.id, r.tenant_id, r.amount_cents, r.psp_charge_id, b.psp_customer_id
      FROM refunds r
      JOIN billing_customers b ON b.tenant_id = r.tenant_id
     WHERE r.status = 'pending'
       AND r.psp_charge_id IS NOT NULL
     ORDER BY r.created_at
     LIMIT ${limite}
  `);

  const contagem = { consultados: 0, concluidos: 0, recusados: 0, comFalha: 0 };
  for (const lancamento of pendentes) {
    contagem.consultados += 1;
    try {
      const { refundId } = await entrada.provider.estornar({
        tenantId: lancamento.tenant_id,
        pspCustomerId: lancamento.psp_customer_id,
        pspChargeId: lancamento.psp_charge_id,
        valorCents: lancamento.amount_cents,
        estornoId: lancamento.id,
      });
      const mexidas = await semTenant((tx) => tx.$executeRaw`
        UPDATE refunds
           SET psp_refund_id = ${refundId}, status = 'done', settled_at = now()
         WHERE id = ${lancamento.id}::uuid AND status = 'pending'
      `);
      if (mexidas > 0) contagem.concluidos += 1;
    } catch (erro) {
      if (erro instanceof EstornoRecusado) {
        // O adquirente garantiu que nada saiu. A mudança de `pending` para
        // `failed` reivindica a compensação: só quem realmente muda a linha
        // devolve o crédito, então duas conciliações não creditam duas vezes.
        await semTenant(async (tx) => {
          const falhadas = await tx.$executeRaw`
            UPDATE refunds SET status = 'failed'
             WHERE id = ${lancamento.id}::uuid AND status = 'pending'
          `;
          if (falhadas > 0) {
            await tx.$executeRaw`
              UPDATE subscriptions
                 SET credit_cents = credit_cents + ${lancamento.amount_cents}, updated_at = now()
               WHERE tenant_id = ${lancamento.tenant_id}::uuid
            `;
            contagem.recusados += 1;
          }
        });
        continue;
      }
      contagem.comFalha += 1;
    }
  }
  return contagem;
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
