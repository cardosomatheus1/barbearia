import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { criarUnidade, definirUnidadeAtiva, unidadesDoCadastro } from './unidades.js';

/**
 * Abrir e fechar uma loja, contra Postgres real (bloco 58).
 *
 * O que só o banco prova: que a última aberta não fecha, que fechar solta a
 * escolha das sessões que estavam nela, e que a barbearia vizinha não enxerga
 * nem edita a unidade da outra.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '58585858-aaaa-1111-1111-111111111111';
const RIVAL = '58585858-bbbb-2222-2222-222222222222';
const MATRIZ = 'a5858585-aaaa-0000-0000-000000000001';
const DELES = 'a5858585-bbbb-0000-0000-000000000009';
const DONO = 'd5858585-aaaa-0000-0000-000000000001';

const ator = { id: DONO, name: 'Matheus' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('unidades da casa', () => {
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
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Vizinha');

      INSERT INTO locations (id, tenant_id, name, timezone) VALUES
        ('${MATRIZ}', '${TENANT}', 'Matriz', 'America/Bahia'),
        ('${DELES}', '${RIVAL}', 'Deles', 'America/Bahia');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');
    `);
  });

  it('a segunda loja nasce aberta e com o próprio fuso', async () => {
    /**
     * O fuso é da unidade e não do processo: uma rede com loja em Salvador e em
     * Rio Branco tem dois "hoje", e o dia da venda sai do fuso de onde a venda
     * aconteceu.
     */
    await criarUnidade({
      tenantId: TENANT,
      nome: 'Domari Rio Branco',
      timezone: 'America/Rio_Branco',
      cidade: 'Rio Branco',
      ator,
    });

    const lista = await unidadesDoCadastro(TENANT);
    expect(lista).toHaveLength(2);
    expect(lista[1]).toMatchObject({
      nome: 'Domari Rio Branco',
      timezone: 'America/Rio_Branco',
      ativa: true,
      cidade: 'Rio Branco',
    });
  });

  it('a única unidade aberta não fecha', async () => {
    /**
     * Sem esta recusa a barbearia inteira ficaria sem loja operável com um
     * clique: `resolverUnidade` devolveria `unidade_fechada` para todo mundo, e
     * as vinte rotas do painel responderiam 404 — inclusive a que reabriria.
     */
    await expect(
      definirUnidadeAtiva({ tenantId: TENANT, locationId: MATRIZ, ativa: false, ator }),
    ).rejects.toMatchObject({ code: 'ultima_unidade' });

    expect((await unidadesDoCadastro(TENANT))[0]?.ativa).toBe(true);
  });

  it('fechar a segunda é aceito, e reabrir também', async () => {
    const { id } = await criarUnidade({
      tenantId: TENANT, nome: 'Domari Pituba', timezone: 'America/Bahia', ator,
    });

    await definirUnidadeAtiva({ tenantId: TENANT, locationId: id, ativa: false, ator });
    expect((await unidadesDoCadastro(TENANT)).find((u) => u.id === id)?.ativa).toBe(false);

    await definirUnidadeAtiva({ tenantId: TENANT, locationId: id, ativa: true, ator });
    expect((await unidadesDoCadastro(TENANT)).find((u) => u.id === id)?.ativa).toBe(true);
  });

  it('fechar solta a escolha de quem estava operando nela', async () => {
    /**
     * Sem isto a pessoa continua com a loja fechada selecionada e recebe
     * "unidade fechada" em toda tela — sem entender por quê e sem caminho de
     * volta a não ser sair e entrar.
     */
    const { id } = await criarUnidade({
      tenantId: TENANT, nome: 'Domari Pituba', timezone: 'America/Bahia', ator,
    });
    await exec(`
      INSERT INTO staff_sessions (tenant_id, staff_user_id, token_hash, expires_at, location_id)
      VALUES ('${TENANT}', '${DONO}', 'abc123', now() + interval '1 day', '${id}');
    `);

    await definirUnidadeAtiva({ tenantId: TENANT, locationId: id, ativa: false, ator });

    const sessoes = await withTenant(TENANT, async (tx) =>
      tx.$queryRaw<{ location_id: string | null }[]>`
        SELECT location_id FROM staff_sessions WHERE staff_user_id = ${DONO}::uuid
      `,
    );
    expect(sessoes[0]?.location_id).toBeNull();
  });

  it('a unidade da barbearia vizinha não é vista nem fechada', async () => {
    expect(await unidadesDoCadastro(TENANT)).toHaveLength(1);

    await expect(
      definirUnidadeAtiva({ tenantId: TENANT, locationId: DELES, ativa: false, ator }),
    ).rejects.toMatchObject({ code: 'location_not_found' });
  });

  it('nome curto demais é recusado antes de tocar o banco', async () => {
    await expect(
      criarUnidade({ tenantId: TENANT, nome: ' x ', timezone: 'America/Bahia', ator }),
    ).rejects.toMatchObject({ code: 'invalid_location' });
  });

  it('abrir e fechar deixam rastro na trilha', async () => {
    const { id } = await criarUnidade({
      tenantId: TENANT, nome: 'Domari Pituba', timezone: 'America/Bahia', ator,
    });
    await definirUnidadeAtiva({ tenantId: TENANT, locationId: id, ativa: false, ator });

    const eventos = await withTenant(TENANT, async (tx) =>
      tx.$queryRaw<{ action: string }[]>`
        SELECT action FROM audit_log WHERE entity = 'locations' ORDER BY created_at
      `,
    );
    expect(eventos.map((e) => e.action)).toEqual(['location.created', 'location.closed']);
  });
});
