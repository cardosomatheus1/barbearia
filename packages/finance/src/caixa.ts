import { withTenant, type TransactionClient } from '@barbearia/db';
import { esperadoNaGaveta, fecharCaixa, type TipoDeMovimento } from '@barbearia/core';
// A trilha mora em `identity` e recebe a transação: registrar depois, em outra,
// cria a janela em que a sangria acontece e o registro não — e é justamente
// nessa janela que a trilha precisaria existir.
import { audit } from '@barbearia/identity';

/**
 * O caixa: a gaveta com dono.
 *
 * A SPEC §3.10 pede abertura por operador identificado, sangria, suprimento,
 * fechamento com divergência registrada e reabertura auditada. O que dá sentido
 * a tudo isso é uma coisa só: **a divergência precisa ter dono**. Caixa sem
 * operador é diferença que ninguém explica e que vira desconfiança de todo mundo.
 */

export type CaixaFailure =
  | 'ja_aberto'
  | 'nenhum_aberto'
  | 'sessao_nao_encontrada'
  | 'valor_invalido'
  | 'sangria_maior_que_a_gaveta';

export class CaixaError extends Error {
  constructor(
    readonly code: CaixaFailure,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'CaixaError';
  }
}

export interface Movimento {
  readonly id: string;
  readonly kind: TipoDeMovimento | 'debt_payment';
  readonly amountCents: number;
  readonly reason: string | null;
  readonly createdByName: string;
  readonly createdAt: string;
}

export interface SessaoDeCaixa {
  readonly id: string;
  readonly status: 'open' | 'closed';
  readonly openedByName: string;
  readonly openedAt: string;
  readonly openingCents: number;
  readonly closedByName: string | null;
  readonly closedAt: string | null;
  readonly countedCents: number | null;
  readonly expectedCents: number | null;
  readonly differenceCents: number | null;
  readonly movimentos: readonly Movimento[];
  /** O esperado **agora**, para o caixa aberto. Nulo depois de fechado. */
  readonly esperadoAgoraCents: number | null;
}

async function movimentosDa(tx: TransactionClient, sessionId: string): Promise<Movimento[]> {
  const linhas = await tx.$queryRaw<
    {
      id: string;
      kind: Movimento['kind'];
      amount_cents: number;
      reason: string | null;
      created_by_name: string;
      created_at: Date;
    }[]
  >`
    SELECT m.id, m.kind, m.amount_cents, m.reason, m.created_by_name, m.created_at
      FROM cash_movements m
     WHERE m.session_id = ${sessionId}::uuid
     ORDER BY m.created_at
  `;

  return linhas.map((linha) => ({
    id: linha.id,
    kind: linha.kind,
    amountCents: linha.amount_cents,
    reason: linha.reason,
    createdByName: linha.created_by_name,
    createdAt: linha.created_at.toISOString(),
  }));
}

/** O caixa aberto da unidade, com os movimentos. `null` quando não há. */
export async function caixaAberto(
  tenantId: string,
  locationId: string,
): Promise<SessaoDeCaixa | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        opened_by_name: string;
        opened_at: Date;
        opening_cents: number;
      }[]
    >`
      SELECT id, opened_by_name, opened_at, opening_cents
        FROM cash_sessions
       WHERE location_id = ${locationId}::uuid AND status = 'open'
    `;
    const sessao = linhas[0];
    if (!sessao) return null;

    const movimentos = await movimentosDa(tx, sessao.id);

    return {
      id: sessao.id,
      status: 'open',
      openedByName: sessao.opened_by_name,
      openedAt: sessao.opened_at.toISOString(),
      openingCents: sessao.opening_cents,
      closedByName: null,
      closedAt: null,
      countedCents: null,
      expectedCents: null,
      differenceCents: null,
      movimentos,
      esperadoAgoraCents: esperadoNaGaveta(
        movimentos.map((m) => ({ tipo: 'adjustment' as const, valorCents: m.amountCents })),
      ),
    };
  });
}

/**
 * Abre o caixa.
 *
 * O valor inicial é o troco que ficou na gaveta, contado pelo operador. Ele
 * entra como movimento `opening` em vez de ficar só numa coluna: assim o
 * esperado é sempre "a soma dos movimentos", uma regra só, e não "a soma mais
 * a abertura", que é onde a conta erra quando alguém esquece a segunda parte.
 */
export async function abrirCaixa(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly openingCents: number;
}): Promise<{ readonly id: string }> {
  if (!Number.isInteger(params.openingCents) || params.openingCents < 0) {
    throw new CaixaError('valor_invalido', 'O valor de abertura precisa ser zero ou mais.');
  }

  return withTenant(params.tenantId, async (tx) => {
    const jaAberto = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM cash_sessions
       WHERE location_id = ${params.locationId}::uuid AND status = 'open'
    `;
    if (jaAberto[0]) {
      throw new CaixaError('ja_aberto', 'Já existe um caixa aberto nesta unidade.');
    }

    const criada = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO cash_sessions
        (tenant_id, location_id, opened_by, opened_by_name, opening_cents)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.locationId}::uuid, ${params.staffId}::uuid, ${params.staffName},
        ${params.openingCents}
      )
      RETURNING id
    `;
    const id = criada[0]?.id;
    if (!id) throw new CaixaError('sessao_nao_encontrada', 'Não foi possível abrir o caixa.');

    await tx.$executeRaw`
      INSERT INTO cash_movements
        (tenant_id, session_id, kind, amount_cents, reason, created_by, created_by_name)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${id}::uuid, 'opening', ${params.openingCents}, 'Abertura',
        ${params.staffId}::uuid, ${params.staffName}
      )
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'cash.opened',
      entity: 'cash_session',
      entityId: id,
      after: { openingCents: params.openingCents },
    });

    return { id };
  });
}

/**
 * Sangria e suprimento.
 *
 * Sangria entra com sinal negativo — o sinal não é livre, há `CHECK` no banco.
 * E ela não pode tirar mais do que existe: gaveta negativa não é um estado do
 * mundo, é erro de digitação que só aparece no fechamento.
 */
export async function movimentarCaixa(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly kind: 'withdrawal' | 'supply';
  readonly amountCents: number;
  readonly reason: string;
}): Promise<void> {
  if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
    throw new CaixaError('valor_invalido', 'Informe um valor maior que zero.');
  }
  if (!params.reason.trim()) {
    throw new CaixaError('valor_invalido', 'Sangria e suprimento precisam de motivo.');
  }

  await withTenant(params.tenantId, async (tx) => {
    const sessao = await sessaoAbertaOuErro(tx, params.locationId);
    const movimentos = await movimentosDa(tx, sessao.id);
    const naGaveta = movimentos.reduce((soma, m) => soma + m.amountCents, 0);

    if (params.kind === 'withdrawal' && params.amountCents > naGaveta) {
      throw new CaixaError(
        'sangria_maior_que_a_gaveta',
        `Não há esse valor na gaveta. Disponível agora: ${naGaveta} centavos.`,
        { naGaveta },
      );
    }

    const valor = params.kind === 'withdrawal' ? -params.amountCents : params.amountCents;

    await tx.$executeRaw`
      INSERT INTO cash_movements
        (tenant_id, session_id, kind, amount_cents, reason, created_by, created_by_name)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${sessao.id}::uuid, ${params.kind}::cash_movement_type, ${valor},
        ${params.reason.trim()}, ${params.staffId}::uuid, ${params.staffName}
      )
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: params.kind === 'withdrawal' ? 'cash.withdrawal' : 'cash.supply',
      entity: 'cash_session',
      entityId: sessao.id,
      after: { amountCents: valor, reason: params.reason.trim(), naGavetaAntes: naGaveta },
    });
  });
}

async function sessaoAbertaOuErro(
  tx: TransactionClient,
  locationId: string,
): Promise<{ id: string }> {
  const linhas = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM cash_sessions
     WHERE location_id = ${locationId}::uuid AND status = 'open'
     FOR UPDATE
  `;
  const sessao = linhas[0];
  if (!sessao) {
    throw new CaixaError('nenhum_aberto', 'Não há caixa aberto. Abra o caixa antes.');
  }
  return sessao;
}

/**
 * Fecha o caixa com o que o operador contou.
 *
 * O **contado vem antes do esperado**: a SPEC pede fechamento cego opcional, e
 * cego só funciona se a tela não mostrar o esperado antes. A divergência é
 * gravada sempre, inclusive zero — guardar só a diferente tornaria impossível
 * distinguir "conferiu e bateu" de "ninguém conferiu".
 */
export async function fecharCaixaDaUnidade(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly countedCents: number;
  readonly notes?: string | null;
}): Promise<{
  readonly esperadoCents: number;
  readonly contadoCents: number;
  readonly divergenciaCents: number;
}> {
  if (!Number.isInteger(params.countedCents) || params.countedCents < 0) {
    throw new CaixaError('valor_invalido', 'O valor contado precisa ser zero ou mais.');
  }

  return withTenant(params.tenantId, async (tx) => {
    const sessao = await sessaoAbertaOuErro(tx, params.locationId);
    const movimentos = await movimentosDa(tx, sessao.id);

    const fechamento = fecharCaixa({
      movimentos: movimentos.map((m) => ({
        tipo: 'adjustment' as const,
        valorCents: m.amountCents,
      })),
      contadoCents: params.countedCents,
    });

    await tx.$executeRaw`
      UPDATE cash_sessions SET
        status = 'closed',
        closed_by = ${params.staffId}::uuid,
        closed_by_name = ${params.staffName},
        closed_at = now(),
        counted_cents = ${fechamento.contadoCents},
        expected_cents = ${fechamento.esperadoCents},
        difference_cents = ${fechamento.divergenciaCents},
        notes = ${params.notes ?? null}
      WHERE id = ${sessao.id}::uuid
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'cash.closed',
      entity: 'cash_session',
      entityId: sessao.id,
      after: {
        esperadoCents: fechamento.esperadoCents,
        contadoCents: fechamento.contadoCents,
        divergenciaCents: fechamento.divergenciaCents,
      },
    });

    return {
      esperadoCents: fechamento.esperadoCents,
      contadoCents: fechamento.contadoCents,
      divergenciaCents: fechamento.divergenciaCents,
    };
  });
}

/** Histórico de fechamentos, para conferir o dia anterior. */
export async function historicoDeCaixa(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly limite?: number;
}): Promise<readonly SessaoDeCaixa[]> {
  const limite = Math.min(Math.max(1, params.limite ?? 10), 50);

  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        status: 'open' | 'closed';
        opened_by_name: string;
        opened_at: Date;
        opening_cents: number;
        closed_by_name: string | null;
        closed_at: Date | null;
        counted_cents: number | null;
        expected_cents: number | null;
        difference_cents: number | null;
      }[]
    >`
      SELECT id, status, opened_by_name, opened_at, opening_cents,
             closed_by_name, closed_at, counted_cents, expected_cents, difference_cents
        FROM cash_sessions
       WHERE location_id = ${params.locationId}::uuid AND status = 'closed'
       ORDER BY opened_at DESC
       LIMIT ${limite}
    `;

    return linhas.map((linha) => ({
      id: linha.id,
      status: linha.status,
      openedByName: linha.opened_by_name,
      openedAt: linha.opened_at.toISOString(),
      openingCents: linha.opening_cents,
      closedByName: linha.closed_by_name,
      closedAt: linha.closed_at?.toISOString() ?? null,
      countedCents: linha.counted_cents,
      expectedCents: linha.expected_cents,
      differenceCents: linha.difference_cents,
      movimentos: [],
      esperadoAgoraCents: null,
    }));
  });
}
