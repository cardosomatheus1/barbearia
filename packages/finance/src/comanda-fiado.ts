import { withTenant, type TransactionClient } from '@barbearia/db';
import { dividirPagamentoDeFiado, type EscopoMultiunidade, type FormaDePagamento } from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { inteiroSeguroDoBanco } from './inteiro-seguro.js';
import { ComandaError } from './comanda-tipos.js';

/**
 * Saldo e limite do cliente, com a linha travada até o fim da transação.
 *
 * Quem decide sobre dívida precisa ler o saldo **committed**, não o de um
 * instantâneo anterior: em READ COMMITTED, duas transações simultâneas leem o
 * mesmo saldo antigo e as duas concluem que cabe no limite.
 */
export async function saldoTravado(
  tx: TransactionClient,
  customerId: string,
  locationId?: string | null,
): Promise<{ readonly saldoCents: number; readonly limiteCents: number }> {
  const linhas = await tx.$queryRaw<
    {
      balance_cents: number;
      credit_limit_cents: number;
      credit_scope: EscopoMultiunidade;
    }[]
  >`
    SELECT c.balance_cents, c.credit_limit_cents, t.credit_scope
      FROM customers c
      JOIN tenants t ON t.id = c.tenant_id
     WHERE c.id = ${customerId}::uuid
     FOR UPDATE OF c
  `;
  const linha = linhas[0];
  if (!linha) throw new ComandaError('cliente_nao_encontrado', 'Cliente não encontrado.');
  if (linha.credit_scope === 'empresa' || !locationId) {
    return { saldoCents: linha.balance_cents, limiteCents: linha.credit_limit_cents };
  }

  /**
   * Com fiado por unidade, a dívida desta loja é **derivada do extrato** (bloco
   * 59) — `customers.balance_cents` continua sendo o acumulado da barbearia, e é
   * ele que a lista de cobrança lê.
   *
   * A trava continua sendo a da linha de `customers`, e é ela que serializa: em
   * READ COMMITTED, duas comandas simultâneas leriam a mesma soma antiga e as
   * duas concluiriam que cabe no limite.
   *
   * O limite é o mesmo em cada loja, não dividido: "pode levar R$ 300 sem pagar"
   * é uma frase sobre a pessoa, e reparti-la entre as lojas faria a barbearia
   * que abre a segunda loja cortar pela metade o crédito de todo mundo sem
   * ninguém ter decidido nada.
   */
  const daLoja = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(amount_cents)::bigint AS total FROM customer_ledger
     WHERE customer_id = ${customerId}::uuid
       AND (location_id IS NULL OR location_id = ${locationId}::uuid)
  `;
  /**
   * O bolso da loja nunca mostra mais crédito do que a pessoa tem na empresa.
   *
   * Segunda camada, e ela existe porque a primeira — abater onde a dívida está —
   * é uma cláusula perdível numa reescrita. A garantia de que ninguém leva fiado
   * contra crédito que não existe é grande demais para depender disso.
   */
  const derivado = inteiroSeguroDoBanco(daLoja[0]?.total, 'saldo de fiado da unidade');
  return {
    saldoCents: Math.min(derivado, Math.max(linha.balance_cents, 0)),
    limiteCents: linha.credit_limit_cents,
  };
}

/**
 * Lança no extrato e move o saldo, sempre juntos.
 *
 * `customers.balance_cents` é o acumulado; `customer_ledger` é o porquê dele.
 * Mover um sem o outro produz um saldo que ninguém consegue justificar no
 * balcão — e a primeira discussão sobre "quanto eu devo" não tem como terminar.
 *
 * O `balance_after_cents` é gravado junto de propósito: refazer a conta somando
 * o extrato inteiro daria outro número no dia em que uma linha fosse corrigida,
 * e o extrato é append-only justamente para que isso nunca aconteça.
 */
/**
 * Exportada desde o bloco 42: o reembolso de pacote também lança no razão.
 *
 * Uma cópia lá dentro esqueceria `balance_after_cents` — e foi exatamente o que
 * o teste do reembolso pegou na primeira versão. O saldo depois do lançamento é
 * o que faz o extrato do cliente ser conferível linha a linha.
 */
export async function lancarNoExtrato(
  tx: TransactionClient,
  params: {
    readonly customerId: string;
    readonly kind: 'fiado' | 'payment' | 'credit' | 'adjustment';
    readonly amountCents: number;
    readonly orderId?: string | null;
    readonly sessionId?: string | null;
    readonly note: string;
    readonly staffId: string;
    readonly staffName: string;
    /**
     * A loja em que a dívida nasceu ou foi paga (bloco 59).
     *
     * `customers.balance_cents` continua sendo o acumulado da barbearia — é ele
     * que a lista de cobrança lê. O recorte por loja é derivado do extrato, como
     * todo saldo deste produto, e por isso a coluna precisa estar preenchida em
     * **todos** os caminhos: um preenchido e outro não faz o saldo por loja
     * mentir com número, que é pior do que estar vazio.
     */
    readonly locationId?: string | null;
    /**
     * Marca a linha que **reencontra** a operação, quando ela tem chave.
     *
     * Opcional porque a maioria dos lançamentos nasce dentro de outra operação
     * que já tem a própria chave — o fiado de uma comanda é reencontrado pela
     * comanda. Quem passa é o pagamento de fiado, que não tinha nenhuma.
     */
    readonly idempotencyKey?: string;
    readonly idempotencyFingerprint?: string;
  },
): Promise<number> {
  const atualizados = await tx.$queryRaw<{ balance_cents: number }[]>`
    UPDATE customers
       SET balance_cents = balance_cents + ${params.amountCents}
     WHERE id = ${params.customerId}::uuid
    RETURNING balance_cents
  `;
  const saldo = atualizados[0]?.balance_cents;
  if (saldo === undefined) {
    throw new ComandaError('cliente_nao_encontrado', 'Cliente não encontrado.');
  }

  await tx.$executeRaw`
    INSERT INTO customer_ledger
      (tenant_id, customer_id, kind, amount_cents, balance_after_cents,
       order_id, session_id, note, created_by, created_by_name, location_id,
       idempotency_key, idempotency_fingerprint)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${params.customerId}::uuid, ${params.kind}::customer_ledger_kind,
      ${params.amountCents}, ${saldo},
      ${params.orderId ?? null}::uuid, ${params.sessionId ?? null}::uuid,
      ${params.note}, ${params.staffId}::uuid, ${params.staffName},
      ${params.locationId ?? null}::uuid,
      ${params.idempotencyKey ?? null}, ${params.idempotencyFingerprint ?? null}
    )
  `;

  return saldo;
}

/**
 * O cliente voltou e pagou o que devia.
 *
 * Este é o momento em que fiado vira dinheiro — e por isso entra na gaveta como
 * `debt_payment`, separado de `sale`. Somar aos dois no mesmo balde faria o
 * faturamento do dia contar duas vezes: uma quando o corte foi fiado e outra
 * quando ele foi pago.
 */
export async function receberFiado(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly customerId: string;
  readonly amountCents: number;
  readonly forma: FormaDePagamento;
  /**
   * Barra o toque duplo (bloco 103), e é chave porque não há estado.
   *
   * Pagar a dívida **inteira** já era barrado pelo estado — o segundo toque cai
   * em "este cliente não tem dívida em aberto". Quem recebe **parcial** é que
   * perdia: reproduzido antes do conserto, um cliente que devia R$ 200 entregou
   * R$ 50 e a dívida caiu R$ 100, com duas linhas de `debt_payment` na gaveta
   * esperando dinheiro que ninguém entregou.
   *
   * Dois pagamentos parciais iguais no mesmo dia são caso legítimo, então não
   * há estado que os distinga da repetição — é a regra do bloco 51.
   */
  readonly idempotencyKey: string;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly saldoCents: number }> {
  if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
    throw new ComandaError('pagamento_invalido', 'Informe um valor maior que zero.');
  }
  if (params.forma === 'fiado') {
    // Pagar fiado com fiado é rolar a dívida sem que nada aconteça, e o extrato
    // ficaria com duas linhas que se anulam.
    throw new ComandaError('pagamento_invalido', 'Não se paga fiado com fiado.');
  }
  const fingerprint = JSON.stringify([params.locationId, params.customerId, params.amountCents, params.forma]);

  return withTenant(params.tenantId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${params.tenantId}:${params.idempotencyKey}`}, 0))`;
    const jaFeito = await tx.$queryRaw<{ customer_id: string; idempotency_fingerprint: string | null }[]>`
      SELECT customer_id, idempotency_fingerprint FROM customer_ledger
       WHERE idempotency_key = ${params.idempotencyKey}
    `;
    const anterior = jaFeito[0];
    if (anterior) {
      if (anterior.idempotency_fingerprint && anterior.idempotency_fingerprint !== fingerprint) {
        throw new ComandaError('idempotencia_conflitante', 'Esta Idempotency-Key já foi usada para outro recebimento.');
      }
      const saldos = await tx.$queryRaw<{ balance_cents: number }[]>`
        SELECT balance_cents FROM customers WHERE id = ${anterior.customer_id}::uuid
      `;
      return { saldoCents: Number(saldos[0]?.balance_cents ?? 0) };
    }

    const cliente = await saldoTravado(tx, params.customerId);
    if (cliente.saldoCents >= 0) {
      throw new ComandaError('pagamento_invalido', 'Este cliente não tem dívida em aberto.');
    }
    if (params.amountCents > -cliente.saldoCents) {
      throw new ComandaError(
        'pagamento_invalido',
        'O valor é maior que a dívida. Receber a mais viraria crédito não combinado.',
      );
    }

    const sessoes = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM cash_sessions
       WHERE location_id = ${params.locationId}::uuid AND status = 'open'
       FOR UPDATE
    `;
    const sessao = sessoes[0];
    if (!sessao) {
      throw new ComandaError('caixa_fechado', 'Abra o caixa antes de receber.');
    }

    /**
     * O pagamento abate **onde a dívida está**, não onde ele foi feito.
     *
     * Pagar no balcão de outra loja é normal: o cliente devia na matriz e passou
     * na filial. Carimbando a linha com a loja do balcão, o bolso da filial
     * ficava positivo e o limite lá passava a valer duas vezes — repetindo
     * pegar-e-pagar, o crédito na filial não tinha teto. O dinheiro continua
     * entrando na gaveta de onde foi pago; a dívida que ele quita é a de quem a
     * tem, da mais antiga para a mais nova.
     *
     * Achado da `/security-review` do bloco 59.
     */
    const dividas = await tx.$queryRaw<{ location_id: string | null; total: bigint }[]>`
      SELECT location_id, sum(amount_cents)::bigint AS total
        FROM customer_ledger
       WHERE customer_id = ${params.customerId}::uuid
       GROUP BY location_id
       HAVING sum(amount_cents) < 0
       ORDER BY min(created_at)
    `;

    const partes = dividirPagamentoDeFiado({
      pagamentoCents: params.amountCents,
      dividas: dividas.map((d) => ({
        unidadeId: d.location_id,
        saldoCents: inteiroSeguroDoBanco(d.total, 'dívida por unidade'),
      })),
    });

    let saldo = cliente.saldoCents;
    let primeira = true;
    for (const parte of partes) {
      saldo = await lancarNoExtrato(tx, {
        customerId: params.customerId,
        kind: 'payment',
        amountCents: parte.valorCents,
        sessionId: sessao.id,
        note: `Pagamento de dívida (${params.forma})`,
        staffId: params.staffId,
        staffName: params.staffName,
        locationId: parte.unidadeId,
        /**
         * Só a primeira parte carrega a chave.
         *
         * Um pagamento vira uma linha por loja onde a dívida está (bloco 59), e
         * a chave existe para **reencontrar o pagamento**, não para descrever
         * cada parte dele — no índice único, a segunda parte do mesmo pagamento
         * seria recusada.
         */
        ...(primeira ? { idempotencyKey: params.idempotencyKey, idempotencyFingerprint: fingerprint } : {}),
      });
      primeira = false;
    }

    if (params.forma === 'cash') {
      await tx.$executeRaw`
        INSERT INTO cash_movements
          (tenant_id, session_id, kind, amount_cents, reason, created_by, created_by_name)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${sessao.id}::uuid, 'debt_payment', ${params.amountCents},
          'Pagamento de fiado', ${params.staffId}::uuid, ${params.staffName}
        )
      `;
    }

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'debt.received',
      entity: 'customer',
      entityId: params.customerId,
      before: { saldoCents: cliente.saldoCents },
      after: { saldoCents: saldo, amountCents: params.amountCents, forma: params.forma },
    });

    return { saldoCents: saldo };
  });
}
