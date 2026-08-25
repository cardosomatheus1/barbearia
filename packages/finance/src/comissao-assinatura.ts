import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  aplicarModeloDaAssinatura,
  comissaoDoPeriodo,
  rentabilidadeDoAssinante,
  simularModelosDaAssinatura,
  type ModoDaAssinatura,
  type RentabilidadeDoAssinante,
  type SimulacaoDaAssinatura,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';

import { inteiroSeguroDoBanco } from './inteiro-seguro.js';
import { ComissaoError, MODELO_PADRAO_DA_ASSINATURA, type ModeloDaAssinatura } from './comissao-contratos.js';
import { paraLancamento, type LinhaBruta } from './comissao-lancamentos.js';

export async function lerModeloDaAssinatura(
  tx: TransactionClient,
): Promise<ModeloDaAssinatura> {
  const linhas = await tx.$queryRaw<
    { modo: ModoDaAssinatura; teto: number }[]
  >`
    SELECT subscription_commission_mode AS modo, subscription_commission_cap_bps AS teto
      FROM tenants
  `;
  const linha = linhas[0];
  if (!linha) return MODELO_PADRAO_DA_ASSINATURA;
  return { modo: linha.modo, tetoBps: linha.teto };
}

// ---------------------------------------------------------------------------
// A simulação e a rentabilidade do clube (bloco 48, SPEC §3.4 e §4.6)
// ---------------------------------------------------------------------------

/**
 * A simulação dos três modelos sobre os dados reais da barbearia.
 *
 * *"O sistema precisa mostrar ao dono, antes de ele escolher, a simulação dos
 * três sobre os dados reais dele."* A frase importa: simulação sobre exemplo de
 * manual convence de qualquer coisa; sobre o mês que ele acabou de fechar, a
 * diferença entre R$ 96 e R$ 59 tem nome e cara.
 *
 * Lê os lançamentos **fechados e abertos** do período, porque a pergunta é
 * histórica: "o que teria acontecido se eu tivesse escolhido o outro modelo".
 * Recortar em aberto responderia sobre o mês em curso, que quase sempre está
 * pela metade.
 */
export async function simulacaoDaAssinatura(params: {
  readonly tenantId: string;
  readonly de: string;
  readonly ate: string;
}): Promise<SimulacaoDaAssinatura> {
  return withTenant(params.tenantId, async (tx) => {
    const modelo = await lerModeloDaAssinatura(tx);

    const linhas = await tx.$queryRaw<LinhaBruta[]>`
      SELECT e.id, e.professional_id, p.name AS professional_name,
             e.rule_id, e.mode, e.value, e.tiers, e.base_cents, e.sign,
             e.club_subscription_id, e.subscription_fee_cents
        FROM commission_entries e
        JOIN professionals p ON p.id = e.professional_id
       WHERE e.club_subscription_id IS NOT NULL
         AND e.earned_on >= ${params.de}::date
         AND e.earned_on <= ${params.ate}::date
       ORDER BY e.earned_on, e.id
    `;

    /**
     * O fato, ao lado do lançamento — e é a diferença entre os dois que a tela
     * precisa dizer.
     *
     * `commission_entries` só ganha linha quando o item tem profissional **e**
     * uma regra casa. A barbearia sem regra cadastrada via "ainda não há o que
     * comparar" ao lado da tabela de rentabilidade que listava dezesseis
     * assinantes atendidos no mesmo período: duas telas do mesmo painel
     * discordando sobre o mesmo fato.
     *
     * Duas agregações na mesma transação, sem laço com ida ao banco dentro.
     */
    const [usos] = await tx.$queryRaw<{ quantos: bigint }[]>`
      -- O business_day do proprio uso, e nao o da venda: o uso pode vir de um
      -- agendamento sem comanda, e juntar com orders descartaria justamente o
      -- atendimento que ainda nao foi cobrado.
      SELECT count(*) AS quantos
        FROM club_uses
       WHERE business_day >= ${params.de}::date
         AND business_day <= ${params.ate}::date
    `;

    const [regras] = await tx.$queryRaw<{ quantas: bigint }[]>`
      SELECT count(*) AS quantas FROM commission_rules
    `;

    return simularModelosDaAssinatura({
      lancamentos: linhas.map(paraLancamento),
      tetoBps: modelo.tetoBps,
      emUso: modelo.modo,
      usosNoPeriodo: Number(usos?.quantos ?? 0),
      temRegraDeComissao: Number(regras?.quantas ?? 0) > 0,
    });
  });
}

export interface RentabilidadeNaTela extends RentabilidadeDoAssinante {
  readonly cliente: string;
  readonly plano: string | null;
}

export interface RentabilidadeDoClube {
  readonly de: string;
  readonly ate: string;
  readonly modo: ModoDaAssinatura;
  readonly assinantes: readonly RentabilidadeNaTela[];
  readonly receitaCents: number;
  readonly comissaoCents: number;
  readonly insumoCents: number;
  readonly margemCents: number;
}

/**
 * O clube dá lucro? (SPEC §4.6)
 *
 * *"Sem essa tela, o dono descobre que o clube dá prejuízo seis meses depois."*
 * O bloco 45 entregou a metade que não depende de nada — quantos usos o plano
 * paga. Esta é a outra: o que **de fato** aconteceu, com a comissão do modelo
 * escolhido e o insumo congelado no movimento de estoque.
 *
 * Três consultas e nenhum laço com ida ao banco dentro: uso, comissão e insumo
 * chegam agregados e se encontram em memória pelo id da assinatura.
 */
export async function rentabilidadeDoClube(params: {
  readonly tenantId: string;
  readonly de: string;
  readonly ate: string;
}): Promise<RentabilidadeDoClube> {
  return withTenant(params.tenantId, async (tx) => {
    const modelo = await lerModeloDaAssinatura(tx);

    const usos = await tx.$queryRaw<
      {
        subscription_id: string;
        cliente: string;
        plano: string | null;
        mensalidade: number;
        usos: bigint;
        entregue: bigint;
      }[]
    >`
      SELECT u.subscription_id, c.name AS cliente, p.name AS plano,
             s.price_cents AS mensalidade,
             count(*)::bigint AS usos,
             coalesce(sum(u.value_cents), 0)::bigint AS entregue
        FROM club_uses u
        JOIN club_subscriptions s ON s.id = u.subscription_id
        JOIN customers c ON c.id = s.customer_id
        LEFT JOIN club_plans p ON p.id = s.plan_id
       WHERE u.business_day >= ${params.de}::date AND u.business_day <= ${params.ate}::date
       GROUP BY u.subscription_id, c.name, p.name, s.price_cents
    `;

    const lancamentos = await tx.$queryRaw<LinhaBruta[]>`
      SELECT e.id, e.professional_id, p.name AS professional_name,
             e.rule_id, e.mode, e.value, e.tiers, e.base_cents, e.sign,
             e.club_subscription_id, e.subscription_fee_cents
        FROM commission_entries e
        JOIN professionals p ON p.id = e.professional_id
       WHERE e.club_subscription_id IS NOT NULL
         AND e.earned_on >= ${params.de}::date
         AND e.earned_on <= ${params.ate}::date
       ORDER BY e.earned_on, e.id
    `;

    /**
     * O insumo, com o custo **congelado no movimento** (bloco 44).
     *
     * Lido do cadastro na hora do relatório, subir o preço do shampoo em março
     * mudaria a margem de janeiro.
     */
    const insumos = await tx.$queryRaw<{ subscription_id: string; custo: bigint }[]>`
      SELECT u.subscription_id,
             coalesce(sum(abs(m.quantity)::bigint * m.unit_cost_cents), 0)::bigint AS custo
        FROM club_uses u
        JOIN stock_movements m ON m.order_id = u.order_id
       WHERE u.business_day >= ${params.de}::date AND u.business_day <= ${params.ate}::date
         AND m.kind = 'consumo'
       GROUP BY u.subscription_id
    `;
    const insumoPorAssinatura = new Map(
      insumos.map((i) => [i.subscription_id, inteiroSeguroDoBanco(i.custo, 'insumo da assinatura')]),
    );

    // O modelo é aplicado uma vez sobre o período inteiro: rateio e teto são
    // por assinatura, e recortar por assinante mudaria a conta de quem tem
    // dois barbeiros no mesmo mês.
    const aplicados = aplicarModeloDaAssinatura(lancamentos.map(paraLancamento), modelo);
    const comissaoPorAssinatura = new Map<string, number>();
    for (const [i, l] of aplicados.entries()) {
      const origem = lancamentos[i];
      const assinaturaId = origem?.club_subscription_id;
      if (!assinaturaId) continue;
      const so = comissaoDoPeriodo([l]).reduce((s, c) => s + c.comissaoCents, 0);
      comissaoPorAssinatura.set(assinaturaId, (comissaoPorAssinatura.get(assinaturaId) ?? 0) + so);
    }

    const assinantes = usos.map((u): RentabilidadeNaTela => {
      const comissaoCents = comissaoPorAssinatura.get(u.subscription_id) ?? 0;
      const insumoCents = insumoPorAssinatura.get(u.subscription_id) ?? 0;
      return {
        ...rentabilidadeDoAssinante({
          assinaturaId: u.subscription_id,
          mensalidadeCents: u.mensalidade,
          // A contagem e o valor entregue já vieram agregados: montar a lista
          // de usos aqui seria trazer uma linha por corte para somar de novo.
          usos: [{ valorCents: Number(u.entregue) }],
          comissaoCents,
          insumoCents,
        }),
        usos: Number(u.usos),
        cliente: u.cliente,
        plano: u.plano,
      };
    });

    assinantes.sort((a, b) => a.margemCents - b.margemCents);

    return {
      de: params.de,
      ate: params.ate,
      modo: modelo.modo,
      assinantes,
      receitaCents: assinantes.reduce((s, a) => s + a.mensalidadeCents, 0),
      comissaoCents: assinantes.reduce((s, a) => s + a.comissaoCents, 0),
      insumoCents: assinantes.reduce((s, a) => s + a.insumoCents, 0),
      margemCents: assinantes.reduce((s, a) => s + a.margemCents, 0),
    };
  });
}

/**
 * O dono escolhe o modelo.
 *
 * Auditado porque muda **quanto a equipe inteira recebe** a partir do próximo
 * fechamento — e porque a pergunta do mês seguinte ("por que a minha comissão
 * caiu?") precisa de resposta com nome e data.
 */
export async function salvarModeloDaAssinatura(params: {
  readonly tenantId: string;
  readonly modo: ModoDaAssinatura;
  readonly tetoBps: number;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly salvo: true }> {
  if (!Number.isInteger(params.tetoBps) || params.tetoBps < 0 || params.tetoBps > 10_000) {
    throw new ComissaoError('aliquota_invalida', 'O teto vai de 0% a 100%.');
  }

  return withTenant(params.tenantId, async (tx) => {
    const antes = await lerModeloDaAssinatura(tx);

    await tx.$executeRaw`
      UPDATE tenants
         SET subscription_commission_mode = ${params.modo}::subscription_commission_mode,
             subscription_commission_cap_bps = ${params.tetoBps}
       WHERE id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'commission.rule_changed',
      entity: 'tenants',
      before: { modoDaAssinatura: antes.modo, tetoBps: antes.tetoBps },
      after: { modoDaAssinatura: params.modo, tetoBps: params.tetoBps },
    });

    return { salvo: true as const };
  });
}
