import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  aplicarModeloDaAssinatura,
  comissaoDoPeriodo,
  compararDre,
  montarDre,
  periodoAnterior,
  type DreComparado,
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
 * A assinatura anterior ao bloco 58 tem unidade nula, e ela conta para **todas**
 * as leituras: o dinheiro é da barbearia, e somir de todas seria pior que
 * aparecer em cada uma.
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
  readonly locationId: string;
  readonly de: string;
  readonly ate: string;
}): Promise<DreDoPeriodo> {
  const anterior = periodoAnterior(params.de, params.ate);

  return withTenant(params.tenantId, async (tx) => {
    const [atual, passado] = await Promise.all([
      fatosDoPeriodo(tx, { locationId: params.locationId, de: params.de, ate: params.ate }),
      fatosDoPeriodo(tx, { locationId: params.locationId, ...anterior }),
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
  params: { readonly locationId: string; readonly de: string; readonly ate: string },
): Promise<FatosDoDre> {
  const receitas = await tx.$queryRaw<
    { tipo: string | null; total: number | null }[]
  >`
    -- O total do item e o preco unitario vezes a quantidade: order_items guarda
    -- os dois separados. E a mesma conta que a margem por servico ja faz.
    SELECT i.kind::text AS tipo, sum(i.quantity * i.unit_price_cents)::int AS total
      FROM order_items i
      JOIN orders o ON o.id = i.order_id
     WHERE o.location_id = ${params.locationId}::uuid
       AND o.status = 'paid'
       AND o.business_day BETWEEN ${params.de}::date AND ${params.ate}::date
     GROUP BY i.kind
  `;

  const servicoCents = somaDe(receitas, 'service');
  const produtoCents = somaDe(receitas, 'product');
  /**
   * A venda de pacote **não** é receita do dia em que foi vendida.
   *
   * Ela é caixa; a receita é reconhecida no consumo, e é `package_uses` que
   * carrega o quando. Contá-la aqui mostraria um mês excelente seguido de meses
   * falsamente ruins — o defeito que a SPEC §4.7 nomeia em uma linha.
   */
  const pacotesReconhecidos = await tx.$queryRaw<{ total: number | null }[]>`
    SELECT sum(u.value_cents)::int AS total
      FROM package_uses u
      JOIN orders o ON o.id = u.order_id
     WHERE o.location_id = ${params.locationId}::uuid
       AND u.business_day BETWEEN ${params.de}::date AND ${params.ate}::date
  `;

  /**
   * A mensalidade do clube reconhecida no período.
   *
   * Sai da fatura **paga**, com o valor congelado na emissão. `club_invoices` é
   * o que o cliente paga à barbearia; `subscriptions` é o que a barbearia paga à
   * plataforma, e confundi-las aqui somaria o custo do produto como receita da
   * casa.
   */
  const assinaturas = await tx.$queryRaw<{ total: number | null }[]>`
    SELECT sum(f.amount_cents)::int AS total
      FROM club_invoices f
      JOIN club_subscriptions s ON s.id = f.subscription_id
     WHERE f.status = 'paga'
       AND f.paid_at IS NOT NULL
       AND (f.paid_at AT TIME ZONE 'UTC')::date
             BETWEEN ${params.de}::date AND ${params.ate}::date
       -- Assinatura anterior ao bloco 58 não tem unidade, e o dinheiro é da
       -- barbearia: ela entra em toda leitura em vez de sumir de todas. Um
       -- rateio retroativo seria inventar de qual loja veio.
       AND (s.location_id IS NULL OR s.location_id = ${params.locationId}::uuid)
  `;

  const comissoesCents = await comissaoDoIntervalo(tx, params);

  const cmv = await tx.$queryRaw<{ total: number | null }[]>`
    SELECT sum(abs(m.quantity) * m.unit_cost_cents)::int AS total
      FROM stock_movements m
     WHERE m.kind IN ('venda', 'consumo')
       AND m.location_id = ${params.locationId}::uuid
       AND m.business_day BETWEEN ${params.de}::date AND ${params.ate}::date
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
  const descontos = await tx.$queryRaw<{ total: number | null }[]>`
    SELECT sum(o.discount_cents)::int AS total
      FROM orders o
     WHERE o.location_id = ${params.locationId}::uuid
       AND o.status = 'paid'
       AND o.business_day BETWEEN ${params.de}::date AND ${params.ate}::date
  `;

  const taxas = await tx.$queryRaw<{ total: number | null }[]>`
    SELECT sum(o.fee_cents)::int AS total
      FROM orders o
     WHERE o.location_id = ${params.locationId}::uuid
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
  const fidelidade = await tx.$queryRaw<{ total: number | null }[]>`
    SELECT sum(p.amount_cents)::int AS total
      FROM order_payments p
      JOIN orders o ON o.id = p.order_id
     WHERE o.location_id = ${params.locationId}::uuid
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
  const despesas = await tx.$queryRaw<{ total: number | null }[]>`
    SELECT sum(b.paid_cents)::int AS total
      FROM bills b
     WHERE b.location_id = ${params.locationId}::uuid
       AND b.direction = 'pagar'
       AND b.status = 'paga'
       AND b.paid_on BETWEEN ${params.de}::date AND ${params.ate}::date
  `;

  return {
    receitaServicosCents: servicoCents + (pacotesReconhecidos[0]?.total ?? 0),
    receitaProdutosCents: produtoCents,
    receitaAssinaturasCents: assinaturas[0]?.total ?? 0,
    descontosCents: descontos[0]?.total ?? 0,
    comissoesCents,
    cmvCents: cmv[0]?.total ?? 0,
    taxasCents: taxas[0]?.total ?? 0,
    fidelidadeCents: fidelidade[0]?.total ?? 0,
    despesasCents: despesas[0]?.total ?? 0,
  };
}

function somaDe(
  linhas: readonly { tipo: string | null; total: number | null }[],
  tipo: string,
): number {
  return linhas.find((l) => l.tipo === tipo)?.total ?? 0;
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
  params: { readonly locationId: string; readonly de: string; readonly ate: string },
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
     WHERE o.location_id = ${params.locationId}::uuid
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
