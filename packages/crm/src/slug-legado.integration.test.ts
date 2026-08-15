import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { SlugError, adicionarSlugLegado, listarSlugs, slugLegadoValido } from './slug-legado.js';

/**
 * O slug do sistema antigo contra Postgres real.
 *
 * `tenant_slugs` é a única tabela do produto cuja leitura é pública — a API
 * resolve `/{slug}` antes de existir tenant no contexto. Só um teste com RLS de
 * verdade mostra a consequência: aqui, quem separa as barbearias é o `WHERE`,
 * não a política, e é isso que precisa ser provado.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const GESTOR = 'dddddddd-0000-0000-0000-000000000001';

let admin: PrismaClient;
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(parte);
  }
}

describeIfDb('slug legado', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(admin, `
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Rival');

      INSERT INTO tenant_slugs (slug, tenant_id, is_primary) VALUES
        ('domari-barber-club', '${TENANT}', true),
        ('rival-barbearia', '${RIVAL}', true);

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${GESTOR}', '${TENANT}', 'Matheus Cardoso', 'dono@domari.com.br', 'x', 'owner');
    `);
  });

  const adicionar = (slug: string, tenantId = TENANT) =>
    adicionarSlugLegado({
      tenantId,
      slug,
      staffId: GESTOR,
      staffName: 'Matheus Cardoso',
    });

  it('o link antigo passa a levar para a barbearia', async () => {
    // É o motivo da funcionalidade: o endereço está na bio do Instagram e no
    // cartão impresso, e trocar de sistema não pode quebrá-lo.
    await adicionar('barbearia-do-ze');

    const slugs = await listarSlugs(TENANT);
    expect(slugs.map((s) => s.slug)).toEqual(['domari-barber-club', 'barbearia-do-ze']);
  });

  it('o novo endereço não vira o principal', async () => {
    // O principal é o que a tela mostra e o que os links novos usam. O legado
    // existe para não quebrar o que já circula, não para substituir.
    await adicionar('barbearia-do-ze');

    const slugs = await listarSlugs(TENANT);
    expect(slugs.find((s) => s.principal)?.slug).toBe('domari-barber-club');
    expect(slugs.find((s) => s.slug === 'barbearia-do-ze')?.principal).toBe(false);
  });

  it('endereço de outra barbearia é recusado', async () => {
    const erro = await adicionar('rival-barbearia').catch((e: SlugError) => e);
    expect((erro as SlugError).code).toBe('ja_usado');
  });

  it('endereço que já é seu diz isso, em vez de "ocupado"', async () => {
    const erro = await adicionar('domari-barber-club').catch((e: SlugError) => e);
    expect((erro as SlugError).code).toBe('ja_e_seu');
  });

  it('a lista de uma barbearia não mostra o endereço da outra', async () => {
    // `tenant_slugs` tem SELECT público (`USING (true)`), então quem separa é o
    // WHERE desta consulta. Sem ele, a tela listaria o endereço de todo mundo.
    const slugs = await listarSlugs(TENANT);
    expect(slugs.map((s) => s.slug)).not.toContain('rival-barbearia');
    expect(slugs).toHaveLength(1);
  });

  it('não dá para pendurar um endereço na barbearia de outro', async () => {
    // Mesmo com o tenant do rival no contexto, a política de INSERT exige que a
    // linha seja dele — e é ela que impede o sequestro de endereço.
    await adicionar('so-da-rival', RIVAL);
    expect((await listarSlugs(TENANT)).map((s) => s.slug)).not.toContain('so-da-rival');
    expect((await listarSlugs(RIVAL)).map((s) => s.slug)).toContain('so-da-rival');
  });

  it('recusa endereço que a aplicação usa como rota', async () => {
    // `/admin` é o painel. Um slug com esse nome faria a página pública da
    // barbearia disputar o endereço com ele.
    //
    // `plataforma` e `ir` estão aqui porque a lista já ficou para trás uma vez:
    // ela nasceu com sete nomes e o `apps/web` cresceu quatro rotas por baixo,
    // sem nada acusar. Quem guarda contra isso agora é
    // `scripts/rotas-reservadas.test.mjs`, que deriva os nomes das pastas de
    // `apps/web/src/app`; estes dois estão neste laço para que a recusa também
    // seja provada de ponta a ponta, contra o banco, para uma rota de verdade.
    for (const reservado of ['admin', 'api', '_next', 'plataforma', 'ir']) {
      const erro = await adicionar(reservado).catch((e: SlugError) => e);
      expect((erro as SlugError).code).toBe('reservado');
    }
  });

  it('recusa o que o gerador de slug nunca produziria', async () => {
    // `Barbearia` **não** está nesta lista de propósito: a caixa é normalizada
    // antes de validar, e há teste próprio para isso logo abaixo. Ela estava
    // aqui na primeira versão e reprovou — o teste é que estava errado.
    for (const ruim of ['com espaço', '-começa-com-hifen', 'termina-', 'a', 'ç', 'ba_rra']) {
      const erro = await adicionar(ruim).catch((e: SlugError) => e);
      expect((erro as SlugError).code).toBe('formato_invalido');
    }
  });

  it('normaliza a caixa antes de recusar', async () => {
    // Quem copia da barra de endereço traz maiúscula. Recusar por causa disso
    // seria atrito onde não há ambiguidade.
    const erro = await adicionar('  BARBEARIA-DO-ZE  ').catch((e: SlugError) => e);
    expect(erro).not.toBeInstanceOf(SlugError);
    expect((await listarSlugs(TENANT)).map((s) => s.slug)).toContain('barbearia-do-ze');
  });

  it('fica na trilha, porque muda por onde o cliente chega', async () => {
    await adicionar('barbearia-do-ze');

    const eventos = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ action: string; after: unknown }[]>`
        SELECT action, after FROM audit_log ORDER BY id DESC LIMIT 1
      `,
    );
    expect(eventos[0]).toMatchObject({ action: 'slug.added' });
    expect(eventos[0]?.after).toMatchObject({ slug: 'barbearia-do-ze' });
  });

  it('o formato é conferido sem ir ao banco', () => {
    expect(slugLegadoValido('barbearia-do-ze')).toBe(true);
    expect(slugLegadoValido('ab')).toBe(true);
    expect(slugLegadoValido('admin')).toBe(false);
    expect(slugLegadoValido('a')).toBe(false);
  });
});
