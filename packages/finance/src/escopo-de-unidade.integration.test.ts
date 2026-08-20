import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { abrirCaixa } from './caixa.js';
import { abrirComanda, adicionarItem, ajustarComanda, fecharComanda, getComanda } from './comanda.js';
import { conceberVale, cancelarVale, valesDoPeriodo } from './vale.js';
import { lancarMovimento, margemPorServico, produtos, salvarProduto } from './estoque.js';

/**
 * O que uma loja **não** alcança na outra, contra Postgres real (bloco 117).
 *
 * A RLS separa barbearias e não separa lojas dentro de uma. Todo caso aqui foi
 * reproduzido de ponta a ponta antes do conserto: a gerente escopada à filial
 * fechou a comanda da matriz, concedeu vale ao barbeiro de lá tirando o dinheiro
 * da própria gaveta, e lançou perda de um produto que a loja dela não tinha.
 *
 * O que só o banco prova: que a recusa acontece na consulta, e não numa cláusula
 * de aplicação que uma reescrita perderia.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '17171717-1111-1111-1111-111111111111';
const MATRIZ = 'a1717171-0000-0000-0000-000000000001';
const FILIAL = 'a1717171-0000-0000-0000-000000000002';
const RUAN = 'b1717171-0000-0000-0000-000000000001';
const BRUNO = 'b1717171-0000-0000-0000-000000000002';
const CORTE = 'e1717171-0000-0000-0000-000000000001';
const CARLOS = 'c1717171-0000-0000-0000-000000000001';
const DONO = 'd1717171-0000-0000-0000-000000000001';

const HOJE = '2026-08-20';
const ator = { id: DONO, name: 'Matheus' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('o que uma loja não alcança na outra', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  }, 30_000);

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari');

      INSERT INTO locations (id, tenant_id, name, timezone) VALUES
        ('${MATRIZ}', '${TENANT}', 'Matriz', 'America/Bahia'),
        ('${FILIAL}', '${TENANT}', 'Filial Pituba', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
        ('${RUAN}', '${TENANT}', '${MATRIZ}', 'Ruan', 'professional'),
        ('${BRUNO}', '${TENANT}', '${FILIAL}', 'Bruno', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CORTE}', '${TENANT}', 'Corte', 4900, 30);

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');

      -- Comissao para Ruan no periodo: o teto do vale e o que ele **ja fez**,
      -- e sem ela o adiantamento e recusado por outro motivo que nao a loja.
      -- A semente precisa satisfazer tudo menos a regra sob teste.
      INSERT INTO commission_entries
        (tenant_id, professional_id, earned_on, mode, value, base_cents, sign)
      VALUES ('${TENANT}', '${RUAN}', '${HOJE}', 'percent', 5000, 100000, 1);
    `);
  });

  // -- a comanda --------------------------------------------------------------

  const comandaNaMatriz = () =>
    abrirComanda({
      tenantId: TENANT,
      locationId: MATRIZ,
      customerId: CARLOS,
      staffId: DONO,
    });

  it('a comanda da matriz não é lida, mexida nem fechada pela filial', async () => {
    /**
     * O caminho de escrita inteiro passa por `exigirAberta`, que lia
     * `WHERE id = $1` e nada mais. A gerente escopada à filial fechava a comanda
     * de R$ 85,00 da matriz mandando o id: `orders.location_id` continuava
     * matriz e o `cash_movement` caía na sessão de caixa **da filial**.
     *
     * O caixa da matriz fecha faltando e o da filial sobrando, sem que nenhuma
     * das duas telas explique — e a divergência do fechamento deixa de ter dono,
     * que é a única coisa que a exigência de caixa aberto desde o bloco 18
     * existe para dar.
     */
    const comanda = await comandaNaMatriz();
    await abrirCaixa({
      tenantId: TENANT,
      locationId: FILIAL,
      staffId: DONO,
      staffName: 'Matheus',
      openingCents: 0,
    });

    await expect(getComanda(TENANT, comanda.id, FILIAL)).rejects.toThrow(/não existe/);

    await expect(
      adicionarItem({
        tenantId: TENANT,
        locationId: FILIAL,
        orderId: comanda.id,
        tipo: 'service',
        serviceId: CORTE,
        descricao: 'Corte',
        quantidade: 1,
        precoUnitarioCents: 4900,
        professionalId: BRUNO,
      }),
    ).rejects.toThrow(/não existe/);

    await expect(
      ajustarComanda({
        tenantId: TENANT,
        locationId: FILIAL,
        orderId: comanda.id,
        desconto: { tipo: 'amount', valor: 500, motivo: 'cortesia' },
        staffId: DONO,
        staffName: 'Matheus',
      }),
    ).rejects.toThrow(/não existe/);

    await expect(
      fecharComanda({
        tenantId: TENANT,
        locationId: FILIAL,
        orderId: comanda.id,
        pagamentos: [{ forma: 'cash', valorCents: 0 }],
        staffId: DONO,
        staffName: 'Matheus',
        hojeNaUnidade: HOJE,
      }),
    ).rejects.toThrow(/não existe/);

    // E continua aberta: nenhuma das quatro tentativas mexeu nela.
    const [linha] = await admin.$queryRawUnsafe<{ status: string; location_id: string }[]>(
      `SELECT status::text, location_id FROM orders WHERE id = '${comanda.id}'`,
    );
    expect(linha?.status).toBe('open');
    expect(linha?.location_id).toBe(MATRIZ);
  });

  it('a mesma comanda, pela loja dela, funciona', async () => {
    // A recusa acima precisa ser sobre a **loja**, e não sobre a operação estar
    // quebrada: sem este caso, o teste passaria com tudo recusando sempre.
    const comanda = await comandaNaMatriz();
    const lida = await getComanda(TENANT, comanda.id, MATRIZ);
    expect(lida.id).toBe(comanda.id);
  });

  // -- o vale -----------------------------------------------------------------

  it('o vale não sai da gaveta de uma loja para o barbeiro da outra', async () => {
    /**
     * `conceberVale` conferia que a **unidade** existe, nunca que o profissional
     * é dela. O dinheiro saía da gaveta da filial, o fechamento da folha
     * descontava na loja onde o barbeiro trabalha, e a gaveta da filial fechava
     * faltando.
     */
    await expect(
      conceberVale({
        tenantId: TENANT,
        locationId: FILIAL,
        professionalId: RUAN,
        valorCents: 5000,
        concedidoEm: HOJE,
        de: HOJE,
        ate: HOJE,
        motivo: 'adiantamento',
        pelaGaveta: false,
        staffId: DONO,
        staffName: 'Matheus',
      }),
    ).rejects.toThrow();

    const [n] = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM professional_advances`,
    );
    expect(Number(n?.n)).toBe(0);
  });

  it('a lista de vales é da loja, e o cancelamento não alcança a vizinha', async () => {
    const daMatriz = await conceberVale({
      tenantId: TENANT,
      locationId: MATRIZ,
      professionalId: RUAN,
      valorCents: 15_000,
      concedidoEm: HOJE,
      de: HOJE,
      ate: HOJE,
      motivo: 'adiantamento',
      pelaGaveta: false,
      staffId: DONO,
      staffName: 'Matheus',
    });

    const naFilial = await valesDoPeriodo({
      tenantId: TENANT,
      locationId: FILIAL,
      de: HOJE,
      ate: HOJE,
    });
    expect(naFilial).toEqual([]);

    const naMatriz = await valesDoPeriodo({
      tenantId: TENANT,
      locationId: MATRIZ,
      de: HOJE,
      ate: HOJE,
    });
    expect(naMatriz).toHaveLength(1);

    await expect(
      cancelarVale({
        tenantId: TENANT,
        locationId: FILIAL,
        valeId: daMatriz.id,
        motivo: 'engano',
        staffId: DONO,
        staffName: 'Matheus',
      }),
    ).rejects.toThrow();
  });

  // -- o estoque --------------------------------------------------------------

  it('a perda de uma loja é validada contra o saldo dela, não o da rede', async () => {
    /**
     * A soma que alimenta a validação era da rede: a filial sem nenhuma unidade
     * de pomada lançava perda de 5 e recebia sucesso, deixando o saldo de lá em
     * −5 enquanto o da rede seguia positivo.
     */
    const produto = await salvarProduto({
      tenantId: TENANT,
      nome: 'Pomada modeladora',
      tipo: 'resale',
      custoCents: 1200,
      precoCents: 3500,
      minimo: 3,
      unidade: 'un',
      ativo: true,
      ator,
    });

    await lancarMovimento({
      tenantId: TENANT,
      produtoId: produto.id,
      tipo: 'entrada',
      quantidade: 20,
      diaDaUnidade: HOJE,
      locationId: MATRIZ,
      ator,
    });

    await expect(
      lancarMovimento({
        tenantId: TENANT,
        produtoId: produto.id,
        tipo: 'perda',
        quantidade: 5,
        diaDaUnidade: HOJE,
        locationId: FILIAL,
        motivo: 'quebrou',
        ator,
      }),
    ).rejects.toThrow();

    // E a tela de cada loja mostra o saldo dela, não o da rede.
    const naFilial = await produtos(TENANT, false, new Date(), FILIAL);
    const naMatriz = await produtos(TENANT, false, new Date(), MATRIZ);
    expect(naFilial.find((p) => p.id === produto.id)?.saldo).toBe(0);
    expect(naMatriz.find((p) => p.id === produto.id)?.saldo).toBe(20);
  });

  it('a margem por serviço é da loja que a tela está mostrando', async () => {
    // É a leitura que decide preço, sob `finance.view_profit`, e ela devolvia
    // byte a byte o mesmo corpo nas duas lojas — a margem da matriz.
    const daFilial = await margemPorServico(TENANT, HOJE, HOJE, FILIAL);
    expect(daFilial).toEqual([]);
  });
});
