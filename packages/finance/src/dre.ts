import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  aplicarModeloDaAssinatura,
  ehConsolidado,
  comissaoDoPeriodo,
  compararDre,
  montarDre,
  periodoAnterior,
  type DreComparado,
  type EscolhaDeUnidade,
  type FatosDoDre,
} from '@barbearia/core';
import { lerModeloDaAssinatura, paraLancamento } from './comissao.js';

/**
 * DRE gerencial, do banco para a tela (bloco 52, SPEC §3.10).
 *
 * ## O SQL carrega; a conta é do domínio
 *
 * Cada consulta aqui devolve **soma de fatos**, nunca regra de negócio. A
 * comissão é o caso que prova a decisão: calculá-la dentro da consulta seria
 * impossível de fazer certo, porque faixa progressiva depende do acumulado do
 * período — e foi por tentar isso que o bloco 44 leu uma coluna inexistente sem
 * nada ficar vermelho.
 *
 * ## Não existe tabela de DRE
 *
 * Cada linha é derivada. Uma tabela de resultado seria um número que alguém
 * sobrescreve, e a pergunta que chega é sempre *"por que caiu?"* — que só o
 * fato responde.
 *
 * ## Toda linha é recortada pela unidade
 *
 * Todas filtram por `location_id` direto ou pelo `orders` de onde vieram. A
 * mensalidade do clube era a exceção declarada — `club_invoices` não tinha
 * unidade porque a assinatura é do cliente com a barbearia, não com uma loja —
 * e o bloco 58 a fechou: `club_subscriptions.location_id` guarda **onde a
 * adesão aconteceu**, congelado. Não é inventar o dado; é gravar o que se sabe
 * no momento em que se sabe.
 *
 * A assinatura anterior ao bloco 58 tem unidade nula. Ela entra no consolidado,
 * mas **não** é atribuída a cada loja: repetir o mesmo dinheiro em Matriz e
 * Filial faria a soma das unidades ser maior que a rede.
 *
 * A inconsistência era achado da `/security-review` deste bloco: metade das
 * consultas filtrava e a outra metade não, o que produziria um DRE "da Matriz"
 * com o CMV das duas lojas dentro.
 *
 * ## O recorte é `business_day`, nunca `closed_at`
 *
 * `closed_at` responde "que instante"; `business_day` responde "de que dia é
 * este dinheiro". A comanda fechada às 23h50 de sábado é receita de sábado, e
 * em UTC ela seria de domingo — o defeito D2 aplicado ao número do relatório.
 */

export interface DreDoPeriodo extends DreComparado {
  readonly de: string;
  readonly ate: string;
  readonly comparadoDe: string;
  readonly comparadoAte: string;
}

export async function dreDoPeriodo(params: {
  readonly tenantId: string;
  /**
   * A loja do relatório, ou `TODAS_AS_UNIDADES` para o consolidado (bloco 129).
   *
   * **Não** é `string | null`, e a diferença é a que o bloco 117 cobrou: nulo
   * seria indistinguível de "o chamador esqueceu", que é como oito leituras
   * passaram a somar a rede sem ninguém ter decidido isso. `'todas'` é uma
   * palavra que só se escreve de propósito, e o tipo obrigatório faz o
   * compilador cobrar a decisão de quem escrever a próxima rota.
   *
   * O consolidado é de **leitura**, nunca de operação: caixa, comanda e agenda
   * continuam sendo de uma loja, e somá-las faria a recepção fechar o caixa da
   * loja errada. É o que o cabeçalho de `multiunidade.ts` já dizia.
   */
  readonly unidade: EscolhaDeUnidade;
  readonly de: string;
  readonly ate: string;
  /** Relógio injetável para não reconhecer vencimento futuro dentro do dia corrente. */
  readonly agora?: Date;
}): Promise<DreDoPeriodo> {
  const agora = params.agora ?? new Date();
  const anterior = periodoAnterior(params.de, params.ate);
  const locationId = ehConsolidado(params.unidade) ? null : params.unidade;

  return withTenant(params.tenantId, async (tx) => {
    const [atual, passado] = await Promise.all([
      fatosDoPeriodo(tx, { locationId, de: params.de, ate: params.ate, agora }),
      fatosDoPeriodo(tx, { locationId, ...anterior, agora }),
    ]);

    return {
      ...compararDre(montarDre(atual), montarDre(passado)),
      de: params.de,
      ate: params.ate,
      comparadoDe: anterior.de,
      comparadoAte: anterior.ate,
    };
  });
}

/**
 * As oito linhas, cada uma da sua fonte.
 *
 * Todas filtram por venda **`paid`**: a estornada não é receita, e é o estado
 * novo do bloco 52 que faz esta frase ser verdade — antes dele a venda desfeita
 * continuava somando aqui, no faturamento do dia e no ticket médio.
 */
async function fatosDoPeriodo(
  tx: TransactionClient,
  params: {
    readonly locationId: string | null;
    readonly de: string;
    readonly ate: string;
    readonly agora: Date;
  },
): Promise<FatosDoDre> {
  const receitas = await tx.$queryRaw<
    { tipo: string | null; total: bigint | null }[]
  >`
    -- O item continua com o preço congelado porque ele é também a base da
    -- comissão. Para o DRE, porém, a forma de pagamento decide se esse preço
    -- representa receita nova ou consumo de uma obrigação já reconhecida.
    SELECT i.kind::text AS tipo, sum(i.quantity::bigint * i.unit_price_cents)::bigint AS total
      FROM order_items i
      JOIN orders o ON o.id = i.order_id
     WHERE (${params.locationId}::uuid IS NULL OR o.location_id = ${params.locationId}::uuid)
       AND o.status = 'paid'
       AND o.business_day BETWEEN ${params.de}::date AND ${params.ate}::date
     GROUP BY i.kind
  `;

  const servicoCents = somaDe(receitas, 'service');
  const produtoCents = somaDe(receitas, 'product');

  /**
   * Uso do clube não é uma segunda receita. A mensalidade já entra por
   * `club_invoices`; `order_items` mantém o preço do serviço só para comissão e
   * rentabilidade. Subtrair exatamente o que foi quitado por `assinatura` evita
   * contar mensalidade + benefício como duas vendas. Complemento em dinheiro
   * continua na receita do serviço porque não aparece nesta soma.
   */
  const cobertoPelaAssinatura = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(p.amount_cents)::bigint AS total
      FROM order_payments p
      JOIN orders o ON o.id = p.order_id
     WHERE (${params.locationId}::uuid IS NULL OR o.location_id = ${params.locationId}::uuid)
       AND o.status = 'paid'
       AND o.business_day BETWEEN ${params.de}::date AND ${params.ate}::date
       AND p.method = 'assinatura'
  `;

  /**
   * Saldo de pacote que vence é receita no dia em que a obrigação acaba.
   *
   * Não precisa de varredura nem de linha mutável: `expires_at` é congelado na
   * compra e pacote vencido não pode ser reembolsado. O saldo é preço pago menos
   * tudo que `package_uses` já reconheceu; assim o centavo de resto também fecha.
   * A unidade é a da venda original do pacote e o dia é calculado no fuso dela.
   */
  const pacotesVencidos = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(
             GREATEST(
               cp.price_cents - COALESCE((
                 SELECT sum(u.value_cents)::bigint
                   FROM package_uses u
                  WHERE u.customer_package_id = cp.id
               ), 0),
               0
             )
           )::bigint AS total
      FROM customer_packages cp
      JOIN orders venda ON venda.id = cp.order_id
      JOIN locations l ON l.id = venda.location_id
     WHERE cp.refunded_at IS NULL
       AND cp.expires_at IS NOT NULL
       -- O dia sozinho não basta no período corrente: antes do horário exato do
       -- vencimento o saldo ainda é obrigação e não pode ser receita também.
       AND cp.expires_at <= ${params.agora}
       AND (${params.locationId}::uuid IS NULL OR venda.location_id = ${params.locationId}::uuid)
       AND (cp.expires_at AT TIME ZONE l.timezone)::date
             BETWEEN ${params.de}::date AND ${params.ate}::date
  `;

  /**
   * A mensalidade do clube é reconhecida quando a fatura é paga.
   *
   * Para assinatura com unidade, o dia é o da própria unidade. As assinaturas
   * históricas sem `location_id` entram apenas no consolidado; não são atribuídas
   * retroativamente a cada loja. Como o fuso histórico delas é desconhecido,
   * somente esse legado usa UTC como fallback explícito.
   */
  const assinaturas = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(f.amount_cents)::bigint AS total
      FROM club_invoices f
      JOIN club_subscriptions s ON s.id = f.subscription_id
      LEFT JOIN locations l ON l.id = s.location_id
     WHERE f.status = 'paga'
       AND f.paid_at IS NOT NULL
       AND (f.paid_at AT TIME ZONE COALESCE(l.timezone, 'UTC'))::date
             BETWEEN ${params.de}::date AND ${params.ate}::date
       AND (${params.locationId}::uuid IS NULL OR s.location_id = ${params.locationId}::uuid)
  `;

  const comissoesCents = await comissaoDoIntervalo(tx, params);

  /**
   * O custo da venda **estornada** sai daqui, e não saía.
   *
   * O rodapé da tela diz em letras *"venda estornada sai de todas as linhas"* —
   * saía de sete e não saía desta. `devolverProdutos` põe o produto de volta na
   * prateleira com `kind = 'entrada'`, que não está no filtro, e a devolução é
   * carimbada no dia do estorno: o custo continuava no mês da venda para
   * sempre, com a receita já removida. Num estorno medido, o resultado caiu
   * R$ 154,00 (a receita inteira) onde deveria cair R$ 120,00 — e a unidade
   * estava de volta no estoque, pronta para ser vendida de novo.
   *
   * O consumo interno fica: o insumo foi usado no atendimento, e estornar a
   * venda não faz o shampoo voltar ao frasco. É a mesma razão pela qual o
   * estorno não devolve unidade de pacote.
   *
   * Pelo `order_id` e não por data, porque a devolução tem `business_day` de
   * outro mês: quem casa é a venda.
   */
  const cmv = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(abs(m.quantity)::bigint * m.unit_cost_cents)::bigint AS total
      FROM stock_movements m
      LEFT JOIN orders o ON o.id = m.order_id
     WHERE m.kind IN ('venda', 'consumo')
       AND (${params.locationId}::uuid IS NULL OR m.location_id = ${params.locationId}::uuid)
       AND m.business_day BETWEEN ${params.de}::date AND ${params.ate}::date
       AND (m.kind = 'consumo' OR o.id IS NULL OR o.status <> 'refunded')
  `;

  /**
   * O que a casa abriu mão — a lacuna que este bloco fecha.
   *
   * `orders.discount_cents`, e não a diferença entre item e total: o total já
   * carrega a gorjeta, que não é da casa, e subtrair um do outro misturaria
   * duas coisas que a comanda guarda separadas de propósito.
   *
   * Sem esta linha o relatório somava o preço cheio do item contra a comissão
   * calculada sobre o valor com desconto, e o resultado do mês crescia no valor
   * exato do que foi concedido. A comissão sempre soube — `base_cents` é o
   * total descontado —, e era só o relatório do dono que não.
   */
  const descontos = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(o.discount_cents)::bigint AS total
      FROM orders o
     WHERE (${params.locationId}::uuid IS NULL OR o.location_id = ${params.locationId}::uuid)
       AND o.status = 'paid'
       AND o.business_day BETWEEN ${params.de}::date AND ${params.ate}::date
  `;

  const taxas = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(o.fee_cents)::bigint AS total
      FROM orders o
     WHERE (${params.locationId}::uuid IS NULL OR o.location_id = ${params.locationId}::uuid)
       AND o.status = 'paid'
       AND o.business_day BETWEEN ${params.de}::date AND ${params.ate}::date
  `;

  /**
   * O custo do programa de fidelidade — a lacuna que este bloco fecha.
   *
   * Sai de `order_payments`, e não de `loyalty_entries`: ali o valor está na
   * unidade do modo (pontos, visitas ou centavos), e só o pagamento sabe quantos
   * **reais** o crédito abateu. Somar pontos como se fossem centavos daria um
   * número sem unidade num relatório de dinheiro.
   */
  const fidelidade = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(p.amount_cents)::bigint AS total
      FROM order_payments p
      JOIN orders o ON o.id = p.order_id
     WHERE (${params.locationId}::uuid IS NULL OR o.location_id = ${params.locationId}::uuid)
       AND o.status = 'paid'
       AND o.business_day BETWEEN ${params.de}::date AND ${params.ate}::date
       AND p.method = 'fidelidade'
  `;

  /**
   * A despesa operacional é a conta **paga** do bloco 51.
   *
   * Pelo dia do pagamento e não pelo vencimento: é quando o dinheiro saiu. A
   * conta que vence em agosto e é paga em setembro é despesa de setembro para
   * quem administra caixa, que é para quem este relatório existe.
   */
  const despesas = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(b.paid_cents)::bigint AS total
      FROM bills b
     WHERE (${params.locationId}::uuid IS NULL OR b.location_id = ${params.locationId}::uuid)
       AND b.direction = 'pagar'
       AND b.status = 'paga'
       AND b.paid_on BETWEEN ${params.de}::date AND ${params.ate}::date
  `;

  /**
   * O que venceu no período e continua em aberto.
   *
   * Pelo **vencimento**, e não pelo pagamento: a pergunta é o que deveria ter
   * saído e não saiu. Não entra em conta nenhuma — é a ressalva que a tela
   * escreve ao lado da linha de despesa.
   */
  const emAberto = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(b.amount_cents)::bigint AS total
      FROM bills b
     WHERE (${params.locationId}::uuid IS NULL OR b.location_id = ${params.locationId}::uuid)
       AND b.direction = 'pagar'
       AND b.status = 'aberta'
       AND b.due_on BETWEEN ${params.de}::date AND ${params.ate}::date
  `;

  /**
   * A gorjeta do período: repasse, e por isso fora das duas somas.
   *
   * Pelo `business_day` da venda, como todo o resto deste relatório.
   */
  const gorjetas = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(o.tip_cents)::bigint AS total
      FROM orders o
     WHERE (${params.locationId}::uuid IS NULL OR o.location_id = ${params.locationId}::uuid)
       AND o.status = 'paid'
       AND o.business_day BETWEEN ${params.de}::date AND ${params.ate}::date
  `;

  return {
    receitaServicosCents:
      servicoCents
      - centavos(cobertoPelaAssinatura[0]?.total)
      + centavos(pacotesVencidos[0]?.total),
    receitaProdutosCents: produtoCents,
    receitaAssinaturasCents: centavos(assinaturas[0]?.total),
    descontosCents: centavos(descontos[0]?.total),
    comissoesCents,
    cmvCents: centavos(cmv[0]?.total),
    taxasCents: centavos(taxas[0]?.total),
    fidelidadeCents: centavos(fidelidade[0]?.total),
    despesasCents: centavos(despesas[0]?.total),
    despesasEmAbertoCents: centavos(emAberto[0]?.total),
    gorjetasCents: centavos(gorjetas[0]?.total),
  };
}

function centavos(valor: bigint | null | undefined): number {
  const numero = Number(valor ?? 0n);
  if (!Number.isSafeInteger(numero)) {
    throw new Error('Soma monetária ultrapassou o intervalo seguro do JavaScript.');
  }
  return numero;
}

function somaDe(
  linhas: readonly { tipo: string | null; total: bigint | null }[],
  tipo: string,
): number {
  return centavos(linhas.find((l) => l.tipo === tipo)?.total);
}

/**
 * A comissão do intervalo, pela mesma conta do extrato e do fechamento.
 *
 * Inclui o que já foi fechado: o DRE é sobre o **custo do período**, e a folha
 * de agosto é custo de agosto tenha ela sido fechada ou não. Filtrar por
 * `closure_id IS NULL` mostraria o resultado melhorando toda vez que alguém
 * fechasse a comissão, que é o oposto do que aconteceu.
 */
async function comissaoDoIntervalo(
  tx: TransactionClient,
  params: {
    readonly locationId: string | null;
    readonly de: string;
    readonly ate: string;
    readonly agora: Date;
  },
): Promise<number> {
  const linhas = await tx.$queryRaw<
    {
      id: string;
      professional_id: string;
      professional_name: string;
      rule_id: string | null;
      mode: string;
      value: number;
      tiers: unknown;
      base_cents: number;
      sign: number;
      club_subscription_id: string | null;
      subscription_fee_cents: number | null;
    }[]
  >`
    SELECT e.id, e.professional_id, p.name AS professional_name,
           e.rule_id, e.mode, e.value, e.tiers, e.base_cents, e.sign,
           e.club_subscription_id, e.subscription_fee_cents
      FROM commission_entries e
      JOIN professionals p ON p.id = e.professional_id
      -- INNER e nao LEFT: e a comanda que carrega a unidade, e sem ela o
      -- lancamento nao tem como ser atribuido a uma. Lancamento sem comanda nao
      -- existe em producao — lancarComissaoDaComanda sempre grava o id, e a
      -- aplicacao nao apaga comanda —, e um LEFT JOIN somaria orfao em toda
      -- unidade, contando o mesmo dinheiro duas vezes na rede.
      JOIN orders o ON o.id = e.order_id
     WHERE (${params.locationId}::uuid IS NULL OR o.location_id = ${params.locationId}::uuid)
       AND e.earned_on BETWEEN ${params.de}::date AND ${params.ate}::date
     ORDER BY e.earned_on, e.id
  `;
  if (linhas.length === 0) return 0;

  const modelo = await lerModeloDaAssinatura(tx);
  const contas = comissaoDoPeriodo(
    aplicarModeloDaAssinatura(
      linhas.map((l) => paraLancamento(l as Parameters<typeof paraLancamento>[0])),
      modelo,
    ),
  );
  return contas.reduce((soma, conta) => soma + conta.comissaoCents, 0);
}
