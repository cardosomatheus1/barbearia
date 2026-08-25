import { withTenant, type TransactionClient } from '@barbearia/db';
import { podeEstornar, restamNoPacote, type EstornoFailure, type PaymentProvider } from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { estornarComissaoDaComanda } from './comissao.js';
import { estornarSplitDaVenda } from './split.js';
import { moverEstoque, EstoqueError } from './estoque.js';
import { lancarNoExtrato } from './comanda.js';
import { inteiroSeguroDoBanco } from './inteiro-seguro.js';

/**
 * Desfazer uma venda já fechada (bloco 52, SPEC §3.4).
 *
 * As duas consequências financeiras já existiam desde os blocos 19 e 50 —
 * comissão negativa no período aberto e repasse desfeito. O que faltava era a
 * **operação**, e com ela as cinco contrapartidas que ninguém tinha decidido:
 *
 * | O que a venda fez | O que o estorno faz |
 * |---|---|
 * | comissão lançada | lançamento negativo **no período aberto**, nunca no fechado |
 * | repasse ao barbeiro | cancela o que não saiu, vira dívida o que saiu |
 * | produto baixado do estoque | volta como `entrada`, com o custo congelado da saída |
 * | crédito de fidelidade | lançamento negativo; o resgate **não** volta |
 * | dinheiro na gaveta | movimento negativo, quando a venda entrou por lá |
 * | fiado lançado | abatido do saldo do cliente |
 *
 * ## O que **não** volta
 *
 * A unidade de pacote consumida e o uso de plano do mês **ficam consumidos**. O
 * serviço foi prestado — o cliente sentou na cadeira e cortou o cabelo —, e a
 * venda estornada é sobre o dinheiro, não sobre o atendimento. Devolver a
 * unidade daria ao cliente um corte a mais de graça toda vez que a casa
 * corrigisse um erro de caixa. Quando o caso é o oposto — o serviço não foi
 * prestado —, o caminho é o reembolso do pacote, que existe desde o bloco 42 e
 * devolve dinheiro proporcional.
 *
 * O crédito **resgatado** também não volta, pela mesma razão: ele foi usado para
 * pagar um serviço que aconteceu. Só o crédito **acumulado** nesta venda é
 * desfeito, porque ele veio de um pagamento que está sendo devolvido.
 */

export class EstornoError extends Error {
  constructor(readonly code: EstornoFailure, message: string) {
    super(message);
    this.name = 'EstornoError';
  }
}

const MENSAGEM: Readonly<Record<EstornoFailure, string>> = {
  venda_nao_encontrada: 'Esta venda não existe.',
  venda_nao_paga: 'Só uma venda paga pode ser estornada.',
  ja_estornada: 'Esta venda já foi estornada.',
  motivo_obrigatorio: 'Escreva o motivo do estorno.',
  periodo_fechado: 'O período desta venda já foi fechado.',
  estorno_externo_falhou: 'O adquirente não confirmou a devolução. A venda continua paga no Barberdock.',
  estorno_em_curso: 'Já existe um estorno desta venda em processamento. Aguarde antes de tentar novamente.',
  fiado_ja_recebido: 'Parte do fiado desta venda já foi recebida. Faça o acerto manual antes de estornar.',
  caixa_sem_saldo_para_estorno: 'Abra um caixa com saldo suficiente antes de devolver o valor recebido em dinheiro.',
  pacote_vendido_ja_usado: 'Um pacote vendido nesta comanda já foi usado e impede o estorno integral.',
  pacote_vendido_ja_reembolsado: 'Um pacote vendido nesta comanda já foi reembolsado separadamente.',
  pacote_vendido_ja_transferido: 'Um pacote vendido nesta comanda já foi transferido e impede o estorno integral.',
};

function recusar(code: EstornoFailure): never {
  throw new EstornoError(code, MENSAGEM[code]);
}

/**
 * Declaração de função, não `const` com arrow.
 *
 * O TypeScript só estreita o tipo depois de uma chamada que retorna `never`
 * quando ela é declarada assim — com uma arrow local, `pacote` continuava
 * "possivelmente indefinido" depois do `if (!pacote) falhar(...)`, e o compilador
 * pedia um `!` que este código não usa.
 */
function falharNaTransferencia(code: TransferenciaDePacoteFailure): never {
  throw new TransferenciaDePacoteError(code, MENSAGEM_DA_TRANSFERENCIA[code]);
}

export interface ResumoDoEstorno {
  readonly orderId: string;
  readonly totalCents: number;
  readonly comissoesEstornadas: number;
  readonly repassesCancelados: number;
  readonly repassesCobrados: number;
  readonly produtosDevolvidos: number;
  readonly fidelidadeDesfeitaCents: number;
  readonly fiadoAbatidoCents: number;
  readonly gavetaCents: number;
}


interface CobrancaExternaDoEstorno {
  readonly chargeId: string;
  readonly pagamentoId: string;
  readonly valorCents: number;
  readonly estornoId: string | null;
}

/**
 * Um pacote vendido pela própria comanda precisa estar intacto antes do
 * estorno integral. Caso contrário o dinheiro voltaria depois de parte do
 * benefício já ter sido consumida (ou depois de um reembolso separado).
 *
 * A linha do pacote é travada para a decisão ser a mesma do UPDATE que o
 * invalida no estorno local.
 */
async function validarPacotesVendidosParaEstorno(
  tx: TransactionClient,
  orderId: string,
): Promise<void> {
  // Primeiro trave todas as compras criadas por esta venda. A contagem de usos
  // vem em uma **segunda** instrução para enxergar um consumo que tenha
  // terminado enquanto aguardávamos a trava da linha.
  await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM customer_packages
     WHERE order_id = ${orderId}::uuid
     FOR UPDATE
  `;

  const pacotes = await tx.$queryRaw<
    { id: string; refunded_at: Date | null; usados: number; transferencias: number }[]
  >`
    SELECT cp.id, cp.refunded_at,
           (SELECT count(*) FROM package_uses u
             WHERE u.customer_package_id = cp.id)::int AS usados,
           (SELECT count(*) FROM package_transfers t
             WHERE t.customer_package_id = cp.id)::int AS transferencias
      FROM customer_packages cp
     WHERE cp.order_id = ${orderId}::uuid
  `;

  for (const pacote of pacotes) {
    if (pacote.refunded_at) recusar('pacote_vendido_ja_reembolsado');
    if (pacote.usados > 0) recusar('pacote_vendido_ja_usado');
    if (pacote.transferencias > 0) recusar('pacote_vendido_ja_transferido');
  }
}

async function invalidarPacotesVendidos(
  tx: TransactionClient,
  orderId: string,
): Promise<number> {
  await validarPacotesVendidosParaEstorno(tx, orderId);
  return tx.$executeRaw`
    UPDATE customer_packages
       SET refunded_at = now(), refunded_cents = price_cents, updated_at = now()
     WHERE order_id = ${orderId}::uuid AND refunded_at IS NULL
  `;
}

/**
 * Descobre se a venda foi paga pelo adquirente e adquire um lease persistente
 * antes de mover dinheiro fora do banco.
 *
 * Sem `refund_pending_at`, duas requisições simultâneas saem da transação com
 * `psp_refund_id = null` e ambas chamam o adquirente. A Stripe tem idempotência,
 * mas a correção não pode depender de todo provider futuro copiá-la certo.
 *
 * O lease expira em 15 minutos. Se o processo morrer depois de a Stripe ter
 * devolvido e antes de persistir a resposta, uma tentativa futura readquire o
 * lease; a chave idempotente determinística do provider reencontra o mesmo
 * refund e conclui o lado local.
 */
async function prepararEstornoExterno(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly orderId: string;
  readonly motivo: string;
}): Promise<CobrancaExternaDoEstorno | null> {
  return withTenant(params.tenantId, async (tx) => {
    const vendas = await tx.$queryRaw<
      { status: 'open' | 'paid' | 'cancelled' | 'refunded'; customer_id: string | null; location_id: string }[]
    >`
      SELECT status::text AS status, customer_id, location_id FROM orders
       WHERE id = ${params.orderId}::uuid AND location_id = ${params.locationId}::uuid
       FOR UPDATE
    `;
    const venda = vendas[0];
    if (!venda) recusar('venda_nao_encontrada');
    const falha = podeEstornar({ estado: venda.status, motivo: params.motivo });
    if (falha) recusar(falha);

    // Faça esta validação antes de qualquer chamada externa. Depois que o lease
    // for gravado, `pacote.ts` bloqueia uso/transferência/reembolso até o
    // desfecho do estorno.
    await validarPacotesVendidosParaEstorno(tx, params.orderId);
    await validarFiadoParaEstorno(tx, {
      orderId: params.orderId,
      customerId: venda.customer_id,
      locationId: venda.location_id,
    });
    await validarGavetaParaEstorno(tx, {
      orderId: params.orderId,
      locationId: venda.location_id,
    });

    const cobrancas = await tx.$queryRaw<
      {
        id: string;
        psp_payment_id: string;
        amount_cents: number;
        psp_refund_id: string | null;
        refund_pending_at: Date | null;
      }[]
    >`
      SELECT id, psp_payment_id, amount_cents, psp_refund_id, refund_pending_at
        FROM order_charges
       WHERE order_id = ${params.orderId}::uuid
         AND location_id = ${params.locationId}::uuid
         AND status = 'pago'
       ORDER BY paid_at DESC
       LIMIT 1
       FOR UPDATE
    `;
    const cobranca = cobrancas[0];
    if (!cobranca) return null;
    if (cobranca.psp_refund_id) {
      return {
        chargeId: cobranca.id,
        pagamentoId: cobranca.psp_payment_id,
        valorCents: cobranca.amount_cents,
        estornoId: cobranca.psp_refund_id,
      };
    }

    if (
      cobranca.refund_pending_at &&
      cobranca.refund_pending_at.getTime() > Date.now() - 15 * 60_000
    ) {
      recusar('estorno_em_curso');
    }

    const adquiridas = await tx.$executeRaw`
      UPDATE order_charges
         SET refund_pending_at = now(), updated_at = now()
       WHERE id = ${cobranca.id}::uuid
         AND psp_refund_id IS NULL
         AND (refund_pending_at IS NULL OR refund_pending_at < now() - interval '15 minutes')
    `;
    if (adquiridas !== 1) recusar('estorno_em_curso');

    return {
      chargeId: cobranca.id,
      pagamentoId: cobranca.psp_payment_id,
      valorCents: cobranca.amount_cents,
      estornoId: null,
    };
  });
}

async function registrarEstornoExterno(params: {
  readonly tenantId: string;
  readonly chargeId: string;
  readonly estornoId: string;
  readonly valorCents: number;
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ psp_refund_id: string | null }[]>`
      UPDATE order_charges
         SET refunded_at = coalesce(refunded_at, now()),
             psp_refund_id = coalesce(psp_refund_id, ${params.estornoId}),
             refunded_cents = coalesce(refunded_cents, ${params.valorCents}),
             -- O lease fica até o lado local marcar a venda como refunded.
             -- Sem isso, um pacote vendido pela comanda voltaria a ficar
             -- consumível no intervalo entre a resposta da Stripe e a
             -- transação local.
             updated_at = now()
       WHERE id = ${params.chargeId}::uuid
       RETURNING psp_refund_id
    `;
    const persistido = linhas[0]?.psp_refund_id;
    if (persistido !== params.estornoId) {
      throw new Error('estorno_externo_divergente');
    }
  });
}

/**
 * Estorno completo quando a comanda pode ter sido paga online.
 *
 * O adquirente vem antes das contrapartidas locais. O lease persistente impede
 * duas chamadas simultâneas e a idempotência do provider cobre recuperação
 * depois de queda do processo.
 */
export async function estornarVendaComAdquirente(
  params: Parameters<typeof estornarVenda>[0] & { readonly provider: PaymentProvider },
): Promise<ResumoDoEstorno> {
  const cobranca = await prepararEstornoExterno(params);

  if (cobranca && !cobranca.estornoId) {
    let resposta: { readonly estornoId: string };
    try {
      resposta = await params.provider.estornar(cobranca.pagamentoId, cobranca.valorCents);
    } catch {
      /**
       * Não libere o lease numa falha de rede. `throw` não prova que o adquirente
       * não moveu dinheiro: a resposta pode ter se perdido **depois** do refund.
       * Manter `refund_pending_at` evita uma segunda tentativa imediata; depois
       * do lease, a idempotência obrigatória do provider reencontra o mesmo
       * estorno e conclui o lado local.
       */
      recusar('estorno_externo_falhou');
    }
    await registrarEstornoExterno({
      tenantId: params.tenantId,
      chargeId: cobranca.chargeId,
      estornoId: resposta.estornoId,
      valorCents: cobranca.valorCents,
    });
  }

  return estornarVenda(params);
}

/**
 * Desfaz a venda inteira, numa transação só.
 *
 * A ordem importa por um motivo: o `FOR UPDATE` na comanda vem **antes** de
 * tudo, e é ele que impede dois estornos simultâneos de rodarem as seis
 * contrapartidas cada um. O estado `refunded` gravado no fim é a segunda camada,
 * e ela é a que sobrevive a uma reescrita que perca a trava.
 */
export async function estornarVenda(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly orderId: string;
  readonly motivo: string;
  /** `YYYY-MM-DD` na unidade — é o dia em que o estorno acontece, não o da venda. */
  readonly hoje: string;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<ResumoDoEstorno> {
  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        status: 'open' | 'paid' | 'cancelled' | 'refunded';
        total_cents: number;
        customer_id: string | null;
        location_id: string;
        business_day: Date;
      }[]
    >`
      SELECT id, status::text AS status, total_cents, customer_id, location_id, business_day
        FROM orders
       WHERE id = ${params.orderId}::uuid AND location_id = ${params.locationId}::uuid
       FOR UPDATE
    `;
    const venda = linhas[0];
    if (!venda) recusar('venda_nao_encontrada');

    const falha = podeEstornar({ estado: venda.status, motivo: params.motivo });
    if (falha) recusar(falha);

    // Valide as condições que tornariam o estorno economicamente ambíguo antes
    // de lançar qualquer contrapartida. Como tudo abaixo está na mesma
    // transação, uma falha posterior ainda desfaz tudo.
    await validarPacotesVendidosParaEstorno(tx, params.orderId);
    await validarFiadoParaEstorno(tx, {
      orderId: params.orderId,
      customerId: venda.customer_id,
      locationId: venda.location_id,
    });
    await validarGavetaParaEstorno(tx, {
      orderId: params.orderId,
      locationId: venda.location_id,
    });

    const comissoesEstornadas = await estornarComissaoDaComanda(tx, {
      orderId: params.orderId,
      quandoISO: params.hoje,
    });

    const repasses = await estornarSplitDaVenda(tx, {
      orderId: params.orderId,
      quandoISO: params.hoje,
    });

    const produtosDevolvidos = await devolverProdutos(tx, {
      orderId: params.orderId,
      hoje: params.hoje,
      locationId: venda.location_id,
    });
    const pacotesInvalidados = await invalidarPacotesVendidos(tx, params.orderId);

    const fidelidadeDesfeitaCents = await desfazerAcumuloDeFidelidade(tx, params.orderId);
    const fiadoAbatidoCents = await abaterFiado(tx, {
      orderId: params.orderId,
      customerId: venda.customer_id,
      locationId: venda.location_id,
      staffId: params.staffId,
      staffName: params.staffName,
    });
    const gavetaCents = await devolverAGaveta(tx, {
      orderId: params.orderId,
      locationId: venda.location_id,
      staffId: params.staffId,
      staffName: params.staffName,
    });

    /**
     * O `UPDATE` é guardado por estado **e** a contagem é conferida.
     *
     * A trava lá em cima é quem impede o segundo estorno hoje; descartar a
     * contagem deixaria esta segunda camada inerte, e uma reescrita que perdesse
     * o `FOR UPDATE` faria as seis contrapartidas rodarem duas vezes sem nada
     * ficar vermelho. É a regra do bloco 43 aplicada aqui.
     */
    const marcadas = await tx.$executeRaw`
      UPDATE orders
         SET status = 'refunded', refunded_at = now(), refunded_by = ${params.staffId}::uuid,
             refunded_by_name = ${params.staffName}, refund_reason = ${params.motivo.trim()}
       WHERE id = ${params.orderId}::uuid AND status = 'paid'
    `;
    if (marcadas !== 1) recusar('ja_estornada');

    // Só agora o estorno externo deixa de estar "em voo" para os benefícios
    // vendidos por esta comanda. Se o processo cair antes daqui, o retry vê o
    // refund persistido e conclui somente esta metade local.
    await tx.$executeRaw`
      UPDATE order_charges SET refund_pending_at = NULL, updated_at = now()
       WHERE order_id = ${params.orderId}::uuid AND refund_pending_at IS NOT NULL
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'order.refunded',
      entity: 'order',
      entityId: params.orderId,
      before: { totalCents: venda.total_cents, estado: venda.status },
      after: {
        motivo: params.motivo.trim(),
        comissoesEstornadas,
        repassesCancelados: repasses.cancelados,
        repassesCobrados: repasses.cobrados,
        produtosDevolvidos,
        pacotesInvalidados,
        fidelidadeDesfeitaCents,
        fiadoAbatidoCents,
        gavetaCents,
      },
    });

    return {
      orderId: params.orderId,
      totalCents: venda.total_cents,
      comissoesEstornadas,
      repassesCancelados: repasses.cancelados,
      repassesCobrados: repasses.cobrados,
      produtosDevolvidos,
      fidelidadeDesfeitaCents,
      fiadoAbatidoCents,
      gavetaCents,
    };
  });
}

/**
 * O produto volta para a prateleira, com o custo **da saída**.
 *
 * Ler `products.cost_cents` aqui faria a devolução de janeiro entrar a preço de
 * agosto, e a diferença apareceria como lucro ou prejuízo de estoque que nunca
 * existiu. O custo congelado no movimento original é o único número certo — é a
 * mesma razão de ele ter sido congelado lá.
 */
async function devolverProdutos(
  tx: TransactionClient,
  params: {
    readonly orderId: string;
    readonly hoje: string;
    readonly locationId: string;
  },
): Promise<number> {
  const saidas = await tx.$queryRaw<
    { product_id: string; quantity: number; unit_cost_cents: number }[]
  >`
    SELECT product_id, sum(quantity)::int AS quantity, max(unit_cost_cents)::int AS unit_cost_cents
      FROM stock_movements
     WHERE order_id = ${params.orderId}::uuid AND kind = 'venda'
     GROUP BY product_id
  `;

  let devolvidos = 0;
  for (const saida of saidas) {
    // `quantity` da venda é negativo: o que volta é o módulo.
    const quantidade = Math.abs(saida.quantity);
    if (quantidade === 0) continue;
    try {
      await moverEstoque(tx, {
        produtoId: saida.product_id,
        tipo: 'entrada',
        quantidade,
        diaDaUnidade: params.hoje,
        orderId: params.orderId,
        custoUnitarioCents: saida.unit_cost_cents,
        locationId: params.locationId,
        motivo: 'Devolução por estorno de venda',
      });
      devolvidos += quantidade;
    } catch (erro) {
      // Mesma lição do bloco 44: nada que o estoque diga derruba uma transação
      // que mexe em dinheiro. A ausência aparece na contagem, que é o lugar
      // certo de aparecer.
      if (!(erro instanceof EstoqueError)) throw erro;
    }
  }
  return devolvidos;
}

/**
 * Só o **acúmulo** desta venda é desfeito.
 *
 * O resgate fica: o crédito foi usado para pagar um serviço que aconteceu, e
 * devolvê-lo daria ao cliente o saldo de volta *e* o corte que ele já levou. O
 * lançamento negativo entra como `ajuste`, e não como `resgate`, porque resgate
 * é o cliente gastando — este é a casa desfazendo.
 */
async function desfazerAcumuloDeFidelidade(
  tx: TransactionClient,
  orderId: string,
): Promise<number> {
  /**
   * Agrupado **também por bolso** (bloco 59).
   *
   * O estorno tem que devolver o ponto ao bolso de onde ele saiu. Escrito no
   * compartilhado, um estorno de acúmulo de unidade não encontra lote nenhum
   * para consumir — `lotes()` só desconta uma saída contra as entradas que a
   * precedem —, e a linha negativa é **descartada em silêncio**: o cliente fica
   * com os pontos de uma venda que foi devolvida, e comprar-e-estornar vira
   * máquina de fabricar crédito.
   *
   * Achado da `/security-review` do bloco 59.
   */
  const linhas = await tx.$queryRaw<
    {
      customer_id: string;
      mode: string;
      scope: string;
      location_id: string | null;
      amount: number;
    }[]
  >`
    SELECT customer_id, mode::text AS mode, scope::text AS scope, location_id,
           sum(amount)::int AS amount
      FROM loyalty_entries
     WHERE order_id = ${orderId}::uuid AND kind = 'acumulo'
     GROUP BY customer_id, mode, scope, location_id
  `;

  let desfeito = 0;
  for (const linha of linhas) {
    if (linha.amount <= 0) continue;
    await tx.$executeRaw`
      INSERT INTO loyalty_entries
        (tenant_id, customer_id, order_id, kind, mode, amount, note, scope, location_id)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${linha.customer_id}::uuid, ${orderId}::uuid, 'ajuste',
        ${linha.mode}::loyalty_mode, ${-linha.amount},
        'Estorno da venda',
        ${linha.scope}::escopo_multiunidade, ${linha.location_id}::uuid
      )
    `;
    desfeito += linha.amount;
  }
  return desfeito;
}


/**
 * Descobre se a dívida criada por esta venda ainda está integralmente em
 * aberto. O recebimento de fiado não carrega `order_id`: ele quita a dívida
 * mais antiga da unidade. Por isso a prova é reconstruída em FIFO a partir do
 * razão, em vez de procurar uma FK que não existe.
 *
 * Se qualquer crédito/pagamento já tiver reduzido esta dívida, o estorno
 * automático é bloqueado. Inventar uma devolução nesse ponto poderia criar
 * crédito artificial ou devolver por um meio diferente daquele em que o
 * cliente pagou.
 */
async function validarFiadoParaEstorno(
  tx: TransactionClient,
  params: {
    readonly orderId: string;
    readonly customerId: string | null;
    readonly locationId: string;
  },
): Promise<void> {
  if (!params.customerId) return;

  const origem = await tx.$queryRaw<
    { amount_cents: number; location_id: string | null }[]
  >`
    SELECT amount_cents, location_id
      FROM customer_ledger
     WHERE customer_id = ${params.customerId}::uuid
       AND order_id = ${params.orderId}::uuid
       AND kind = 'fiado'
     ORDER BY created_at, id
  `;
  if (origem.length === 0) return;

  // A mesma trava usada por `receberFiado`: depois dela nenhum recebimento do
  // cliente passa até esta transação terminar.
  await tx.$executeRaw`
    SELECT 1 FROM customers WHERE id = ${params.customerId}::uuid FOR UPDATE
  `;

  for (const fiado of origem) {
    const local = fiado.location_id ?? params.locationId;
    const linhas = await tx.$queryRaw<
      { id: string; amount_cents: number; order_id: string | null }[]
    >`
      SELECT id, amount_cents, order_id
        FROM customer_ledger
       WHERE customer_id = ${params.customerId}::uuid
         AND location_id IS NOT DISTINCT FROM ${local}::uuid
       ORDER BY created_at, id
    `;

    type Divida = { orderId: string | null; original: number; restante: number };
    const fila: Divida[] = [];
    let creditoLivre = 0;
    let alvoOriginal = 0;
    let alvoRestante = 0;

    for (const linha of linhas) {
      if (linha.amount_cents < 0) {
        let divida = -linha.amount_cents;
        const abatidoPorCredito = Math.min(creditoLivre, divida);
        creditoLivre -= abatidoPorCredito;
        divida -= abatidoPorCredito;
        const item: Divida = {
          orderId: linha.order_id,
          original: -linha.amount_cents,
          restante: divida,
        };
        fila.push(item);
        if (linha.order_id === params.orderId) {
          alvoOriginal += item.original;
          alvoRestante += item.restante;
        }
        continue;
      }

      let valor = linha.amount_cents;
      while (valor > 0 && fila.length > 0) {
        const divida = fila[0]!;
        if (divida.restante === 0) {
          fila.shift();
          continue;
        }
        const abatido = Math.min(valor, divida.restante);
        divida.restante -= abatido;
        valor -= abatido;
        if (divida.orderId === params.orderId) alvoRestante -= abatido;
        if (divida.restante === 0) fila.shift();
      }
      creditoLivre += valor;
    }

    if (alvoOriginal > 0 && alvoRestante < alvoOriginal) recusar('fiado_ja_recebido');
  }
}

/**
 * Uma devolução em dinheiro é uma saída física e precisa ter uma gaveta aberta
 * com saldo suficiente. O estorno antigo simplesmente ignorava a ausência do
 * caixa: o pedido virava `refunded` e nenhuma saída aparecia no caixa.
 */
async function validarGavetaParaEstorno(
  tx: TransactionClient,
  params: { readonly orderId: string; readonly locationId: string },
): Promise<void> {
  const vendas = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(amount_cents)::bigint AS total
      FROM cash_movements
     WHERE order_id = ${params.orderId}::uuid AND kind = 'sale'
  `;
  const entrou = inteiroSeguroDoBanco(vendas[0]?.total, 'dinheiro da venda na gaveta');
  if (entrou <= 0) return;

  const sessoes = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM cash_sessions
     WHERE location_id = ${params.locationId}::uuid AND status = 'open'
     FOR UPDATE
  `;
  const sessao = sessoes[0];
  if (!sessao) recusar('caixa_sem_saldo_para_estorno');

  const movimentos = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(amount_cents)::bigint AS total FROM cash_movements
     WHERE session_id = ${sessao.id}::uuid
  `;
  const naGaveta = inteiroSeguroDoBanco(movimentos[0]?.total, 'saldo da gaveta para estorno');
  if (naGaveta < entrou) recusar('caixa_sem_saldo_para_estorno');
}

/**
 * O fiado lançado nesta venda é abatido do saldo.
 *
 * O cliente devia R$ 80 porque levou um corte; a venda foi desfeita e ele não
 * deve mais. O lançamento é `adjustment` com sinal positivo — abater dívida — e
 * a nota diz de onde veio, porque o extrato do fiado é o documento que precisa
 * explicar cada centavo.
 */
async function abaterFiado(
  tx: TransactionClient,
  params: {
    readonly orderId: string;
    readonly customerId: string | null;
    readonly locationId: string;
    readonly staffId: string;
    readonly staffName: string;
  },
): Promise<number> {
  if (!params.customerId) return 0;

  const linhas = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(amount_cents)::bigint AS total FROM order_payments
     WHERE order_id = ${params.orderId}::uuid AND method = 'fiado'
  `;
  const fiadoCents = inteiroSeguroDoBanco(linhas[0]?.total, 'fiado da venda estornada');
  if (fiadoCents <= 0) return 0;

  await lancarNoExtrato(tx, {
    customerId: params.customerId,
    kind: 'adjustment',
    amountCents: fiadoCents,
    orderId: params.orderId,
    note: 'Venda estornada',
    staffId: params.staffId,
    staffName: params.staffName,
    // A mesma loja da venda: o estorno tem que abater no bolso em que a dívida
    // nasceu, senão a loja de origem fica devendo para sempre e a outra fica com
    // crédito que ninguém criou (bloco 59).
    locationId: params.locationId,
  });

  return fiadoCents;
}

/**
 * O dinheiro sai da gaveta de volta, quando ele entrou por lá.
 *
 * A devolução só acontece com caixa aberto e saldo suficiente. Sem isso, o
 * estorno é recusado antes de marcar a venda como devolvida: a saída física não
 * pode existir sem o movimento correspondente no caixa.
 */
async function devolverAGaveta(
  tx: TransactionClient,
  params: {
    readonly orderId: string;
    readonly locationId: string;
    readonly staffId: string;
    readonly staffName: string;
  },
): Promise<number> {
  const linhas = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(amount_cents)::bigint AS total FROM cash_movements
     WHERE order_id = ${params.orderId}::uuid AND kind = 'sale'
  `;
  const entrou = inteiroSeguroDoBanco(linhas[0]?.total, 'dinheiro da venda na gaveta');
  if (entrou <= 0) return 0;

  const sessoes = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM cash_sessions
     WHERE location_id = ${params.locationId}::uuid AND status = 'open'
     FOR UPDATE
  `;
  const sessao = sessoes[0];
  if (!sessao) recusar('caixa_sem_saldo_para_estorno');

  const saldos = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(amount_cents)::bigint AS total FROM cash_movements
     WHERE session_id = ${sessao.id}::uuid
  `;
  const naGaveta = inteiroSeguroDoBanco(saldos[0]?.total, 'saldo da gaveta para estorno');
  if (naGaveta < entrou) recusar('caixa_sem_saldo_para_estorno');

  await tx.$executeRaw`
    INSERT INTO cash_movements
      (tenant_id, session_id, kind, amount_cents, reason, order_id, created_by,
       created_by_name)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${sessao.id}::uuid, 'adjustment'::cash_movement_type, ${-entrou},
      'Estorno de venda', ${params.orderId}::uuid, ${params.staffId}::uuid,
      ${params.staffName}
    )
  `;
  return entrou;
}

// ---------------------------------------------------------------------------
// Transferência de pacote (SPEC §4.7)
// ---------------------------------------------------------------------------

export type TransferenciaDePacoteFailure =
  | 'pacote_nao_encontrado'
  | 'pacote_nao_transferivel'
  | 'sem_saldo'
  | 'mesma_pessoa'
  | 'destino_nao_encontrado'
  | 'motivo_obrigatorio'
  | 'pacote_reembolsado'
  | 'estorno_da_venda_em_curso';

export class TransferenciaDePacoteError extends Error {
  constructor(readonly code: TransferenciaDePacoteFailure, message: string) {
    super(message);
    this.name = 'TransferenciaDePacoteError';
  }
}

const MENSAGEM_DA_TRANSFERENCIA: Readonly<
  Record<TransferenciaDePacoteFailure, string>
> = {
  pacote_nao_encontrado: 'Este pacote não existe.',
  pacote_nao_transferivel: 'Este pacote foi vendido como intransferível.',
  sem_saldo: 'Não há unidades para transferir.',
  mesma_pessoa: 'Escolha outra pessoa.',
  destino_nao_encontrado: 'Cliente de destino não encontrado.',
  motivo_obrigatorio: 'Escreva o motivo.',
  pacote_reembolsado: 'Este pacote já foi reembolsado.',
  estorno_da_venda_em_curso: 'A venda que criou este pacote está em processo de estorno.',
};

/**
 * Passa as unidades restantes para outra pessoa.
 *
 * ## O que se move e o que fica
 *
 * Movem-se as **unidades restantes**. A receita já reconhecida em
 * `package_uses` fica com o primeiro dono, com a data em que foi reconhecida —
 * ela é fato consumado, e reatribuí-la reescreveria o resultado de um mês que
 * já fechou. É a mesma razão de a comissão fechada ser imutável.
 *
 * ## `transferable` é lido da compra, não do catálogo
 *
 * A coluna é congelada em cada `customer_packages` desde o bloco 42. Ligar a
 * transferência no catálogo hoje não pode tornar transferível o pacote vendido
 * ontem como intransferível — o cliente comprou uma coisa e receberia outra.
 */
export async function transferirPacote(params: {
  readonly tenantId: string;
  readonly customerPackageId: string;
  readonly paraCustomerId: string;
  readonly motivo: string;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly unidadesMovidas: number }> {
  const motivo = params.motivo.trim();
  if (motivo.length < 3) {
    throw new TransferenciaDePacoteError(
      'motivo_obrigatorio',
      MENSAGEM_DA_TRANSFERENCIA.motivo_obrigatorio,
    );
  }

  return withTenant(params.tenantId, async (tx) => {
    const travado = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customer_packages
       WHERE id = ${params.customerPackageId}::uuid
       FOR UPDATE
    `;
    if (!travado[0]) falharNaTransferencia('pacote_nao_encontrado');

    // Snapshot novo depois da trava: uso/refund que terminou enquanto esta
    // transação esperava precisa fazer parte da decisão de transferência.
    const linhas = await tx.$queryRaw<
      {
        id: string;
        customer_id: string;
        quantity: number;
        transferable: boolean;
        refunded_at: Date | null;
        refund_pending: boolean;
        usados: number;
      }[]
    >`
      SELECT p.id, p.customer_id, p.quantity, p.transferable, p.refunded_at,
             EXISTS (
               SELECT 1 FROM order_charges oc
                WHERE oc.order_id = p.order_id AND oc.refund_pending_at IS NOT NULL
             ) AS refund_pending,
             (SELECT count(*) FROM package_uses u WHERE u.customer_package_id = p.id)::int
               AS usados
        FROM customer_packages p
       WHERE p.id = ${params.customerPackageId}::uuid
    `;
    const pacote = linhas[0];
    if (!pacote) falharNaTransferencia('pacote_nao_encontrado');
    if (pacote.refunded_at) falharNaTransferencia('pacote_reembolsado');
    if (pacote.refund_pending) falharNaTransferencia('estorno_da_venda_em_curso');
    if (!pacote.transferable) falharNaTransferencia('pacote_nao_transferivel');
    if (pacote.customer_id === params.paraCustomerId) falharNaTransferencia('mesma_pessoa');

    const restam = restamNoPacote({ total: pacote.quantity, usados: pacote.usados });
    if (restam <= 0) falharNaTransferencia('sem_saldo');

    // Conferido sob RLS antes de gravar: a chave estrangeira aceitaria o
    // cliente de outra barbearia, porque a checagem referencial ignora row
    // security.
    const destino = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customers WHERE id = ${params.paraCustomerId}::uuid
    `;
    if (destino.length === 0) falharNaTransferencia('destino_nao_encontrado');

    await tx.$executeRaw`
      UPDATE customer_packages SET customer_id = ${params.paraCustomerId}::uuid
       WHERE id = ${params.customerPackageId}::uuid
    `;

    await tx.$executeRaw`
      INSERT INTO package_transfers
        (tenant_id, customer_package_id, from_customer_id, to_customer_id,
         units_moved, reason, created_by, created_by_name)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.customerPackageId}::uuid, ${pacote.customer_id}::uuid,
        ${params.paraCustomerId}::uuid, ${restam}, ${motivo},
        ${params.staffId}::uuid, ${params.staffName}
      )
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'package.transferred',
      entity: 'customer_package',
      entityId: params.customerPackageId,
      before: { customerId: pacote.customer_id },
      after: { customerId: params.paraCustomerId, unidadesMovidas: restam, motivo },
    });

    return { unidadesMovidas: restam };
  });
}
