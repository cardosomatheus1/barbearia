import { Injectable, Logger } from '@nestjs/common';
import { getPrisma } from '@barbearia/db';

interface CacheEntry {
  readonly tenantId: string | null;
  readonly expiresAt: number;
}

interface EntradaDeBloqueio {
  readonly bloqueada: boolean;
  readonly motivo: string | null;
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
  private readonly bloqueios = new Map<string, EntradaDeBloqueio>();

  /** Slug muda raramente; TTL curto evita uma ida ao banco por requisição. */
  private readonly ttlMs = 60_000;

  /** Limite duro: TTL sozinho não contém uma varredura distribuída de slugs. */
  private readonly maxCacheEntries = 10_000;

  /**
   * O bloqueio expira mais rápido que o slug, e o motivo não é performance.
   *
   * `esquecerBloqueio` derruba o cache **do processo que bloqueou**. Com mais de
   * uma instância de API atrás do balanceador, as outras continuam servindo a
   * barbearia bloqueada até o TTL vencer — então este número é literalmente por
   * quantos segundos, no pior caso, uma conta bloqueada continua atendendo.
   */
  private readonly ttlDoBloqueioMs = 30_000;

  /** Sobrescrevível em teste. Não vai pelo construtor para não virar
   *  dependência que o container tenta resolver. */
  now: () => number = () => Date.now();

  /**
   * Slug para tenant — e **nada** para barbearia bloqueada.
   *
   * O bloqueio é aplicado aqui, e não em cada controller, porque este é o único
   * ponto por onde toda a superfície pública passa: perfil, grade, agendamento,
   * fila e a sessão do cliente. Espalhar a checagem pelos nove chamadores
   * significaria que a décima rota pública, escrita daqui a três blocos, nasce
   * furada — e ninguém veria, porque nada dá erro.
   *
   * O visitante recebe 404, não "esta barbearia foi bloqueada por falta de
   * pagamento": a inadimplência do estabelecimento não é assunto de quem só
   * queria cortar o cabelo. Quem precisa do motivo é o dono, e ele o recebe na
   * porta da equipe.
   */
  async resolve(slug: string): Promise<string | null> {
    const key = slug.toLowerCase();
    const cached = this.cache.get(key);
    const tenantId = cached && cached.expiresAt > this.now() ? cached.tenantId : await this.buscar(key);
    if (!tenantId) return null;

    return (await this.bloqueio(tenantId)).bloqueada ? null : tenantId;
  }

  private async buscar(key: string): Promise<string | null> {
    const rows = await getPrisma().$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id FROM tenant_slugs WHERE slug = ${key}::citext LIMIT 1
    `;
    const tenantId = rows[0]?.tenant_id ?? null;

    // Slug inexistente também é cacheado: sem isso, um atacante que varre slugs
    // aleatórios gera uma consulta ao banco por tentativa.
    this.cache.set(key, { tenantId, expiresAt: this.now() + this.ttlMs });
    if (this.cache.size > this.maxCacheEntries) this.limitarCache(this.cache, 'slugs');

    return tenantId;
  }

  /**
   * O estado de bloqueio, com motivo.
   *
   * `tenant_platform` tem política `USING (true)` e não guarda dado de cliente
   * (migração 0026), então ela é legível sem tenant fixado — que é exatamente a
   * situação de quem ainda está resolvendo qual é o tenant.
   */
  async bloqueio(tenantId: string): Promise<{ bloqueada: boolean; motivo: string | null }> {
    const guardado = this.bloqueios.get(tenantId);
    if (guardado && guardado.expiresAt > this.now()) {
      return { bloqueada: guardado.bloqueada, motivo: guardado.motivo };
    }

    const linhas = await getPrisma().$queryRaw<{ blocked_reason: string | null }[]>`
      SELECT blocked_reason FROM tenant_platform
      WHERE tenant_id = ${tenantId}::uuid AND blocked_at IS NOT NULL
    `;
    const linha = linhas[0];
    const estado = linha
      ? { bloqueada: true, motivo: linha.blocked_reason }
      : { bloqueada: false, motivo: null };

    this.bloqueios.set(tenantId, { ...estado, expiresAt: this.now() + this.ttlDoBloqueioMs });
    if (this.bloqueios.size > this.maxCacheEntries) this.limitarCache(this.bloqueios, 'bloqueios');
    return estado;
  }

  /** Chamado quando a plataforma bloqueia ou desbloqueia. */
  esquecerBloqueio(tenantId: string): void {
    this.bloqueios.delete(tenantId);
  }

  /**
   * Esquece um slug.
   *
   * O cache guarda também a ausência — sem isso, varrer slugs aleatórios geraria
   * uma consulta por tentativa. O efeito colateral: um slug consultado **antes**
   * de existir fica sessenta segundos respondendo "não existe", inclusive logo
   * depois de a barbearia publicar. Quem acabou de pôr o link no ar e o abre
   * veria a própria página em 404.
   *
   * Chamado quando um slug nasce (cadastro) e quando vai ao ar (publicação).
   */
  forget(slug: string): void {
    this.cache.delete(slug.toLowerCase());
  }

  /**
   * Nome do estabelecimento, para compor a mensagem do código.
   *
   * Por `nome_da_barbearia`, e não por um `SELECT` direto: a consulta anterior
   * rodava **fora** de `withTenant`, e `tenants` tem `FORCE ROW LEVEL SECURITY`
   * com política por `id = current_setting('app.tenant_id')`. Sem tenant no
   * contexto ela devolvia **zero linhas, em silêncio**, e todo código de acesso
   * saía como *"Seu código para Barbearia"* — desde o bloco 5, sem nada falhar
   * e sem nada logar.
   *
   * Aqui não dá para abrir `withTenant`: quem chama está resolvendo **quem é** a
   * barbearia, antes de o contexto existir. A função da migração 0078 recorta
   * exatamente a coluna que já é pública; a política estrita continua valendo
   * para o resto da linha, porque RLS não recorta coluna.
   */
  async nameOf(tenantId: string): Promise<string> {
    const rows = await getPrisma().$queryRaw<{ nome: string | null }[]>`
      SELECT nome_da_barbearia(${tenantId}::uuid) AS nome
    `;
    return rows[0]?.nome ?? 'Barbearia';
  }

  /**
   * Remove expirados e, se um burst ainda mantiver tudo vivo, descarta as
   * entradas mais antigas até o teto. `Map` preserva ordem de inserção, então
   * isto é determinístico e impede crescimento sem limite sob slugs aleatórios.
   */
  private limitarCache<T extends { readonly expiresAt: number }>(
    cache: Map<string, T>,
    nome: string,
  ): void {
    const agora = this.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= agora) cache.delete(key);
    }

    while (cache.size > this.maxCacheEntries) {
      const maisAntiga = cache.keys().next().value;
      if (maisAntiga === undefined) break;
      cache.delete(maisAntiga);
    }
    this.logger.debug(`cache de ${nome}: ${cache.size} entradas`);
  }
}
