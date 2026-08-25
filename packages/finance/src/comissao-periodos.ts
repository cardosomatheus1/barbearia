import { withTenant, type TransactionClient } from '@barbearia/db';
import { aplicarModeloDaAssinatura, comissaoDoPeriodo } from '@barbearia/core';
import { audit } from '@barbearia/identity';

import { ComissaoError } from './comissao-contratos.js';
import { lerModeloDaAssinatura } from './comissao-assinatura.js';
import { lancamentosAbertos, paraLancamento } from './comissao-lancamentos.js';

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
  /** A loja do balcão. Nula é a rede inteira. */
  readonly locationId?: string | null;
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
/**
 * Consome os vales abertos do período no fechamento da comissão.
 *
 * Roda **dentro** da transação que cria o fechamento, e devolve quanto cada
 * profissional tinha a descontar. Fora dela existiria a janela em que a folha
 * foi fechada e os vales continuam abertos — e o mês seguinte os descontaria de
 * novo, cobrando duas vezes o mesmo adiantamento.
 *
 * O recorte é `granted_on <= ate` e não `BETWEEN`: um vale de um período que
 * ficou sem fechar precisa ser descontado no primeiro fechamento que o alcance,
 * senão ele fica órfão para sempre.
 *
 * ## Só quem entra numa linha do fechamento
 *
 * O filtro por profissional é o achado mais importante da `/security-review`
 * deste bloco. Sem ele, o fechamento consumia **todo** vale aberto — inclusive o
 * de quem não teve comissão nenhuma no período. O vale virava `descontado`,
 * ficava imutável pelo gatilho, e nenhuma linha de fechamento registrava o
 * desconto: a dívida era destruída em silêncio.
 *
 * O caso não precisa de má-fé para acontecer. Ruan pega vale em julho, tira
 * agosto de férias, e o fechamento de agosto — que não tem nenhum atendimento
 * dele — apagava o adiantamento de julho. Quando julho fechasse depois, ele
 * receberia a comissão cheia e ficaria com o dinheiro do vale.
 *
 * Deixado aberto, o vale é descontado pelo primeiro fechamento que **de fato**
 * paga aquela pessoa, e enquanto isso aparece como "a descontar" na tela.
 */
export async function descontarValesNoFechamento(
  tx: TransactionClient,
  params: {
    readonly ate: string;
    readonly closureId: string;
    /** Só quem entra numa linha do fechamento. Ver o parágrafo acima. */
    readonly professionalIds: readonly string[];
  },
): Promise<ReadonlyMap<string, number>> {
  if (params.professionalIds.length === 0) return new Map();

  const linhas = await tx.$queryRaw<{ id: string; professional_id: string; amount_cents: number }[]>`
    SELECT id, professional_id, amount_cents FROM professional_advances
     WHERE status = 'aberto'
       AND granted_on <= ${params.ate}::date
       AND professional_id = ANY(${params.professionalIds}::uuid[])
     FOR UPDATE
  `;

  const porProfissional = new Map<string, number>();
  for (const linha of linhas) {
    porProfissional.set(
      linha.professional_id,
      (porProfissional.get(linha.professional_id) ?? 0) + linha.amount_cents,
    );
  }

  if (linhas.length > 0) {
    const ids = linhas.map((l) => l.id);
    await tx.$executeRaw`
      UPDATE professional_advances
         SET status = 'descontado', closure_id = ${params.closureId}::uuid
       WHERE id = ANY(${ids}::uuid[])
    `;
  }

  return porProfissional;
}

export async function fecharPeriodoDeComissao(params: {
  readonly tenantId: string;
  readonly de: string;
  readonly ate: string;
  /**
   * A loja cujo período está sendo fechado. Nula fecha a rede inteira.
   *
   * Fechar é irreversível — o gatilho torna o lançamento imutável —, e antes
   * deste bloco a gerente de uma filial fechava o período dos barbeiros da
   * matriz sem nem conseguir vê-los na própria tela como sendo de outra loja.
   */
  readonly locationId?: string | null;
  readonly staffId: string;
  readonly staffName: string;
  readonly notas?: string | null;
}): Promise<{ readonly id: string; readonly linhas: readonly LinhaDeComissao[] }> {
  if (params.ate < params.de) {
    throw new ComissaoError('periodo_invalido', 'O fim do período vem antes do início.');
  }

  return withTenant(params.tenantId, async (tx) => {
    const loja = params.locationId ?? null;
    const jaFechado = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM commission_closures
       WHERE starts_on = ${params.de}::date AND ends_on = ${params.ate}::date
         AND location_id IS NOT DISTINCT FROM ${loja}::uuid
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
        (tenant_id, location_id, starts_on, ends_on, closed_by, closed_by_name, notes)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${loja}::uuid,
        ${params.de}::date, ${params.ate}::date,
        ${params.staffId}::uuid, ${params.staffName}, ${params.notas ?? null}
      )
      RETURNING id
    `;
    const id = criado[0]?.id;
    if (!id) throw new ComissaoError('nada_a_fechar', 'Não foi possível fechar o período.');

    /**
     * Os vales abertos do período viram desconto **nesta transação** (bloco 52).
     *
     * Fora dela existiria a janela em que a folha foi fechada e os vales
     * continuam abertos — e o mês seguinte os descontaria de novo, cobrando duas
     * vezes o mesmo adiantamento.
     */
    const valePorProfissional = await descontarValesNoFechamento(tx, {
      ate: params.ate,
      closureId: id,
      professionalIds: contas.map((c) => c.professionalId),
    });

    for (const conta of contas) {
      await tx.$executeRaw`
        INSERT INTO commission_closure_lines
          (tenant_id, closure_id, professional_id, professional_name, base_cents,
           amount_cents, advance_cents)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${id}::uuid, ${conta.professionalId}::uuid,
          ${nomes.get(conta.professionalId) ?? 'Profissional'},
          ${conta.baseCents}, ${conta.comissaoCents},
          ${valePorProfissional.get(conta.professionalId) ?? 0}
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
  /** A loja do balcão. Nula lista os fechamentos da rede. */
  readonly locationId?: string | null;
  readonly limite?: number;
}): Promise<readonly FechamentoDeComissao[]> {
  const limite = Math.min(Math.max(1, params.limite ?? 12), 60);
  const recorte = params.somenteProfessionalId ?? null;
  const loja = params.locationId ?? null;

  return withTenant(params.tenantId, async (tx) => {
    // Duas consultas e um agrupamento em memória, nunca uma por fechamento:
    // doze meses de histórico dariam treze idas ao banco.
    const cabecas = await tx.$queryRaw<
      { id: string; starts_on: Date; ends_on: Date; closed_at: Date; closed_by_name: string }[]
    >`
      SELECT id, starts_on, ends_on, closed_at, closed_by_name
        FROM commission_closures
       -- O fechamento da rede (loja nula) aparece em toda loja: o dinheiro e da
       -- barbearia, e some-lo de todas seria pior que aparecer em cada uma. E o
       -- mesmo criterio da mensalidade do clube anterior ao bloco 58.
       WHERE ${loja}::uuid IS NULL
          OR location_id IS NULL
          OR location_id = ${loja}::uuid
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

