import type { TransactionClient } from '@barbearia/db';
import {
  baseDoItem,
  escolherRegra,
  ratearDesconto,
  ratearTaxa,
  taxaSobreOsItens,
  type FaixaDeComissao,
  type LancamentoNoPeriodo,
  type ModoDeComissao,
} from '@barbearia/core';

import { lerConfiguracao, lerRegras } from './comissao-configuracao.js';

/**
 * Gera os lançamentos de uma comanda recém-fechada.
 *
 * Roda **dentro da transação que fecha a comanda**. Fora dela existiria a
 * janela em que a venda aconteceu e a comissão não — e ela apareceria como
 * dinheiro faltando no acerto do barbeiro, sem nada dizendo por quê.
 *
 * Item sem profissional não gera lançamento: produto vendido no balcão sem
 * ninguém atribuído é receita da casa. Item cujo profissional não tem regra
 * também não gera — e isso é ausência de configuração, não comissão zero. A
 * diferença aparece na tela, que lista quem ficou de fora.
 */
export async function lancarComissaoDaComanda(
  tx: TransactionClient,
  params: {
    readonly orderId: string;
    readonly quandoISO: string;
  },
): Promise<number> {
  const [config, regras] = await Promise.all([lerConfiguracao(tx), lerRegras(tx)]);
  if (regras.length === 0) return 0;

  const itens = await tx.$queryRaw<
    {
      id: string;
      professional_id: string | null;
      service_id: string | null;
      category_id: string | null;
      total_cents: number;
    }[]
  >`
    SELECT i.id, i.professional_id, i.service_id, s.category_id,
           (i.unit_price_cents * i.quantity)::int AS total_cents
      FROM order_items i
      LEFT JOIN services s ON s.id = i.service_id
     WHERE i.order_id = ${params.orderId}::uuid
     ORDER BY i.position, i.created_at
  `;

  const cabecas = await tx.$queryRaw<
    { discount_cents: number; tip_cents: number; fee_cents: number | null }[]
  >`
    SELECT discount_cents, tip_cents, fee_cents FROM orders WHERE id = ${params.orderId}::uuid
  `;
  const descontoCents = cabecas[0]?.discount_cents ?? 0;
  /**
   * Nulo é zero aqui, e é o comportamento de antes deste bloco.
   *
   * Toda venda fechada antes da migração 0038 não tem resposta para "quanto
   * custou de adquirente", e inventar um número para elas mudaria comissão já
   * paga.
   */
  const taxaCents = cabecas[0]?.fee_cents ?? 0;

  const comissionaveis = itens.map((item) => ({
    id: item.id,
    professionalId: item.professional_id,
    serviceId: item.service_id,
    categoryId: item.category_id,
    totalCents: item.total_cents,
  }));

  /**
   * Quais linhas desta comanda o plano cobriu (bloco 48).
   *
   * Por `order_item_id` e não por serviço: uma comanda com dois cortes e um
   * deles pago pelo plano marcaria os dois, e a comissão do corte que o cliente
   * pagou em dinheiro entraria no rateio da mensalidade. Teste de pertinência
   * não é teste de contagem — a lição do bloco 44.
   *
   * A mensalidade é lida **agora** e congelada no lançamento: renegociar o plano
   * em maio não pode mudar a comissão de abril.
   */
  const usosDoPlano = await tx.$queryRaw<
    { order_item_id: string; subscription_id: string; price_cents: number }[]
  >`
    SELECT u.order_item_id, u.subscription_id, s.price_cents
      FROM club_uses u
      JOIN club_subscriptions s ON s.id = u.subscription_id
     WHERE u.order_id = ${params.orderId}::uuid AND u.order_item_id IS NOT NULL
  `;
  const doPlano = new Map(
    usosDoPlano.map((u) => [u.order_item_id, { id: u.subscription_id, mensalidade: u.price_cents }]),
  );

  // O desconto é da comanda inteira e a comissão é por item: sem ratear, quem
  // cortou o cabelo pagaria sozinho o desconto dado na conta toda.
  const rateio = ratearDesconto({ itens: comissionaveis, descontoCents });

  /**
   * A taxa é rateada só sobre os itens, e por isso ela primeiro encolhe.
   *
   * O aparelho cobrou sobre tudo que passou nele — inclusive a gorjeta. Ratear
   * o valor cheio sobre os itens faria o barbeiro pagar tarifa sobre a própria
   * gorjeta, que "nunca entra na base". Numerador e denominador têm que falar
   * da mesma coisa.
   */
  const somaDosItens = comissionaveis.reduce((soma, item) => soma + item.totalCents, 0);
  const receitaCents = Math.max(0, somaDosItens - descontoCents);
  const rateioDaTaxa = ratearTaxa({
    itens: comissionaveis,
    taxaCents: taxaSobreOsItens({
      taxaCents,
      receitaCents,
      cobradoCents: receitaCents + (cabecas[0]?.tip_cents ?? 0),
    }),
  });

  let lancados = 0;

  for (const item of comissionaveis) {
    if (!item.professionalId) continue;

    const regra = escolherRegra(regras, {
      professionalId: item.professionalId,
      serviceId: item.serviceId,
      categoryId: item.categoryId,
    });
    if (!regra) continue;

    const base = baseDoItem({
      item,
      descontoRateadoCents: rateio.get(item.id) ?? 0,
      base: config.base,
      tratamentoDoDesconto: config.tratamentoDoDesconto,
      taxaRateadaCents: rateioDaTaxa.get(item.id) ?? 0,
      tratamentoDaTaxa: config.tratamentoDaTaxa,
    });

    const assinatura = doPlano.get(item.id) ?? null;

    await tx.$executeRaw`
      INSERT INTO commission_entries
        (tenant_id, professional_id, order_id, order_item_id, earned_on,
         rule_id, mode, value, tiers, base_cents, sign,
         club_subscription_id, subscription_fee_cents)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${item.professionalId}::uuid, ${params.orderId}::uuid, ${item.id}::uuid,
        ${params.quandoISO}::date,
        ${regra.id}::uuid, ${regra.modo}::commission_mode, ${regra.valor},
        ${JSON.stringify(regra.faixas)}::jsonb, ${base}, 1,
        ${assinatura?.id ?? null}::uuid, ${assinatura?.mensalidade ?? null}
      )
      ON CONFLICT DO NOTHING
    `;
    lancados += 1;
  }

  return lancados;
}

/**
 * Estorna a comissão de uma comanda.
 *
 * **Lançamento novo com sinal negativo, na data de hoje** — nunca `DELETE`, e
 * nunca com a data da venda. A SPEC §3.4 é explícita: estorno gera comissão
 * negativa no período corrente e não reescreve o fechado. Datá-lo no passado
 * mexeria num mês que já foi pago.
 *
 * A base copiada é a do lançamento original, não recalculada: se a regra mudou
 * no meio do caminho, o estorno precisa desfazer exatamente o que foi feito.
 */
export async function estornarComissaoDaComanda(
  tx: TransactionClient,
  params: {
    readonly orderId: string;
    readonly quandoISO: string;
  },
): Promise<number> {
  const originais = await tx.$queryRaw<
    {
      professional_id: string;
      order_item_id: string | null;
      rule_id: string | null;
      mode: ModoDeComissao;
      value: number;
      tiers: FaixaDeComissao[];
      base_cents: number;
      club_subscription_id: string | null;
      subscription_fee_cents: number | null;
    }[]
  >`
    SELECT professional_id, order_item_id, rule_id, mode, value, tiers, base_cents,
           club_subscription_id, subscription_fee_cents
      FROM commission_entries
     WHERE order_id = ${params.orderId}::uuid AND sign = 1
  `;

  let estornados = 0;
  for (const original of originais) {
    await tx.$executeRaw`
      INSERT INTO commission_entries
        (tenant_id, professional_id, order_id, order_item_id, earned_on,
         rule_id, mode, value, tiers, base_cents, sign,
         club_subscription_id, subscription_fee_cents)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${original.professional_id}::uuid, ${params.orderId}::uuid,
        ${original.order_item_id}::uuid, ${params.quandoISO}::date,
        ${original.rule_id}::uuid, ${original.mode}::commission_mode, ${original.value},
        ${JSON.stringify(original.tiers)}::jsonb, ${original.base_cents}, -1,
        -- A assinatura vai junto: sem ela o estorno de um corte do plano viraria
        -- comissão avulsa negativa, e o rateio da mensalidade não o descontaria
        -- de quem o recebeu.
        ${original.club_subscription_id}::uuid, ${original.subscription_fee_cents}
      )
      ON CONFLICT DO NOTHING
    `;
    estornados += 1;
  }

  return estornados;
}

/**
 * A linha do banco vira lançamento do domínio, com a assinatura junto.
 *
 * Uma função só, usada pelo extrato **e** pelo fechamento: se as duas montassem
 * o lançamento por conta própria, o modelo do clube valeria numa e não na outra
 * — e o barbeiro veria um número na tela e receberia outro no acerto.
 */
/** Exportados no bloco 52: o vale usa a mesma conta do extrato e do fechamento. */
export const paraLancamento = (l: LinhaBruta): LancamentoNoPeriodo => ({
  itemId: l.id,
  professionalId: l.professional_id,
  regraId: l.rule_id ?? 'sem-regra',
  modo: l.mode,
  valor: l.value,
  faixas: l.tiers,
  baseCents: l.base_cents,
  sinal: l.sign === -1 ? -1 : 1,
  ...(l.club_subscription_id && l.subscription_fee_cents
    ? { assinaturaId: l.club_subscription_id, mensalidadeCents: l.subscription_fee_cents }
    : {}),
});

export interface LinhaBruta {
  id: string;
  professional_id: string;
  professional_name: string;
  rule_id: string | null;
  mode: ModoDeComissao;
  value: number;
  tiers: FaixaDeComissao[];
  base_cents: number;
  sign: number;
  club_subscription_id: string | null;
  subscription_fee_cents: number | null;
}

export async function lancamentosAbertos(
  tx: TransactionClient,
  params: {
    readonly de: string;
    readonly ate: string;
    readonly somenteProfessionalId?: string | null;
    /**
     * A loja. Nula é a rede inteira — o que toda barbearia de uma loja quer, e
     * o que o dono quer ao fechar tudo de uma vez.
     *
     * A comissão é do profissional, e ele trabalha numa loja: sem este recorte,
     * a gerente escopada à filial lia o extrato dos três barbeiros da matriz e
     * tinha o botão de fechar o período ao lado.
     */
    readonly locationId?: string | null;
  },
): Promise<LinhaBruta[]> {
  const recorte = params.somenteProfessionalId ?? null;
  const loja = params.locationId ?? null;
  return tx.$queryRaw<LinhaBruta[]>`
    SELECT e.id, e.professional_id, p.name AS professional_name,
           e.rule_id, e.mode, e.value, e.tiers, e.base_cents, e.sign,
           e.club_subscription_id, e.subscription_fee_cents
      FROM commission_entries e
      JOIN professionals p ON p.id = e.professional_id
     WHERE e.closure_id IS NULL
       AND e.earned_on >= ${params.de}::date
       AND e.earned_on <= ${params.ate}::date
       AND (${recorte}::uuid IS NULL OR e.professional_id = ${recorte}::uuid)
       AND (${loja}::uuid IS NULL OR p.location_id = ${loja}::uuid)
     ORDER BY e.earned_on, e.id
  `;
}
