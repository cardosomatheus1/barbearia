import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  validarRegra,
  type BaseDeComissao,
  type FaixaDeComissao,
  type FormaDePagamento,
  type ModoDeComissao,
  type RegraDeComissao,
  type TratamentoDaTaxa,
  type TratamentoDoDesconto,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';

import { ComissaoError, CONFIGURACAO_PADRAO, type ConfiguracaoDeComissao } from './comissao-contratos.js';

export async function lerConfiguracao(tx: TransactionClient): Promise<ConfiguracaoDeComissao> {
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

export async function lerRegras(tx: TransactionClient): Promise<RegraDeComissao[]> {
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
