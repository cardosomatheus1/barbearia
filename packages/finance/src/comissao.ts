import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  aplicarModeloDaAssinatura,
  aplicarFaixas,
  baseDoItem,
  comissaoDoPeriodo,
  escolherRegra,
  ratearDesconto,
  ratearTaxa,
  taxaSobreOsItens,
  validarRegra,
  type BaseDeComissao,
  type FaixaDeComissao,
  type LancamentoDeComissao,
  type ModoDeComissao,
  type RegraDeComissao,
  type FormaDePagamento,
  type TratamentoDaTaxa,
  type TratamentoDoDesconto,
  rentabilidadeDoAssinante,
  simularModelosDaAssinatura,
  type LancamentoNoPeriodo,
  type ModoDaAssinatura,
  type RentabilidadeDoAssinante,
  type SimulacaoDaAssinatura,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';

/**
 * Comissão, do banco para a tela.
 *
 * Toda decisão de conta está em `packages/core` — rateio, especificidade da
 * regra, faixa progressiva. Aqui se carrega o estado, se chama o domínio e se
 * grava o resultado.
 *
 * A decisão que molda o arquivo inteiro: **o lançamento guarda a base e a
 * regra, nunca o valor**. Faixa progressiva depende do acumulado do período, e
 * um estorno no dia 28 pode derrubar a faixa de tudo o que veio antes. Valor
 * gravado teria que ser reescrito a cada venda — e reescrever comissão paga é
 * exatamente o que a SPEC §3.4 proíbe.
 */

export type ComissaoFailure =
  | 'regra_invalida'
  | 'regra_nao_encontrada'
  | 'periodo_invalido'
  | 'periodo_ja_fechado'
  | 'aliquota_invalida'
  | 'nada_a_fechar';

export class ComissaoError extends Error {
  constructor(
    readonly code: ComissaoFailure,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ComissaoError';
  }
}

export interface ConfiguracaoDeComissao {
  readonly base: BaseDeComissao;
  readonly tratamentoDoDesconto: TratamentoDoDesconto;
  readonly tratamentoDaTaxa: TratamentoDaTaxa;
}

const CONFIGURACAO_PADRAO: ConfiguracaoDeComissao = {
  base: 'liquido',
  tratamentoDoDesconto: 'reduz_base',
  tratamentoDaTaxa: 'absorvida',
};

/**
 * O modelo de comissão sobre assinatura (bloco 48, SPEC §3.4).
 *
 * Mora em `tenants` e não em `commission_settings` de propósito: a tela que o
 * dono usa para decidir é a do **clube**, com a simulação dos três modelos ao
 * lado, e não a de regras de comissão. Quem lê é a mesma função que fecha o
 * período — não há segunda fonte.
 */
export interface ModeloDaAssinatura {
  readonly modo: ModoDaAssinatura;
  readonly tetoBps: number;
}

/** Padrão: o **comportamento anterior**, como todo padrão que mexe em dinheiro. */
export const MODELO_PADRAO_DA_ASSINATURA: ModeloDaAssinatura = {
  modo: 'por_uso',
  tetoBps: 6000,
};

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

async function lerConfiguracao(tx: TransactionClient): Promise<ConfiguracaoDeComissao> {
  const linhas = await tx.$queryRaw<
    {
      base: BaseDeComissao;
      discount_treatment: TratamentoDoDesconto;
      fee_treatment: TratamentoDaTaxa;
    }[]
  >`SELECT base, discount_treatment, fee_treatment FROM commission_settings`;
  const linha = linhas[0];
  if (!linha) return CONFIGURACAO_PADRAO;
  return {
    base: linha.base,
    tratamentoDoDesconto: linha.discount_treatment,
    tratamentoDaTaxa: linha.fee_treatment,
  };
}

async function lerRegras(tx: TransactionClient): Promise<RegraDeComissao[]> {
  const linhas = await tx.$queryRaw<
    {
      id: string;
      professional_id: string | null;
      service_id: string | null;
      category_id: string | null;
      mode: ModoDeComissao;
      value: number;
      tiers: FaixaDeComissao[];
    }[]
  >`
    SELECT id, professional_id, service_id, category_id, mode, value, tiers
      FROM commission_rules
  `;

  return linhas.map((linha) => ({
    id: linha.id,
    professionalId: linha.professional_id,
    serviceId: linha.service_id,
    categoryId: linha.category_id,
    modo: linha.mode,
    valor: linha.value,
    faixas: linha.tiers,
  }));
}

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

export interface LinhaDeComissao {
  readonly professionalId: string;
  readonly professionalName: string;
  readonly baseCents: number;
  readonly comissaoCents: number;
  readonly lancamentos: number;
}

export interface ExtratoDeComissao {
  readonly de: string;
  readonly ate: string;
  readonly linhas: readonly LinhaDeComissao[];
  readonly totalBaseCents: number;
  readonly totalComissaoCents: number;
  /**
   * Itens vendidos por um profissional que **nenhuma regra alcançou**.
   *
   * Sem isto, falta de configuração e comissão zero seriam a mesma tela — e o
   * barbeiro descobriria no dia do acerto, olhando um número menor do que
   * esperava, sem nada explicando o porquê.
   */
  readonly semRegra: readonly { readonly professionalName: string; readonly itens: number }[];
}

/**
 * O extrato do período aberto.
 *
 * Só lançamentos **sem carimbo de fechamento**: o que já foi fechado tem valor
 * congelado em `commission_closure_lines` e não entra em conta nova, nem que a
 * regra mude.
 */
export async function extratoDeComissao(params: {
  readonly tenantId: string;
  readonly de: string;
  readonly ate: string;
  /** Recorte do barbeiro que só pode ver a própria comissão. */
  readonly somenteProfessionalId?: string | null;
}): Promise<ExtratoDeComissao> {
  return withTenant(params.tenantId, async (tx) => {
    const lancamentos = await lancamentosAbertos(tx, params);

    const nomes = new Map(lancamentos.map((l) => [l.professional_id, l.professional_name]));
    const contagem = new Map<string, number>();
    for (const l of lancamentos) {
      contagem.set(l.professional_id, (contagem.get(l.professional_id) ?? 0) + 1);
    }

    /**
     * O modelo do clube é aplicado **antes** de somar o período (bloco 48).
     *
     * Rateio e híbrido dependem do acumulado — quantos atendimentos aquela
     * assinatura teve no mês —, exatamente como a faixa progressiva. Aplicar na
     * hora da venda seria impossível; aplicar depois de somar seria tarde.
     */
    const modelo = await lerModeloDaAssinatura(tx);
    const contas = comissaoDoPeriodo(
      aplicarModeloDaAssinatura(lancamentos.map(paraLancamento), modelo),
    );

    const linhas = contas.map((conta) => ({
      professionalId: conta.professionalId,
      professionalName: nomes.get(conta.professionalId) ?? 'Profissional',
      baseCents: conta.baseCents,
      comissaoCents: conta.comissaoCents,
      lancamentos: contagem.get(conta.professionalId) ?? 0,
    }));

    return {
      de: params.de,
      ate: params.ate,
      linhas,
      totalBaseCents: linhas.reduce((s, l) => s + l.baseCents, 0),
      totalComissaoCents: linhas.reduce((s, l) => s + l.comissaoCents, 0),
      semRegra: await itensSemRegra(tx, params),
    };
  });
}

/**
 * A linha do banco vira lançamento do domínio, com a assinatura junto.
 *
 * Uma função só, usada pelo extrato **e** pelo fechamento: se as duas montassem
 * o lançamento por conta própria, o modelo do clube valeria numa e não na outra
 * — e o barbeiro veria um número na tela e receberia outro no acerto.
 */
const paraLancamento = (l: LinhaBruta): LancamentoNoPeriodo => ({
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

interface LinhaBruta {
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

async function lancamentosAbertos(
  tx: TransactionClient,
  params: { readonly de: string; readonly ate: string; readonly somenteProfessionalId?: string | null },
): Promise<LinhaBruta[]> {
  const recorte = params.somenteProfessionalId ?? null;
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
     ORDER BY e.earned_on, e.id
  `;
}

/**
 * Quem vendeu e não tem regra que o alcance.
 *
 * Uma consulta só, com `NOT EXISTS`: percorrer os itens em laço perguntando ao
 * banco por cada um seria N+1 numa tela que a barbearia abre todo mês.
 */
async function itensSemRegra(
  tx: TransactionClient,
  params: { readonly de: string; readonly ate: string; readonly somenteProfessionalId?: string | null },
): Promise<{ professionalName: string; itens: number }[]> {
  const recorte = params.somenteProfessionalId ?? null;
  const linhas = await tx.$queryRaw<{ professional_name: string; itens: bigint }[]>`
    SELECT p.name AS professional_name, count(*)::bigint AS itens
      FROM order_items i
      JOIN orders o ON o.id = i.order_id
      JOIN professionals p ON p.id = i.professional_id
     WHERE o.status = 'paid'
       -- business_day, e não closed_at: é a mesma base de earned_on, e é o que
       -- impede as duas metades deste extrato falarem de meses diferentes.
       -- (Sem crase: dentro de template literal ela fecha a string.)
       AND o.business_day >= ${params.de}::date
       AND o.business_day <= ${params.ate}::date
       AND i.professional_id IS NOT NULL
       AND (${recorte}::uuid IS NULL OR i.professional_id = ${recorte}::uuid)
       AND NOT EXISTS (
         SELECT 1 FROM commission_entries e WHERE e.order_item_id = i.id
       )
     GROUP BY p.name
     ORDER BY p.name
  `;
  return linhas.map((l) => ({ professionalName: l.professional_name, itens: Number(l.itens) }));
}

/**
 * Fecha o período: calcula, congela e carimba.
 *
 * As três coisas numa transação. Congelar sem carimbar deixaria os lançamentos
 * entrando na conta do mês seguinte também — o barbeiro receberia duas vezes
 * pelo mesmo corte. Carimbar sem congelar deixaria o valor pago sem registro.
 */
export async function fecharPeriodoDeComissao(params: {
  readonly tenantId: string;
  readonly de: string;
  readonly ate: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly notas?: string | null;
}): Promise<{ readonly id: string; readonly linhas: readonly LinhaDeComissao[] }> {
  if (params.ate < params.de) {
    throw new ComissaoError('periodo_invalido', 'O fim do período vem antes do início.');
  }

  return withTenant(params.tenantId, async (tx) => {
    const jaFechado = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM commission_closures
       WHERE starts_on = ${params.de}::date AND ends_on = ${params.ate}::date
    `;
    if (jaFechado[0]) {
      throw new ComissaoError('periodo_ja_fechado', 'Este período já foi fechado.');
    }

    const lancamentos = await lancamentosAbertos(tx, params);
    if (lancamentos.length === 0) {
      throw new ComissaoError('nada_a_fechar', 'Não há comissão em aberto neste período.');
    }

    const nomes = new Map(lancamentos.map((l) => [l.professional_id, l.professional_name]));
    // O mesmo modelo do extrato, pela mesma função: o número que o barbeiro
    // viu na tela é o que ele recebe no acerto.
    const modelo = await lerModeloDaAssinatura(tx);
    const contas = comissaoDoPeriodo(
      aplicarModeloDaAssinatura(lancamentos.map(paraLancamento), modelo),
    );

    const criado = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO commission_closures
        (tenant_id, starts_on, ends_on, closed_by, closed_by_name, notes)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.de}::date, ${params.ate}::date,
        ${params.staffId}::uuid, ${params.staffName}, ${params.notas ?? null}
      )
      RETURNING id
    `;
    const id = criado[0]?.id;
    if (!id) throw new ComissaoError('nada_a_fechar', 'Não foi possível fechar o período.');

    for (const conta of contas) {
      await tx.$executeRaw`
        INSERT INTO commission_closure_lines
          (tenant_id, closure_id, professional_id, professional_name, base_cents, amount_cents)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${id}::uuid, ${conta.professionalId}::uuid,
          ${nomes.get(conta.professionalId) ?? 'Profissional'},
          ${conta.baseCents}, ${conta.comissaoCents}
        )
      `;
    }

    // Carimba **os mesmos** lançamentos que entraram na conta, por id. Repetir
    // o filtro por data traria o que tivesse entrado no meio da transação.
    const ids = lancamentos.map((l) => l.id);
    await tx.$executeRaw`
      UPDATE commission_entries SET closure_id = ${id}::uuid
       WHERE id = ANY(${ids}::uuid[])
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'commission.closed',
      entity: 'commission_closure',
      entityId: id,
      after: {
        de: params.de,
        ate: params.ate,
        lancamentos: lancamentos.length,
        totalCents: contas.reduce((s, c) => s + c.comissaoCents, 0),
      },
    });

    return {
      id,
      linhas: contas.map((conta) => ({
        professionalId: conta.professionalId,
        professionalName: nomes.get(conta.professionalId) ?? 'Profissional',
        baseCents: conta.baseCents,
        comissaoCents: conta.comissaoCents,
        lancamentos: 0,
      })),
    };
  });
}

export interface FechamentoDeComissao {
  readonly id: string;
  readonly de: string;
  readonly ate: string;
  readonly fechadoEm: string;
  readonly fechadoPor: string;
  readonly linhas: readonly {
    readonly professionalName: string;
    readonly baseCents: number;
    readonly comissaoCents: number;
  }[];
  readonly totalCents: number;
}

/** O histórico de fechamentos, que é o que responde "quanto o Ruan recebeu". */
export async function fechamentosDeComissao(params: {
  readonly tenantId: string;
  readonly somenteProfessionalId?: string | null;
  readonly limite?: number;
}): Promise<readonly FechamentoDeComissao[]> {
  const limite = Math.min(Math.max(1, params.limite ?? 12), 60);
  const recorte = params.somenteProfessionalId ?? null;

  return withTenant(params.tenantId, async (tx) => {
    // Duas consultas e um agrupamento em memória, nunca uma por fechamento:
    // doze meses de histórico dariam treze idas ao banco.
    const cabecas = await tx.$queryRaw<
      { id: string; starts_on: Date; ends_on: Date; closed_at: Date; closed_by_name: string }[]
    >`
      SELECT id, starts_on, ends_on, closed_at, closed_by_name
        FROM commission_closures
       ORDER BY starts_on DESC
       LIMIT ${limite}
    `;
    if (cabecas.length === 0) return [];

    const ids = cabecas.map((c) => c.id);
    const linhas = await tx.$queryRaw<
      {
        closure_id: string;
        professional_id: string | null;
        professional_name: string;
        base_cents: number;
        amount_cents: number;
      }[]
    >`
      SELECT closure_id, professional_id, professional_name, base_cents, amount_cents
        FROM commission_closure_lines
       WHERE closure_id = ANY(${ids}::uuid[])
         AND (${recorte}::uuid IS NULL OR professional_id = ${recorte}::uuid)
       ORDER BY professional_name
    `;

    const porFechamento = new Map<string, typeof linhas>();
    for (const linha of linhas) {
      const lista = porFechamento.get(linha.closure_id) ?? [];
      lista.push(linha);
      porFechamento.set(linha.closure_id, lista);
    }

    const dia = (d: Date): string => d.toISOString().slice(0, 10);

    return cabecas.map((cabeca) => {
      const suas = porFechamento.get(cabeca.id) ?? [];
      return {
        id: cabeca.id,
        de: dia(cabeca.starts_on),
        ate: dia(cabeca.ends_on),
        fechadoEm: cabeca.closed_at.toISOString(),
        fechadoPor: cabeca.closed_by_name,
        linhas: suas.map((l) => ({
          professionalName: l.professional_name,
          baseCents: l.base_cents,
          comissaoCents: l.amount_cents,
        })),
        totalCents: suas.reduce((s, l) => s + l.amount_cents, 0),
      };
    });
  });
}

// -- Regras -------------------------------------------------------------------

export interface RegraNaTela extends RegraDeComissao {
  readonly professionalName: string | null;
  readonly serviceName: string | null;
  readonly categoryName: string | null;
}

export async function regrasDeComissao(tenantId: string): Promise<{
  readonly regras: readonly RegraNaTela[];
  readonly configuracao: ConfiguracaoDeComissao;
}> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        professional_id: string | null;
        service_id: string | null;
        category_id: string | null;
        mode: ModoDeComissao;
        value: number;
        tiers: FaixaDeComissao[];
        professional_name: string | null;
        service_name: string | null;
        category_name: string | null;
      }[]
    >`
      SELECT r.id, r.professional_id, r.service_id, r.category_id, r.mode, r.value, r.tiers,
             p.name AS professional_name, s.name AS service_name, c.name AS category_name
        FROM commission_rules r
        LEFT JOIN professionals p ON p.id = r.professional_id
        LEFT JOIN services s ON s.id = r.service_id
        LEFT JOIN service_categories c ON c.id = r.category_id
       ORDER BY p.name NULLS FIRST, s.name NULLS FIRST, c.name NULLS FIRST
    `;

    return {
      configuracao: await lerConfiguracao(tx),
      regras: linhas.map((linha) => ({
        id: linha.id,
        professionalId: linha.professional_id,
        serviceId: linha.service_id,
        categoryId: linha.category_id,
        modo: linha.mode,
        valor: linha.value,
        faixas: linha.tiers,
        professionalName: linha.professional_name,
        serviceName: linha.service_name,
        categoryName: linha.category_name,
      })),
    };
  });
}

export async function salvarRegraDeComissao(params: {
  readonly tenantId: string;
  readonly professionalId?: string | null;
  readonly serviceId?: string | null;
  readonly categoryId?: string | null;
  readonly modo: ModoDeComissao;
  readonly valor: number;
  readonly faixas?: readonly FaixaDeComissao[];
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly id: string }> {
  const falha = validarRegra({
    modo: params.modo,
    valor: params.valor,
    faixas: params.faixas ?? [],
  });
  if (falha) throw new ComissaoError('regra_invalida', 'Regra de comissão inválida.', falha);

  return withTenant(params.tenantId, async (tx) => {
    // Ids da requisição conferidos sob RLS: a chave estrangeira do Postgres
    // ignora row security e aceitaria o profissional do vizinho.
    await exigirDoTenant(tx, 'professionals', params.professionalId ?? null);
    await exigirDoTenant(tx, 'services', params.serviceId ?? null);
    await exigirDoTenant(tx, 'service_categories', params.categoryId ?? null);

    const gravada = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO commission_rules
        (tenant_id, professional_id, service_id, category_id, mode, value, tiers)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.professionalId ?? null}::uuid, ${params.serviceId ?? null}::uuid,
        ${params.categoryId ?? null}::uuid,
        ${params.modo}::commission_mode, ${params.valor},
        ${JSON.stringify(params.faixas ?? [])}::jsonb
      )
      ON CONFLICT (tenant_id, professional_id, service_id, category_id) DO UPDATE
        SET mode = EXCLUDED.mode, value = EXCLUDED.value,
            tiers = EXCLUDED.tiers, updated_at = now()
      RETURNING id
    `;
    const id = gravada[0]?.id;
    if (!id) throw new ComissaoError('regra_invalida', 'Não foi possível salvar a regra.');

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'commission.rule_changed',
      entity: 'commission_rule',
      entityId: id,
      after: { modo: params.modo, valor: params.valor, faixas: params.faixas ?? [] },
    });

    return { id };
  });
}

export async function removerRegraDeComissao(params: {
  readonly tenantId: string;
  readonly id: string;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    const apagadas = await tx.$executeRaw`
      DELETE FROM commission_rules WHERE id = ${params.id}::uuid
    `;
    if (apagadas === 0) {
      throw new ComissaoError('regra_nao_encontrada', 'Esta regra não existe mais.');
    }

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'commission.rule_changed',
      entity: 'commission_rule',
      entityId: params.id,
      before: { removida: false },
      after: { removida: true },
    });
  });
}

export async function salvarConfiguracaoDeComissao(params: {
  readonly tenantId: string;
  readonly base: BaseDeComissao;
  readonly tratamentoDoDesconto: TratamentoDoDesconto;
  readonly tratamentoDaTaxa: TratamentoDaTaxa;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    const antes = await lerConfiguracao(tx);

    await tx.$executeRaw`
      INSERT INTO commission_settings (tenant_id, base, discount_treatment, fee_treatment)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.base}::commission_base,
        ${params.tratamentoDoDesconto}::commission_discount_treatment,
        ${params.tratamentoDaTaxa}::commission_fee_treatment
      )
      ON CONFLICT (tenant_id) DO UPDATE
        SET base = EXCLUDED.base,
            discount_treatment = EXCLUDED.discount_treatment,
            fee_treatment = EXCLUDED.fee_treatment,
            updated_at = now()
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'commission.rule_changed',
      entity: 'commission_settings',
      before: antes,
      /**
       * Montado a partir do mesmo formato do `before`, e não campo a campo.
       *
       * A simetria já foi quebrada uma vez por adição de campo: `tratamentoDaTaxa`
       * entrou no `before` e não no `after`, e a trilha da única mudança que
       * derruba a comissão de **todo mundo** de uma vez saía sem dizer o que
       * mudou — pior que ausente, parecia removido.
       */
      after: {
        base: params.base,
        tratamentoDoDesconto: params.tratamentoDoDesconto,
        tratamentoDaTaxa: params.tratamentoDaTaxa,
      },
    });
  });
}

/**
 * Confere que o id veio desta barbearia antes de virar chave estrangeira.
 *
 * A verificação de chave estrangeira do Postgres **ignora row security** — é o
 * defeito que a `/security-review` encontrou no bloco 13 e que reaparece em todo
 * lugar onde um id do corpo da requisição vira `REFERENCES`.
 */
async function exigirDoTenant(
  tx: TransactionClient,
  tabela: 'professionals' | 'services' | 'service_categories',
  id: string | null,
): Promise<void> {
  if (!id) return;

  const encontrado =
    tabela === 'professionals'
      ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM professionals WHERE id = ${id}::uuid`
      : tabela === 'services'
        ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM services WHERE id = ${id}::uuid`
        : await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM service_categories WHERE id = ${id}::uuid`;

  if (!encontrado[0]) {
    throw new ComissaoError('regra_invalida', 'Profissional, serviço ou categoria não encontrado.');
  }
}

export { aplicarFaixas };

/**
 * A alíquota que a barbearia paga por meio de pagamento (bloco 36).
 *
 * Linha ausente é zero, e é de propósito: ela cadastra só o que paga. Obrigar a
 * declarar `dinheiro = 0` seria pedir o óbvio para poder declarar o que importa.
 */
export async function aliquotasDoAdquirente(
  tenantId: string,
): Promise<{ readonly forma: FormaDePagamento; readonly bps: number }[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ method: FormaDePagamento; bps: number }[]>`
      SELECT method::text AS method, bps FROM acquirer_fees ORDER BY method
    `;
    return linhas.map((l) => ({ forma: l.method, bps: l.bps }));
  });
}

export async function salvarAliquotaDoAdquirente(params: {
  readonly tenantId: string;
  readonly forma: FormaDePagamento;
  readonly bps: number;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<void> {
  /**
   * Teto de 30% na borda **e** no banco.
   *
   * Acima disso é erro de digitação — 3,19 virando 319 —, e o estrago seria a
   * comissão do mês inteiro de todo mundo. A recusa é nos dois lugares porque
   * uma delas é a que fica quando alguém escrever um caminho novo.
   */
  if (!Number.isInteger(params.bps) || params.bps < 0 || params.bps > 3000) {
    throw new ComissaoError('aliquota_invalida', 'A alíquota tem que estar entre 0% e 30%.');
  }
  /**
   * Fiado não é meio de pagamento — é dívida.
   *
   * Cobrar taxa de adquirente sobre um fiado seria cobrar a maquininha de um
   * dinheiro que não passou por ela, e o barbeiro pagaria por uma transação que
   * não existiu. A recusa é aqui **e** na borda: a daqui é a que fica quando
   * alguém escrever um caminho novo.
   */
  if (params.forma === 'fiado') {
    throw new ComissaoError(
      'aliquota_invalida',
      'Fiado não é meio de pagamento: a taxa nasce quando o cliente paga.',
    );
  }

  await withTenant(params.tenantId, async (tx) => {
    const anteriores = await tx.$queryRaw<{ bps: number }[]>`
      SELECT bps FROM acquirer_fees WHERE method = ${params.forma}::payment_method
    `;

    if (params.bps === 0) {
      // Zero é "não pago taxa neste meio", e a linha some: guardar zero
      // explícito e ausência como coisas diferentes criaria duas maneiras de
      // dizer a mesma coisa.
      await tx.$executeRaw`
        DELETE FROM acquirer_fees WHERE method = ${params.forma}::payment_method
      `;
    } else {
      await tx.$executeRaw`
        INSERT INTO acquirer_fees (tenant_id, method, bps)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${params.forma}::payment_method, ${params.bps}
        )
        ON CONFLICT (tenant_id, method) DO UPDATE
          SET bps = EXCLUDED.bps, updated_at = now()
      `;
    }

    /**
     * Mudar alíquota é mudar quanto o barbeiro recebe — quando o rateio está
     * ligado. A trilha usa a mesma ação da regra de comissão porque a pergunta
     * do dia seguinte é a mesma: "por que caiu minha comissão neste mês?".
     */
    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'commission.rule_changed',
      entity: 'acquirer_fee',
      // Sem `entityId`: a chave desta linha é (barbearia, meio), e `entity_id` é
      // uuid. O meio vai no detalhe, que é onde ele é legível de qualquer jeito.
      entityId: null,
      before: { forma: params.forma, bps: anteriores[0]?.bps ?? 0 },
      after: { forma: params.forma, bps: params.bps },
    });
  });
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

    return simularModelosDaAssinatura({
      lancamentos: linhas.map(paraLancamento),
      tetoBps: modelo.tetoBps,
      emUso: modelo.modo,
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
             coalesce(sum(abs(m.quantity) * m.unit_cost_cents), 0)::bigint AS custo
        FROM club_uses u
        JOIN stock_movements m ON m.order_id = u.order_id
       WHERE u.business_day >= ${params.de}::date AND u.business_day <= ${params.ate}::date
         AND m.kind = 'consumo'
       GROUP BY u.subscription_id
    `;
    const insumoPorAssinatura = new Map(
      insumos.map((i) => [i.subscription_id, Number(i.custo)]),
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
