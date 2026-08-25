import type { TransactionClient } from '@barbearia/db';

/**
 * Serializa invariantes de catálogo que atravessam mais de uma linha.
 *
 * Row locks resolvem disputa pela mesma linha; não resolvem decisões como
 * "existe ao menos uma unidade aberta" ou "este slug ainda está livre", em
 * que duas transações podem olhar linhas diferentes e chegar à mesma decisão.
 * O tenant já vem do contexto RLS e entra na chave para barbearias diferentes
 * nunca se bloquearem entre si.
 */
export async function travarCatalogoDoTenant(
  tx: TransactionClient,
  escopo: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        ${`barberdock:catalog:${escopo}:`} || current_setting('app.tenant_id', true),
        0
      )
    )
  `;
}

/**
 * Trava compartilhada com Scheduling para alterações que mudam a grade de um
 * profissional. A chave é deliberadamente independente do tenant: UUID de
 * profissional já é globalmente único, e os dois pacotes precisam disputar
 * exatamente o mesmo advisory lock sem criar dependência entre eles.
 */
export async function travarConfiguracaoDoProfissional(
  tx: TransactionClient,
  professionalId: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`barberdock:professional-config:${professionalId}`}, 0)
    )
  `;
}
