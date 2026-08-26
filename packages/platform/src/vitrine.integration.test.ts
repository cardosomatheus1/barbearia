import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { atualizarVitrine, buscarNaVitrine } from './vitrine.js';
import type { FiltroDaBusca } from '@barbearia/core';

/**
 * A vitrine do marketplace contra Postgres real (bloco 70, SPEC §5.2).
 *
 * O que só o banco prova: que a busca **atravessa** barbearias — que é o ponto
 * do marketplace e o oposto de todo o resto deste produto —, que ela não traz
 * quem optou por sair, quem não publicou, quem não tem coordenada ou quem está
 * bloqueado, e que a cópia é escrita de dentro da barbearia.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const DOMARI = '70707070-1111-1111-1111-111111111111';
const VIZINHA = '70707070-2222-2222-2222-222222222222';
const LOCAL_DOMARI = '70aaaaaa-0000-0000-0000-000000000001';
const LOCAL_VIZINHA = '70aaaaaa-0000-0000-0000-000000000002';

/** Salvador, Rio Vermelho. */
const AQUI = { latitude: -12.9899, longitude: -38.4767 };
const AGORA = new Date('2026-08-20T12:00:00Z');

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const filtro = (parcial: Partial<FiltroDaBusca> = {}): FiltroDaBusca => ({
  de: AQUI,
  raioKm: 5,
  ordem: 'distancia',
  notaMinimaBps: null,
  precoMaximoCents: null,
  comodidades: [],
  somenteComClube: false,
  ...parcial,
});

const atualizarAmbas = async () => {
  await atualizarVitrine({ tenantId: DOMARI, locationId: LOCAL_DOMARI, agora: AGORA });
  await atualizarVitrine({ tenantId: VIZINHA, locationId: LOCAL_VIZINHA, agora: AGORA });
};

describeIfDb('a vitrine do marketplace', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(`
      INSERT INTO tenants (id, name, published_at) VALUES
        ('${DOMARI}', 'Domari Barber Club', now()),
        ('${VIZINHA}', 'Barbearia Vizinha', now());

      INSERT INTO tenant_slugs (tenant_id, slug, is_primary) VALUES
        ('${DOMARI}', 'domari-barber-club', true),
        ('${VIZINHA}', 'barbearia-vizinha', true);

      -- A linha de tenant_platform nasce por gatilho junto de tenants: inseri-la
      -- aqui viola a chave, e a semente é que estava errada.

      INSERT INTO locations (id, tenant_id, name, timezone, city, state, latitude, longitude, amenities)
      VALUES
        ('${LOCAL_DOMARI}', '${DOMARI}', 'Matriz', 'America/Bahia', 'Salvador', 'BA',
         ${AQUI.latitude}, ${AQUI.longitude}, ARRAY['accessible']),
        ('${LOCAL_VIZINHA}', '${VIZINHA}', 'Única', 'America/Bahia', 'Salvador', 'BA',
         ${AQUI.latitude + 0.009}, ${AQUI.longitude}, ARRAY[]::text[]);

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes) VALUES
        ('70eeeeee-0000-0000-0000-000000000001', '${DOMARI}', 'Corte', 5500, 30),
        ('70eeeeee-0000-0000-0000-000000000002', '${DOMARI}', 'Barba', 3500, 20),
        ('70eeeeee-0000-0000-0000-000000000003', '${VIZINHA}', 'Corte', 4000, 30);

      -- O piso do card exige profissional que venda online, como a página
      -- pública: sem cadeira, o serviço existe e ninguém o marca.
      INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
        ('70bbbbbb-0000-0000-0000-000000000001', '${DOMARI}', '${LOCAL_DOMARI}', 'Ruan', 'professional'),
        ('70bbbbbb-0000-0000-0000-000000000002', '${VIZINHA}', '${LOCAL_VIZINHA}', 'Gleidson', 'professional');

      INSERT INTO professional_services (professional_id, service_id, tenant_id) VALUES
        ('70bbbbbb-0000-0000-0000-000000000001', '70eeeeee-0000-0000-0000-000000000001', '${DOMARI}'),
        ('70bbbbbb-0000-0000-0000-000000000001', '70eeeeee-0000-0000-0000-000000000002', '${DOMARI}'),
        ('70bbbbbb-0000-0000-0000-000000000002', '70eeeeee-0000-0000-0000-000000000003', '${VIZINHA}')
    `);
  });

  it('a busca atravessa barbearias, que é o ponto do marketplace', async () => {
    /**
     * Toda outra leitura deste produto para na parede da RLS de propósito. Esta
     * é a exceção, e ela existe porque descobrir **qual** barbearia é o que a
     * busca faz — não haveria tenant para fixar no contexto.
     */
    await atualizarAmbas();

    const achadas = await buscarNaVitrine(filtro());
    expect(achadas.map((r) => r.slug).sort()).toEqual([
      'barbearia-vizinha',
      'domari-barber-club',
    ]);
  });

  it('o preço do card é o menor do catálogo, não o ticket', async () => {
    // "Corte a partir de R$ 55,00" — o piso é o que faz a pessoa clicar, e é o
    // único número de preço que não depende do que ela vai escolher.
    await atualizarAmbas();
    const porPreco = await buscarNaVitrine(filtro({ ordem: 'preco' }));
    // A Domari vende corte a 55 e barba a 35: o piso dela é 35, não a média nem
    // o corte. É por isso que ela vem antes da vizinha, que tem piso de 40.
    expect(porPreco[0]?.slug).toBe('domari-barber-club');
    expect(porPreco[0]?.precoDeCents).toBe(3500);
    expect(porPreco[1]?.precoDeCents).toBe(4000);
  });

  it('quem sai da vitrine some da busca, e a linha é apagada', async () => {
    /**
     * Ausência em vez de coluna "escondida": um estado a mais seria algo que
     * toda consulta futura teria que lembrar de filtrar, e esquecer disso é
     * como uma barbearia que pediu para sair reaparece.
     */
    await atualizarAmbas();
    await exec(
      `UPDATE locations SET listed_in_marketplace = false WHERE id = '${LOCAL_DOMARI}'`,
    );
    await atualizarVitrine({ tenantId: DOMARI, locationId: LOCAL_DOMARI, agora: AGORA });

    expect((await buscarNaVitrine(filtro())).map((r) => r.slug)).toEqual(['barbearia-vizinha']);
    const sobrou = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM marketplace_listings`,
    );
    expect(Number(sobrou[0]?.n ?? 0)).toBe(1);
  });

  it('quem não publicou não aparece', async () => {
    // `published_at` separa "conta criada" de "link no ar" desde o bloco 13. Uma
    // barbearia que ainda está montando o catálogo na vitrine é o pior primeiro
    // contato possível.
    await exec(`UPDATE tenants SET published_at = NULL WHERE id = '${DOMARI}'`);
    await atualizarAmbas();

    expect((await buscarNaVitrine(filtro())).map((r) => r.slug)).toEqual(['barbearia-vizinha']);
  });

  it('quem não tem coordenada não aparece', async () => {
    // Sem latitude e longitude não há "perto de mim": a linha seria um resultado
    // que nenhuma busca encontra, e um cadastro que ninguém explica.
    await exec(
      `UPDATE locations SET latitude = NULL, longitude = NULL WHERE id = '${LOCAL_DOMARI}'`,
    );
    await atualizarAmbas();

    expect((await buscarNaVitrine(filtro())).map((r) => r.slug)).toEqual(['barbearia-vizinha']);
  });

  it('barbearia bloqueada não é vendida pela plataforma', async () => {
    await atualizarAmbas();
    await exec(
      `UPDATE tenant_platform SET blocked_at = now(), blocked_reason = 'inadimplente'
        WHERE tenant_id = '${DOMARI}'`,
    );

    expect((await buscarNaVitrine(filtro())).map((r) => r.slug)).toEqual(['barbearia-vizinha']);
  });

  it('a nota da vitrine é a pública, com o mesmo mínimo da página', async () => {
    /**
     * Duas fontes para a mesma nota fariam o card do marketplace e a página da
     * barbearia dizerem números diferentes sobre a mesma casa — e quem compara
     * os dois é justamente quem está decidindo.
     */
    await exec(`
      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('70cccccc-0000-0000-0000-000000000001', '${DOMARI}', 'Carlos', '+5571988887777')
    `);
    // Uma avaliação só: abaixo do mínimo, a nota não sai.
    await exec(`
      INSERT INTO reviews (tenant_id, customer_id, rating)
      VALUES ('${DOMARI}', '70cccccc-0000-0000-0000-000000000001', 5)
    `);
    await atualizarAmbas();
    const [domari] = (await buscarNaVitrine(filtro())).filter((r) => r.slug === 'domari-barber-club');
    expect(domari?.notaBps).toBeNull();
    expect(domari?.avaliacoes).toBe(1);
  });

  it('o preço do card é o que a página pública oferece, não todo serviço ativo', async () => {
    /**
     * Achado da `/security-review` deste bloco: a primeira versão usava o menor
     * preço de **qualquer** serviço ativo, e publicava numa vitrine anônima o
     * preço que a barbearia tinha mantido fora da própria página — um "corte
     * funcionário" de R$ 10 que ninguém pode marcar online.
     *
     * O predicado é o mesmo de `getPublicProfile`: serviço vendável online, com
     * profissional vendável online nesta unidade.
     */
    await exec(`
      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes, bookable_online)
      VALUES ('70eeeeee-0000-0000-0000-000000000009', '${DOMARI}', 'Corte funcionário', 1000, 30, false);

      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      VALUES ('70bbbbbb-0000-0000-0000-000000000001', '70eeeeee-0000-0000-0000-000000000009', '${DOMARI}')
    `);
    await atualizarAmbas();

    const [domari] = (await buscarNaVitrine(filtro())).filter(
      (r) => r.slug === 'domari-barber-club',
    );
    // A barba, de 35 — nunca o interno de 10.
    expect(domari?.precoDeCents).toBe(3500);
  });

  it('a busca respeita o raio e a comodidade pedida', async () => {
    await atualizarAmbas();

    const acessiveis = await buscarNaVitrine(filtro({ comodidades: ['accessible'] }));
    expect(acessiveis.map((r) => r.slug)).toEqual(['domari-barber-club']);

    // A vizinha está a ~1 km ao norte; um raio de 500 m deixa só a daqui.
    const pertinho = await buscarNaVitrine(filtro({ raioKm: 0.5 }));
    expect(pertinho.map((r) => r.slug)).toEqual(['domari-barber-club']);
  });
});
