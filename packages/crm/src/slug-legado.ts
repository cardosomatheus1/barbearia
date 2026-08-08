import { withTenant } from '@barbearia/db';
import { audit } from '@barbearia/identity';

/**
 * O slug do sistema antigo — SPEC §5.8.
 *
 * > "Ao migrar de outro sistema, permitir cadastrar o slug antigo em
 * > `tenant_slugs` para o link da bio continuar funcionando (Parte 1 §1.5)."
 *
 * É a menor funcionalidade deste bloco e uma das que mais decidem a migração.
 * O link do agendamento está na bio do Instagram, impresso no cartão e colado no
 * espelho. Trocar de sistema sem levar o endereço junto significa que todo
 * cliente que clicar no link antigo cai numa página de erro do concorrente — e a
 * barbearia leva a culpa.
 *
 * `tenant_slugs` já era feita para isso desde o bloco 1: slug é permanente, e
 * renomear **adiciona** em vez de substituir. Aqui só se abre a porta.
 */

export type SlugErro = 'formato_invalido' | 'ja_usado' | 'ja_e_seu' | 'reservado';

export class SlugError extends Error {
  constructor(readonly code: SlugErro) {
    super(`Slug: ${code}`);
    this.name = 'SlugError';
  }
}

/**
 * Nomes que a aplicação usa como rota própria.
 *
 * Um slug `admin` faria a página pública da barbearia disputar o endereço com o
 * painel. A lista é curta de propósito: só o que hoje existe como rota de
 * primeiro nível.
 */
const RESERVADOS = new Set(['admin', 'api', 'app', 'www', 'static', '_next', 'assets']);

/**
 * Minúscula, número e hífen; nunca hífen na ponta. De 2 a 60 caracteres.
 *
 * O piso de 2 é o que `slugify` produz para o nome mais curto que uma barbearia
 * de verdade tem ("Zé" vira `ze`). Um caractere fica de fora porque endereço de
 * uma letra é fácil demais de ocupar por garimpo — e ninguém digita o link, ele
 * é clicado.
 */
const FORMATO = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])$/;

/**
 * Confere o formato antes de tocar o banco.
 *
 * O mesmo formato que `slugify` produz: minúscula, número e hífen, sem hífen nas
 * pontas. Aceitar mais aqui criaria endereço que o gerador nunca produziria e
 * que ninguém consegue reproduzir depois.
 */
export function slugLegadoValido(slug: string): boolean {
  return FORMATO.test(slug) && !RESERVADOS.has(slug);
}

export async function adicionarSlugLegado(params: {
  readonly tenantId: string;
  readonly slug: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly ip?: string | undefined;
}): Promise<{ readonly slug: string }> {
  const slug = params.slug.trim().toLowerCase();

  if (RESERVADOS.has(slug)) throw new SlugError('reservado');
  if (!FORMATO.test(slug)) throw new SlugError('formato_invalido');

  return withTenant(params.tenantId, async (tx) => {
    /**
     * A leitura de `tenant_slugs` é pública — a API precisa resolver o slug
     * antes de ter um tenant no contexto (bloco 1). Então aqui a consulta
     * enxerga o slug de qualquer barbearia, e é por isso que a checagem existe:
     * não é a RLS que separa, é este `SELECT`.
     */
    const donos = await tx.$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id FROM tenant_slugs WHERE slug = ${slug}
    `;

    const dono = donos[0];
    if (dono) {
      // Mesma resposta para "é seu" e "é de outro"? Não: aqui quem pergunta é o
      // dono autenticado da barbearia, e saber que o endereço está ocupado é o
      // que ele precisa para escolher outro. O que não se revela é **de quem**.
      throw new SlugError(dono.tenant_id === params.tenantId ? 'ja_e_seu' : 'ja_usado');
    }

    await tx.$executeRaw`
      INSERT INTO tenant_slugs (slug, tenant_id, is_primary)
      VALUES (${slug}, NULLIF(current_setting('app.tenant_id', true), '')::uuid, false)
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'slug.added',
      entity: 'tenant_slugs',
      after: { slug },
      ...(params.ip ? { ip: params.ip } : {}),
    });

    return { slug };
  });
}

export interface SlugDaCasa {
  readonly slug: string;
  readonly principal: boolean;
  readonly criadoEm: string;
}

/**
 * Todos os endereços que levam a esta barbearia.
 *
 * **A única consulta do produto que repete `tenant_id` no `WHERE` de propósito.**
 * A regra do `CLAUDE.md` §2 — deixar a política filtrar, para que um `WHERE`
 * esquecido não vaze — pressupõe uma política de `SELECT` por tenant.
 * `tenant_slugs` não tem: a dela é `USING (true)`, porque a API precisa resolver
 * `/{slug}` **antes** de existir tenant no contexto. Escrever é que é por tenant
 * (`WITH CHECK`). Aqui, portanto, quem filtra é esta linha; sem ela a tela
 * listaria o endereço de todas as barbearias do produto.
 */
export async function listarSlugs(tenantId: string): Promise<readonly SlugDaCasa[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { slug: string; is_primary: boolean; created_at: Date }[]
    >`
      SELECT slug, is_primary, created_at FROM tenant_slugs
       WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
       ORDER BY is_primary DESC, created_at
    `;

    return linhas.map((linha) => ({
      slug: linha.slug,
      principal: linha.is_primary,
      criadoEm: linha.created_at.toISOString(),
    }));
  });
}
