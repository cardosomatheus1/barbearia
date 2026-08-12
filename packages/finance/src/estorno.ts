import { withTenant, type TransactionClient } from '@barbearia/db';
import { podeEstornar, restamNoPacote, type EstornoFailure } from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { estornarComissaoDaComanda } from './comissao.js';
import { estornarSplitDaVenda } from './split.js';
import { moverEstoque, EstoqueError } from './estoque.js';
import { lancarNoExtrato } from './comanda.js';

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

    const fidelidadeDesfeitaCents = await desfazerAcumuloDeFidelidade(tx, params.orderId);
    const fiadoAbatidoCents = await abaterFiado(tx, {
      orderId: params.orderId,
      customerId: venda.customer_id,
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
  const linhas = await tx.$queryRaw<
    { customer_id: string; mode: string; amount: number }[]
  >`
    SELECT customer_id, mode::text AS mode, sum(amount)::int AS amount
      FROM loyalty_entries
     WHERE order_id = ${orderId}::uuid AND kind = 'acumulo'
     GROUP BY customer_id, mode
  `;

  let desfeito = 0;
  for (const linha of linhas) {
    if (linha.amount <= 0) continue;
    await tx.$executeRaw`
      INSERT INTO loyalty_entries
        (tenant_id, customer_id, order_id, kind, mode, amount, note)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${linha.customer_id}::uuid, ${orderId}::uuid, 'ajuste',
        ${linha.mode}::loyalty_mode, ${-linha.amount},
        'Estorno da venda'
      )
    `;
    desfeito += linha.amount;
  }
  return desfeito;
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
    readonly staffId: string;
    readonly staffName: string;
  },
): Promise<number> {
  if (!params.customerId) return 0;

  const linhas = await tx.$queryRaw<{ total: number | null }[]>`
    SELECT sum(amount_cents)::int AS total FROM order_payments
     WHERE order_id = ${params.orderId}::uuid AND method = 'fiado'
  `;
  const fiadoCents = linhas[0]?.total ?? 0;
  if (fiadoCents <= 0) return 0;

  await lancarNoExtrato(tx, {
    customerId: params.customerId,
    kind: 'adjustment',
    amountCents: fiadoCents,
    orderId: params.orderId,
    note: 'Venda estornada',
    staffId: params.staffId,
    staffName: params.staffName,
  });

  return fiadoCents;
}

/**
 * O dinheiro sai da gaveta de volta, quando ele entrou por lá.
 *
 * Só quando há caixa aberto: sem sessão, a devolução não tem onde ser lançada e
 * o estorno **não para por isso** — é a mesma decisão do Pix confirmado sem
 * gaveta aberta do bloco 35. O que fica sem registro é a saída física, e ela
 * aparece na conferência do dia, que é onde tem que aparecer.
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
  const linhas = await tx.$queryRaw<{ total: number | null }[]>`
    SELECT sum(amount_cents)::int AS total FROM cash_movements
     WHERE order_id = ${params.orderId}::uuid AND kind = 'sale'
  `;
  const entrou = linhas[0]?.total ?? 0;
  if (entrou <= 0) return 0;

  const sessoes = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM cash_sessions
     WHERE location_id = ${params.locationId}::uuid AND status = 'open'
     FOR UPDATE
  `;
  const sessao = sessoes[0];
  if (!sessao) return 0;

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
  | 'pacote_reembolsado';

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
    const linhas = await tx.$queryRaw<
      {
        id: string;
        customer_id: string;
        quantity: number;
        transferable: boolean;
        refunded_at: Date | null;
        usados: number;
      }[]
    >`
      SELECT p.id, p.customer_id, p.quantity, p.transferable, p.refunded_at,
             (SELECT count(*) FROM package_uses u WHERE u.customer_package_id = p.id)::int
               AS usados
        FROM customer_packages p
       WHERE p.id = ${params.customerPackageId}::uuid
       FOR UPDATE
    `;
    const pacote = linhas[0];
    if (!pacote) falharNaTransferencia('pacote_nao_encontrado');
    if (pacote.refunded_at) falharNaTransferencia('pacote_reembolsado');
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
