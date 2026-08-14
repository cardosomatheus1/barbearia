import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { metasDaRede, meuLugar, redeDaFranqueadora, salvarMetaDaRede } from './rede.js';

/**
 * Indicadores consolidados da rede contra Postgres real (bloco 77).
 *
 * O que só o banco prova: que a soma atravessa a RLS de cada franqueada — e que
 * ela atravessa **só a soma**, sem nome, sem cliente e sem comanda; e que a
 * franqueada não recebe a rede nomeada nem consegue escrever a meta de ninguém.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const DONA = '77777777-1111-1111-1111-111111111111';
const A = '77777777-2222-2222-2222-222222222222';
const B = '77777777-3333-3333-3333-333333333333';
const C = '77777777-4444-4444-4444-444444444444';
const D = '77777777-5555-5555-5555-555555555555';
const FORA = '77777777-6666-6666-6666-666666666666';
const REDE = '77777777-aaaa-1111-1111-111111111111';

const DE = '2026-09-01';
const ATE = '2026-09-30';

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

/** Uma comanda paga, com o dia da unidade — nunca o instante. */
async function venda(tenant: string, cents: number, dia: string): Promise<void> {
  const local = await admin.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM locations WHERE tenant_id = '${tenant}' LIMIT 1`,
  );
  await exec(`
    INSERT INTO orders (tenant_id, location_id, status, subtotal_cents, total_cents,
                        business_day, opened_at, closed_at)
    VALUES ('${tenant}', '${local[0]?.id}', 'paid', ${cents}, ${cents},
            '${dia}', now(), now())
  `);
}

describeIfDb('a rede consolidada', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE franchises CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES
        ('${DONA}', 'Rede Dock'), ('${A}', 'Dock Centro'), ('${B}', 'Dock Feira'),
        ('${C}', 'Dock Norte'), ('${D}', 'Dock Sul'), ('${FORA}', 'Casa Alheia');

      INSERT INTO locations (tenant_id, name, timezone)
      SELECT id, 'Matriz', 'America/Bahia' FROM tenants;

      INSERT INTO franchises (id, name) VALUES ('${REDE}', 'Rede Dock');

      INSERT INTO franchise_tenants (tenant_id, franchise_id, role) VALUES
        ('${DONA}', '${REDE}', 'franqueadora'),
        ('${A}', '${REDE}', 'franqueada'),
        ('${B}', '${REDE}', 'franqueada'),
        ('${C}', '${REDE}', 'franqueada'),
        ('${D}', '${REDE}', 'franqueada')
    `);

    await venda(A, 100_000, '2026-09-10');
    await venda(A, 40_000, '2026-09-11');
    await venda(B, 20_000, '2026-09-10');
    await venda(C, 60_000, '2026-09-12');
    await venda(D, 80_000, '2026-09-12');
    // Fora da janela: é o mês passado, e não pode entrar na soma.
    await venda(A, 999_000, '2026-08-31');
    // De quem não é da rede: não pode aparecer de jeito nenhum.
    await venda(FORA, 500_000, '2026-09-10');
  });

  it('a franqueadora vê a rede nomeada, e só a rede', async () => {
    const rede = await redeDaFranqueadora(DONA, { de: DE, ate: ATE });

    expect(rede.linhas.map((l) => [l.nome, l.receitaCents])).toEqual([
      ['Dock Centro', 140_000],
      ['Dock Sul', 80_000],
      ['Dock Norte', 60_000],
      ['Dock Feira', 20_000],
    ]);
    // A venda de agosto e a da casa de fora ficaram de fora.
    expect(rede.receitaTotalCents).toBe(300_000);
    // Soma sobre contagem: 300.000 / 5 vendas.
    expect(rede.ticketMedioCents).toBe(60_000);
    expect(rede.medianaDaReceitaCents).toBe(70_000);
  });

  it('a franqueada vê o próprio lugar, e nenhum nome da vizinha', async () => {
    /**
     * A redação da identidade acontece dentro da função `SECURITY DEFINER`, que
     * é a fronteira. Uma checagem de rota seria a garantia dependendo de alguém
     * lembrar dela na próxima rota.
     */
    const lugar = await meuLugar(B, { de: DE, ate: ATE });

    expect(lugar.minha.nome).toBe('Dock Feira');
    expect(lugar.minha.receitaCents).toBe(20_000);
    expect(lugar.medianaDaReceitaCents).toBe(70_000);
    // Ninguém fatura menos que ela.
    expect(lugar.percentil).toBe(0);
  });

  it('a franqueada não consegue a rede nomeada, nem pela rota da franqueadora', async () => {
    await expect(redeDaFranqueadora(B, { de: DE, ate: ATE })).rejects.toThrow(/franqueadora/i);
  });

  it('numa rede de uma franqueada só, ela continua sem a rota da franqueadora', async () => {
    /**
     * O caso que a primeira guarda deixava passar. Ela inferia o papel de "veio
     * alguma linha redigida?" — e numa rede com uma franqueada só não vem
     * nenhuma: a única linha é a dela, nomeada. A prova certa é **não estar na
     * lista**, porque a função SQL devolve só franqueadas.
     */
    await exec(`
      DELETE FROM franchise_tenants WHERE tenant_id IN ('${A}', '${C}', '${D}')
    `);

    await expect(redeDaFranqueadora(B, { de: DE, ate: ATE })).rejects.toThrow(/franqueadora/i);
    // E a franqueadora continua vendo a rede, agora de uma.
    const rede = await redeDaFranqueadora(DONA, { de: DE, ate: ATE });
    expect(rede.linhas).toHaveLength(1);
  });

  it('quem não é de franquia nenhuma não vê rede', async () => {
    await expect(redeDaFranqueadora(FORA, { de: DE, ate: ATE })).rejects.toThrow(/rede/i);
    await expect(meuLugar(FORA, { de: DE, ate: ATE })).rejects.toThrow(/rede/i);
  });

  it('a soma atravessa a RLS; o cadastro do cliente não', async () => {
    /**
     * A guarda que importa: o que a franqueadora recebe é **um número**. Se ela
     * conseguisse ler `customers` da franqueada, o bloco teria trocado a lei do
     * contrato de franquia por um vazamento de base.
     */
    await exec(`
      INSERT INTO customers (tenant_id, name, phone_e164)
      VALUES ('${A}', 'Cliente da Franqueada', '+5571988887777')
    `);

    const { withTenant } = await import('@barbearia/db');
    const vistos = await withTenant(DONA, async (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM customers`,
    );
    expect(Number(vistos[0]?.n)).toBe(0);
  });

  it('a meta é combinada pela franqueadora, e a franqueada não escreve a de ninguém', async () => {
    await salvarMetaDaRede({
      tenantId: DONA,
      franqueadaId: A,
      mes: '2026-09-01',
      metaCents: 200_000,
    });

    const rede = await redeDaFranqueadora(DONA, { de: DE, ate: ATE });
    const centro = rede.linhas.find((l) => l.nome === 'Dock Centro');
    expect(centro?.metaCents).toBe(200_000);
    // 140.000 de 200.000.
    expect(centro?.progressoBps).toBe(7000);
    expect(rede.bateramAMeta).toBe(0);

    // A franqueada tentando escrever a própria meta, e a da vizinha.
    await expect(
      salvarMetaDaRede({ tenantId: B, franqueadaId: B, mes: '2026-09-01', metaCents: 1 }),
    ).rejects.toThrow();
    await expect(
      salvarMetaDaRede({ tenantId: B, franqueadaId: A, mes: '2026-09-01', metaCents: 1 }),
    ).rejects.toThrow();
  });

  it('a meta de uma barbearia de fora da rede é recusada, com a mensagem de inexistente', async () => {
    // "Existe, mas não é da sua rede" confirma o id para quem o adivinhou.
    await expect(
      salvarMetaDaRede({ tenantId: DONA, franqueadaId: FORA, mes: '2026-09-01', metaCents: 50_000 }),
    ).rejects.toThrow(/não encontrada/i);
  });

  it('a lista de metas sugere a do mês anterior sem decidir por ninguém', async () => {
    /**
     * Sugere, não renova — a decisão do bloco 22 para a meta do profissional, e
     * aqui pesa mais: a franqueada é outra empresa, e meta que ninguém combinou
     * é cobrança de quem não foi consultado.
     */
    await salvarMetaDaRede({
      tenantId: DONA,
      franqueadaId: A,
      mes: '2026-08-01',
      metaCents: 150_000,
    });

    const metas = await metasDaRede(DONA, '2026-09-15');
    const centro = metas.find((m) => m.nome === 'Dock Centro');
    expect(centro?.mes).toBe('2026-09-01');
    expect(centro?.metaCents).toBeNull();
    expect(centro?.anteriorCents).toBe(150_000);
  });

  it('a franqueada vê a própria meta, e não a da vizinha', async () => {
    await salvarMetaDaRede({
      tenantId: DONA,
      franqueadaId: A,
      mes: '2026-09-01',
      metaCents: 200_000,
    });
    await salvarMetaDaRede({
      tenantId: DONA,
      franqueadaId: B,
      mes: '2026-09-01',
      metaCents: 90_000,
    });

    const lugar = await meuLugar(B, { de: DE, ate: ATE });
    expect(lugar.minha.metaCents).toBe(90_000);

    // A consulta roda **sem filtro** de propósito: quem filtra é a política.
    const { withTenant } = await import('@barbearia/db');
    const vistas = await withTenant(B, async (tx) =>
      tx.$queryRaw<{ tenant_id: string }[]>`SELECT tenant_id FROM franchise_goals`,
    );
    expect(vistas.map((v) => v.tenant_id)).toEqual([B]);
  });
});
