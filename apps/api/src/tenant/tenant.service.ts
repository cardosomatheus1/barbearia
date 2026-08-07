import { Injectable, Logger } from '@nestjs/common';
import { getPrisma } from '@barbearia/db';

interface CacheEntry {
  readonly tenantId: string | null;
  readonly expiresAt: number;
}

/**
 * Resolve o slug público da barbearia no tenant interno.
 *
 * O slug vem da bio do Instagram e é a única coisa que o visitante anônimo
 * conhece. A tabela `tenant_slugs` tem política de leitura pública justamente
 * porque este mapeamento precisa ser consultado **antes** de haver tenant no
 * contexto — é o único ponto do sistema com essa característica, e por isso a
 * política é `FOR SELECT` apenas: escrita continua restrita ao dono.
 *
 * O `tenant_id` resolvido é interno e nunca aparece em resposta da API.
 */
@Injectable()
export class TenantService {
  private readonly logger = new Logger(TenantService.name);
  private readonly cache = new Map<string, CacheEntry>();

  /** Slug muda raramente; TTL curto evita uma ida ao banco por requisição. */
  private readonly ttlMs = 60_000;

  /** Sobrescrevível em teste. Não vai pelo construtor para não virar
   *  dependência que o container tenta resolver. */
  now: () => number = () => Date.now();

  async resolve(slug: string): Promise<string | null> {
    const key = slug.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.tenantId;

    const rows = await getPrisma().$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id FROM tenant_slugs WHERE slug = ${key}::citext LIMIT 1
    `;
    const tenantId = rows[0]?.tenant_id ?? null;

    // Slug inexistente também é cacheado: sem isso, um atacante que varre slugs
    // aleatórios gera uma consulta ao banco por tentativa.
    this.cache.set(key, { tenantId, expiresAt: this.now() + this.ttlMs });
    if (this.cache.size > 10_000) this.evictExpired();

    return tenantId;
  }

  /** Nome do estabelecimento, para compor a mensagem do código. */
  async nameOf(tenantId: string): Promise<string> {
    const rows = await getPrisma().$queryRaw<{ name: string }[]>`
      SELECT name FROM tenants WHERE id = ${tenantId}::uuid
    `;
    return rows[0]?.name ?? 'Barbearia';
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
    this.logger.debug(`cache de slugs: ${this.cache.size} entradas`);
  }
}
