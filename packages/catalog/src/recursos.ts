import { withTenant } from '@barbearia/db';
import { CatalogError } from './servicos.js';
import { travarCatalogoDoTenant } from './concorrencia.js';

/**
 * Recursos: cadeira, lavatório, sala.
 *
 * O motor já os respeita desde o bloco 1 — `resource_pools` diz quantos
 * existem, `service_resource_requirements` diz o que cada serviço consome, e a
 * grade recorta a janela quando acabam. **Nada nunca preencheu as duas tabelas.**
 *
 * O efeito prático da ausência: uma barbearia com dois barbeiros e um lavatório
 * só oferece dois horários simultâneos de lavagem, e o segundo cliente fica
 * esperando de cabelo molhado. O sistema sabia evitar isso e não tinha por onde
 * ser informado.
 *
 * O tipo é texto livre de propósito: "cadeira", "lavatório" e "sala de barba"
 * são vocabulário da barbearia, não enum do sistema. O que o motor precisa é que
 * o nome usado no serviço seja o mesmo do pool, e é isso que a tela garante ao
 * oferecer os existentes em vez de um campo aberto.
 */

export interface Recurso {
  readonly resourceType: string;
  readonly capacity: number;
  /** Serviços que consomem este recurso, para a tela mostrar o efeito. */
  readonly usedBy: readonly { readonly serviceId: string; readonly quantity: number }[];
}

export async function listResources(
  tenantId: string,
  locationId: string,
): Promise<readonly Recurso[]> {
  return withTenant(tenantId, async (tx) => {
    const pools = await tx.$queryRaw<{ resource_type: string; capacity: number }[]>`
      SELECT resource_type, capacity FROM resource_pools
      WHERE location_id = ${locationId}::uuid
      ORDER BY resource_type
    `;

    const usos = await tx.$queryRaw<
      { resource_type: string; service_id: string; quantity: number }[]
    >`
      SELECT resource_type, service_id, quantity FROM service_resource_requirements
    `;

    return pools.map((pool) => ({
      resourceType: pool.resource_type,
      capacity: pool.capacity,
      usedBy: usos
        .filter((uso) => uso.resource_type === pool.resource_type)
        .map((uso) => ({ serviceId: uso.service_id, quantity: uso.quantity })),
    }));
  });
}

/**
 * Grava a lista de recursos da unidade.
 *
 * Substitui o conjunto. Um pool removido leva junto as exigências que apontavam
 * para ele — deixá-las vivas faria o motor procurar capacidade de um recurso que
 * não existe mais e recusar todos os horários daquele serviço, sem explicação
 * na tela.
 */
export async function saveResources(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly pools: readonly { readonly resourceType: string; readonly capacity: number }[];
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    // Pool é por unidade, mas a exigência do serviço é da rede inteira. As duas
    // rotas que mexem nessa invariável disputam a mesma trava do tenant.
    await travarCatalogoDoTenant(tx, 'resources');
    const unidades = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM locations WHERE id = ${params.locationId}::uuid AND active
    `;
    if (!unidades[0]) throw new CatalogError('location_not_found', 'Esta unidade não existe.');

    const vistos = new Set<string>();
    for (const pool of params.pools) {
      const tipo = pool.resourceType.trim();
      if (!tipo || vistos.has(tipo)) {
        throw new CatalogError('invalid_catalog', 'Cada tipo de recurso deve aparecer uma única vez.');
      }
      vistos.add(tipo);
      if (pool.capacity < 1) {
        throw new CatalogError(
          'invalid_catalog',
          'A quantidade de cada recurso precisa ser pelo menos 1.',
        );
      }
    }

    const tipos = params.pools.map((p) => p.resourceType);

    await tx.$executeRaw`
      DELETE FROM resource_pools
      WHERE location_id = ${params.locationId}::uuid
        AND NOT (resource_type = ANY(${tipos}::text[]))
    `;

    for (const pool of params.pools) {
      await tx.$executeRaw`
        INSERT INTO resource_pools (tenant_id, location_id, resource_type, capacity)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${params.locationId}::uuid, ${pool.resourceType}, ${pool.capacity}
        )
        ON CONFLICT (location_id, resource_type)
        DO UPDATE SET capacity = EXCLUDED.capacity
      `;
    }

    /**
     * A exigência some quando o tipo não existe em **loja nenhuma** — e esta é
     * a última instrução da transação, de propósito.
     *
     * `resource_pools` é por unidade; `service_resource_requirements` é da
     * barbearia. A versão anterior apagava a exigência de todo tipo ausente
     * *desta* lista, e rodava antes das gravações: salvar a tela de Recursos de
     * uma loja nova, com a lista vazia, apagava a exigência de lavatório da
     * matriz junto. A grade de lá parava de reservar o recurso e passava a
     * vender dois banhos no mesmo horário, sem trilha e sem nada ficar
     * vermelho.
     *
     * A pergunta certa é sobre a rede, e a RLS já a recorta para esta
     * barbearia. Rodando por último, a subconsulta enxerga os pools que este
     * mesmo `UPSERT` acabou de gravar.
     */
    await tx.$executeRaw`
      DELETE FROM service_resource_requirements r
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_pools p WHERE p.resource_type = r.resource_type
      )
    `;
  });
}

/**
 * O que um serviço consome.
 *
 * Substitui as exigências daquele serviço. Recurso fora da lista de pools é
 * recusado: aceitar criaria exigência de algo que o motor nunca vai encontrar, e
 * o serviço sumiria da grade sem ninguém entender por quê.
 */
export async function setServiceResources(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly serviceId: string;
  readonly requirements: readonly { readonly resourceType: string; readonly quantity: number }[];
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    await travarCatalogoDoTenant(tx, 'resources');
    const unidades = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM locations WHERE id = ${params.locationId}::uuid AND active
    `;
    if (!unidades[0]) throw new CatalogError('location_not_found', 'Esta unidade não existe.');

    const existe = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM services WHERE id = ${params.serviceId}::uuid
    `;
    if (!existe[0]) throw new CatalogError('service_not_found', 'Serviço não encontrado.');

    const pools = await tx.$queryRaw<{ resource_type: string }[]>`
      SELECT resource_type FROM resource_pools WHERE location_id = ${params.locationId}::uuid
    `;
    const conhecidos = new Set(pools.map((p) => p.resource_type));

    const exigenciasVistas = new Set<string>();
    for (const exigencia of params.requirements) {
      if (exigenciasVistas.has(exigencia.resourceType)) {
        throw new CatalogError('invalid_catalog', 'Cada recurso deve aparecer uma única vez no serviço.');
      }
      exigenciasVistas.add(exigencia.resourceType);
      if (!conhecidos.has(exigencia.resourceType)) {
        throw new CatalogError(
          'invalid_catalog',
          `A barbearia não tem "${exigencia.resourceType}" cadastrado como recurso.`,
        );
      }
      if (exigencia.quantity < 1) {
        throw new CatalogError('invalid_catalog', 'A quantidade precisa ser pelo menos 1.');
      }
    }

    await tx.$executeRaw`
      DELETE FROM service_resource_requirements WHERE service_id = ${params.serviceId}::uuid
    `;
    for (const exigencia of params.requirements) {
      await tx.$executeRaw`
        INSERT INTO service_resource_requirements
          (tenant_id, service_id, resource_type, quantity)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${params.serviceId}::uuid, ${exigencia.resourceType}, ${exigencia.quantity}
        )
      `;
    }
  });
}
