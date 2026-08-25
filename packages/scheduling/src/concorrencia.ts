import type { TransactionClient } from '@barbearia/db';

/**
 * Serializa decisões que consomem capacidade da mesma unidade no mesmo dia.
 *
 * A exclusion constraint protege sobreposição **do mesmo profissional**, mas
 * recursos compartilhados (cadeira/maca), limite diário e bloqueios da unidade
 * atravessam profissionais. Dois pedidos concorrentes podem ambos ler a mesma
 * capacidade livre e gravar decisões incompatíveis sem uma trava comum.
 *
 * Advisory xact lock vive só até commit/rollback e não exige linha sentinela.
 */
export async function travarDiaDaAgenda(
  tx: TransactionClient,
  locationId: string,
  diaLocal: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`barberdock:agenda:${locationId}:${diaLocal}`}, 0)
    )
  `;
}

/**
 * Mesmo lock usado pelo Catálogo ao trocar a jornada. Toda mutação que decide
 * um novo horário precisa segurá-lo enquanto lê a grade e grava capacidade;
 * assim uma redução de jornada não passa entre a validação e o INSERT.
 */
export async function travarConfiguracaoDoProfissional(
  tx: TransactionClient,
  professionalId: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock_shared(
      hashtextextended(${`barberdock:professional-config:${professionalId}`}, 0)
    )
  `;
}

/**
 * Mesmo namespace usado por `@barbearia/catalog` ao alterar pools/requisitos.
 *
 * Recursos são catálogo, mas também são capacidade da Agenda. Sem uma trava
 * compartilhada, um booking pode ler o requisito antigo enquanto o admin
 * grava o novo e ainda assim commitar depois, congelando uma decisão tomada
 * sobre uma configuração que já deixou de existir.
 */
export async function travarConfiguracaoDeRecursos(
  tx: TransactionClient,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock_shared(
      hashtextextended(
        ${'barberdock:catalog:resources:'} || current_setting('app.tenant_id', true),
        0
      )
    )
  `;
}


/**
 * Leitura compartilhada do catálogo que define preço/duração/buffers/estado e
 * combos. Escritores do Catálogo usam o lock exclusivo do mesmo namespace.
 */
export async function travarConfiguracaoDeServicos(
  tx: TransactionClient,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock_shared(
      hashtextextended(
        ${'barberdock:catalog:services:'} || current_setting('app.tenant_id', true),
        0
      )
    )
  `;
}
