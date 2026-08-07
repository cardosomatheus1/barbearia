import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRlsEnforced, withTenant } from './client.js';

/**
 * `withTenant` é o único ponto por onde a aplicação alcança o banco, e é o que
 * faz a RLS funcionar. Se ele falhar em fixar `app.tenant_id`, ou se o valor
 * vazar entre transações, todo o isolamento multi-tenant cai junto.
 *
 * Requer `APP_DATABASE_URL` apontando para o role `barbearia_app`
 * (NOBYPASSRLS) e `DATABASE_URL` para semear.
 */

const ADMIN_URL = process.env['DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

let admin: PrismaClient;
let app: PrismaClient;

const describeIfDb = ADMIN_URL && APP_URL ? describe : describe.skip;

describeIfDb('withTenant', () => {
  beforeAll(async () => {
    // Estreitamento explícito: `describeIfDb` já garante as duas, mas o
    // compilador não sabe disso — e a regra proíbe `!` para calar o tipo.
    if (!ADMIN_URL || !APP_URL) throw new Error('DATABASE_URL e APP_DATABASE_URL são obrigatórias');
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = new PrismaClient({ datasources: { db: { url: APP_URL } } });

    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe(
      `INSERT INTO tenants (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B')`,
    );
    await admin.$executeRawUnsafe(`
      INSERT INTO customers (tenant_id, name, phone_e164) VALUES
        ('${TENANT_A}', 'Cliente A', '+5571900000001'),
        ('${TENANT_B}', 'Cliente B1', '+5571900000002'),
        ('${TENANT_B}', 'Cliente B2', '+5571900000003')
    `);
  });

  afterAll(async () => {
    await admin?.$disconnect();
    await app?.$disconnect();
  });

  const count = async (tenantId: string): Promise<number> =>
    withTenant(
      tenantId,
      async (tx) => {
        const rows = await tx.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM customers`;
        return Number(rows[0]?.total ?? 0);
      },
      { prisma: app },
    );

  it('enxerga apenas os dados do tenant informado', async () => {
    expect(await count(TENANT_A)).toBe(1);
    expect(await count(TENANT_B)).toBe(2);
  });

  it('não vaza o tenant entre transações na mesma conexão', async () => {
    // O pool reaproveita conexões. Se `set_config` não fosse local à transação,
    // a segunda chamada herdaria o tenant da primeira — o vazamento exato que a
    // RLS existe para impedir. Alternar em sequência força o reúso.
    for (let i = 0; i < 6; i++) {
      expect(await count(TENANT_A)).toBe(1);
      expect(await count(TENANT_B)).toBe(2);
    }
  });

  it('não vaza sob concorrência', async () => {
    const results = await Promise.all([
      count(TENANT_A), count(TENANT_B), count(TENANT_A),
      count(TENANT_B), count(TENANT_A), count(TENANT_B),
    ]);
    expect(results).toEqual([1, 2, 1, 2, 1, 2]);
  });

  it('deixa a sessão sem tenant após a transação', async () => {
    await count(TENANT_A);
    const rows = await app.$queryRaw<{ value: string | null }[]>`
      SELECT NULLIF(current_setting('app.tenant_id', true), '') AS value
    `;
    expect(rows[0]?.value ?? null).toBeNull();
  });

  it('impede gravar em nome de outro tenant', async () => {
    await expect(
      withTenant(
        TENANT_A,
        (tx) => tx.$executeRawUnsafe(
          `INSERT INTO customers (tenant_id, name, phone_e164)
           VALUES ('${TENANT_B}', 'Espiao', '+5571900000009')`,
        ),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });

  it('reverte tudo quando o callback lança', async () => {
    await expect(
      withTenant(
        TENANT_A,
        async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO customers (tenant_id, name, phone_e164)
             VALUES ('${TENANT_A}', 'Temporario', '+5571900000010')`,
          );
          throw new Error('falha no meio da transação');
        },
        { prisma: app },
      ),
    ).rejects.toThrow('falha no meio da transação');

    expect(await count(TENANT_A)).toBe(1);
  });

  it('rejeita tenantId malformado antes de abrir transação', async () => {
    for (const invalid of ['', 'nao-e-uuid', "' OR 1=1 --", '11111111-1111-1111-1111-11111111111']) {
      await expect(withTenant(invalid, async () => 1, { prisma: app })).rejects.toThrow(TypeError);
    }
  });

  it('aceita a conexão da aplicação, que não ignora RLS', async () => {
    await expect(assertRlsEnforced(app)).resolves.toBeUndefined();
  });

  it('recusa conexão de superusuário — RLS seria silenciosamente desligada', async () => {
    await expect(assertRlsEnforced(admin)).rejects.toThrow(/ignora RLS/);
  });

  it('propaga o valor de retorno do callback', async () => {
    const value = await withTenant(TENANT_A, async () => ({ ok: true }), { prisma: app });
    expect(value).toEqual({ ok: true });
  });
});
