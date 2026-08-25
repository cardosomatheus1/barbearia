import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clientesNaPorta } from './clientes.js';

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = 'abababab-1111-4111-8111-111111111111';
const LOCATION = 'abababab-2222-4222-8222-222222222222';
const PROFESSIONAL = 'abababab-3333-4333-8333-333333333333';
let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((x) => x.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const customerId = (n: number) => `abababab-4444-4444-8444-${String(n).padStart(12, '0')}`;

describeIfDb('porta de clientes paginada no PostgreSQL', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => admin?.$disconnect());

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Escala');
      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia');
      INSERT INTO professionals (id, tenant_id, location_id, name)
      VALUES ('${PROFESSIONAL}', '${TENANT}', '${LOCATION}', 'Ruan')
    `);

    for (let n = 1; n <= 65; n += 1) {
      const nome = n === 42 ? 'João Especial' : `Cliente ${String(n).padStart(2, '0')}`;
      const telefone = n === 42 ? '+5571988887777' : `+55719${String(10000000 + n).slice(-8)}`;
      await admin.$executeRawUnsafe(`
        INSERT INTO customers (id, tenant_id, name, phone_e164, created_at, balance_cents)
        VALUES ('${customerId(n)}', '${TENANT}', '${nome}', '${telefone}',
                '2026-08-${String((n % 20) + 1).padStart(2, '0')}T12:00:00Z', ${n === 5 ? -2500 : 0})
      `);
    }

    await exec(`
      INSERT INTO appointments
        (tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, status)
      VALUES
        ('${TENANT}', '${LOCATION}', '${customerId(7)}', '${PROFESSIONAL}',
         '2026-08-22T15:00:00Z', '2026-08-22T15:30:00Z',
         '2026-08-22T15:00:00Z', '2026-08-22T15:30:00Z', 'confirmed')
    `);
  });

  const entrada = {
    tenantId: TENANT,
    hoje: '2026-08-22',
    podeVerAgenda: true,
    podeVerSegmento: false,
    podeVerFiado: true,
    agora: new Date('2026-08-22T12:00:00Z'),
  } as const;

  it('retorna 30 por página sem perder o total da base', async () => {
    const primeira = await clientesNaPorta(entrada);
    const terceira = await clientesNaPorta({ ...entrada, pagina: 3 });
    expect(primeira.total).toBe(65);
    expect(primeira.clientes).toHaveLength(30);
    expect(terceira.clientes).toHaveLength(5);
  });

  it('nome usa sem_acento e telefone exige a chave inteira', async () => {
    expect((await clientesNaPorta({ ...entrada, busca: 'JOAO' })).clientes.map((c) => c.nome))
      .toEqual(['João Especial']);
    expect((await clientesNaPorta({ ...entrada, busca: '(71) 98888-7777' })).total).toBe(1);
    expect((await clientesNaPorta({ ...entrada, busca: '7777' })).total).toBe(0);
  });

  it('Hoje e Fiado são filtrados no banco', async () => {
    expect((await clientesNaPorta({ ...entrada, filtro: 'hoje' })).clientes.map((c) => c.id))
      .toEqual([customerId(7)]);
    expect((await clientesNaPorta({ ...entrada, filtro: 'fiado' })).clientes.map((c) => c.id))
      .toEqual([customerId(5)]);
  });
});
