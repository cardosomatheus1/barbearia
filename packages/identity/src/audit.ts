import type { TransactionClient } from '@barbearia/db';

/**
 * Trilha de auditoria.
 *
 * A SPEC (Parte 1 §1.7) lista o que precisa ser registrado sem exceção:
 * alteração de permissão, exportação de clientes, impersonação, acesso a foto
 * de cliente, cancelamento de pagamento, sangria. Este bloco entrega os
 * primeiros; os outros entram junto com as telas que os produzem.
 *
 * Grava **dentro da transação que faz a mudança**, sempre. Registrar depois, em
 * outra transação, cria a janela em que a alteração acontece e o registro não —
 * e é exatamente na falha que a trilha precisa existir.
 *
 * A tabela é append-only no banco: `UPDATE` e `DELETE` foram revogados do role
 * da aplicação na migração 0016. Não é convenção, é permissão.
 */

/** Vocabulário estável. String solta vira relatório que não agrupa nada. */
export type AuditAction =
  | 'staff.created'
  | 'staff.role_changed'
  | 'staff.deactivated'
  | 'staff.reactivated'
  | 'staff.password_reset'
  | 'permissions.changed';

export interface AuditEntry {
  readonly actorId: string | null;
  readonly actorName: string;
  readonly action: AuditAction;
  readonly entity: string;
  readonly entityId?: string | null;
  /** O par antes/depois: saber que mudou sem saber de quê para quê não fecha investigação. */
  readonly before?: unknown;
  readonly after?: unknown;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export async function audit(tx: TransactionClient, entrada: AuditEntry): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit_log
      (tenant_id, actor_id, actor_name, action, entity, entity_id,
       before, after, ip, user_agent)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${entrada.actorId}::uuid,
      ${entrada.actorName},
      ${entrada.action},
      ${entrada.entity},
      ${entrada.entityId ?? null}::uuid,
      ${entrada.before === undefined ? null : JSON.stringify(entrada.before)}::jsonb,
      ${entrada.after === undefined ? null : JSON.stringify(entrada.after)}::jsonb,
      ${entrada.ip ?? null}::inet,
      ${entrada.userAgent ?? null}
    )
  `;
}

export interface AuditRecord {
  readonly id: string;
  readonly actorName: string;
  readonly action: AuditAction;
  readonly entity: string;
  readonly entityId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly createdAt: string;
}

/**
 * Últimos eventos da barbearia.
 *
 * Paginação por cursor (`antesDe`), nunca por deslocamento: a trilha só cresce,
 * e `OFFSET` numa tabela que ganha linha a cada ação pula ou repete evento
 * conforme a página é carregada (CLAUDE.md §3).
 */
export async function listAudit(
  tx: TransactionClient,
  params: { readonly limite?: number; readonly antesDe?: string } = {},
): Promise<readonly AuditRecord[]> {
  const limite = Math.min(params.limite ?? 50, 200);

  const linhas = await tx.$queryRaw<
    {
      id: bigint;
      actor_name: string;
      action: AuditAction;
      entity: string;
      entity_id: string | null;
      before: unknown;
      after: unknown;
      created_at: Date;
    }[]
  >`
    SELECT id, actor_name, action, entity, entity_id, before, after, created_at
    FROM audit_log
    WHERE (${params.antesDe ?? null}::bigint IS NULL OR id < ${params.antesDe ?? null}::bigint)
    ORDER BY id DESC
    LIMIT ${limite}
  `;

  return linhas.map((linha) => ({
    // `bigint` do Postgres não sobrevive a `JSON.stringify`; o cursor volta como
    // texto e é assim que a próxima página o devolve.
    id: String(linha.id),
    actorName: linha.actor_name,
    action: linha.action,
    entity: linha.entity,
    entityId: linha.entity_id,
    before: linha.before,
    after: linha.after,
    createdAt: linha.created_at.toISOString(),
  }));
}
