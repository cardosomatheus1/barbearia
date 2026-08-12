import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { assinar } from './assinatura.js';
import { lancarMovimento, produtos, salvarProduto } from './estoque.js';
import { dreDoPeriodo } from './dre.js';
import {
  MultiunidadeError,
  saldosPorUnidade,
  transferenciasDaCasa,
  transferirEstoque,
} from './multiunidade.js';

/**
 * Transferência de estoque entre unidades, contra Postgres real (bloco 58).
 *
 * O que só o banco prova: que o saldo conferido é o **da loja de origem** e não
 * o da rede, que a transferência produz os dois movimentos na mesma transação,
 * que a linha não se apaga, e que id de outra barbearia é recusado apesar de a
 * chave estrangeira aceitá-lo — ela ignora row security.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '58585858-1111-1111-1111-111111111111';
const RIVAL = '58585858-2222-2222-2222-222222222222';
const MATRIZ = 'a5858585-0000-0000-0000-000000000001';
const FILIAL = 'a5858585-0000-0000-0000-000000000002';
const FECHADA = 'a5858585-0000-0000-0000-000000000003';
const DELES = 'a5858585-0000-0000-0000-000000000009';
const DONO = 'd5858585-0000-0000-0000-000000000001';

const HOJE = '2026-11-01';
const ator = { id: DONO, name: 'Matheus' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const novoProduto = () =>
  salvarProduto({
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

const abastecer = (produtoId: string, locationId: string, quantidade: number) =>
  lancarMovimento({
    tenantId: TENANT,
    produtoId,
    tipo: 'entrada',
    quantidade,
    diaDaUnidade: HOJE,
    locationId,
    ator,
  });

const saldoEm = async (produtoId: string, unidadeId: string) =>
  (await saldosPorUnidade(TENANT)).find(
    (s) => s.produtoId === produtoId && s.unidadeId === unidadeId,
  )?.saldo ?? 0;

describeIfDb('transferência de estoque entre unidades', () => {
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

      INSERT INTO locations (id, tenant_id, name, timezone, active) VALUES
        ('${MATRIZ}', '${TENANT}', 'Matriz', 'America/Bahia', true),
        ('${FILIAL}', '${TENANT}', 'Filial Pituba', 'America/Bahia', true),
        ('${FECHADA}', '${TENANT}', 'Loja da Barra', 'America/Bahia', false),
        ('${DELES}', '${RIVAL}', 'Deles', 'America/Bahia', true);

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');
    `);
  });

  it('o produto sai de uma loja e entra na outra na mesma transação', async () => {
    const { id } = await novoProduto();
    await abastecer(id, MATRIZ, 20);

    await transferirEstoque({
      tenantId: TENANT,
      produtoId: id,
      origemId: MATRIZ,
      destinoId: FILIAL,
      quantidade: 8,
      diaDaUnidade: HOJE,
      autorizadas: [],
      ator,
    });

    expect(await saldoEm(id, MATRIZ)).toBe(12);
    expect(await saldoEm(id, FILIAL)).toBe(8);
    // A rede continua com as mesmas vinte: transferir não cria nem destrói.
    expect((await produtos(TENANT, true)).find((p) => p.id === id)?.saldo).toBe(20);
  });

  it('o saldo conferido é o da loja de origem, não o da rede', async () => {
    /**
     * É a regra que separa este bloco de um `UPDATE` ingênuo. Com o saldo
     * global, a matriz transferiria dez unidades que estão na filial — e o
     * relatório de nenhuma das duas fecharia com a prateleira.
     */
    const { id } = await novoProduto();
    await abastecer(id, FILIAL, 30);

    await expect(
      transferirEstoque({
        tenantId: TENANT,
        produtoId: id,
        origemId: MATRIZ,
        destinoId: FILIAL,
        quantidade: 1,
        diaDaUnidade: HOJE,
        autorizadas: [],
        ator,
      }),
    ).rejects.toMatchObject({ code: 'saldo_insuficiente' });
  });

  it('loja fechada não recebe nem manda estoque', async () => {
    const { id } = await novoProduto();
    await abastecer(id, MATRIZ, 20);

    await expect(
      transferirEstoque({
        tenantId: TENANT,
        produtoId: id,
        origemId: MATRIZ,
        destinoId: FECHADA,
        quantidade: 2,
        diaDaUnidade: HOJE,
        autorizadas: [],
        ator,
      }),
    ).rejects.toMatchObject({ code: 'unidade_fechada' });
  });

  it('a unidade da barbearia vizinha é recusada, apesar de a chave estrangeira aceitá-la', async () => {
    /**
     * A checagem de integridade referencial do Postgres **ignora row security**:
     * o `REFERENCES locations(id)` aceitaria a loja da vizinha sem reclamar. Quem
     * recusa é a leitura sob RLS, que não encontra a linha.
     */
    const { id } = await novoProduto();
    await abastecer(id, MATRIZ, 20);

    await expect(
      transferirEstoque({
        tenantId: TENANT,
        produtoId: id,
        origemId: MATRIZ,
        destinoId: DELES,
        quantidade: 2,
        diaDaUnidade: HOJE,
        autorizadas: [],
        ator,
      }),
    ).rejects.toMatchObject({ code: 'unidade_nao_encontrada' });

    expect(await saldoEm(id, MATRIZ)).toBe(20);
  });

  it('da loja para ela mesma não é transferência', async () => {
    const { id } = await novoProduto();
    await abastecer(id, MATRIZ, 20);

    await expect(
      transferirEstoque({
        tenantId: TENANT,
        produtoId: id,
        origemId: MATRIZ,
        destinoId: MATRIZ,
        quantidade: 2,
        diaDaUnidade: HOJE,
        autorizadas: [],
        ator,
      }),
    ).rejects.toBeInstanceOf(MultiunidadeError);
  });

  it('o custo viaja congelado: a margem das duas lojas não muda por transferir', async () => {
    /**
     * Sem isso, o produto sairia pelo custo de lá e entraria pelo de hoje: a
     * loja de origem ganharia margem e a de destino perderia, sem ninguém ter
     * comprado nada.
     */
    const { id } = await novoProduto();
    await abastecer(id, MATRIZ, 20);
    await transferirEstoque({
      tenantId: TENANT,
      produtoId: id,
      origemId: MATRIZ,
      destinoId: FILIAL,
      quantidade: 5,
      diaDaUnidade: HOJE,
      autorizadas: [],
      ator,
    });

    const custos = await withTenant(TENANT, async (tx) =>
      tx.$queryRaw<{ unit_cost_cents: number }[]>`
        SELECT unit_cost_cents FROM stock_movements WHERE kind = 'transferencia'
      `,
    );
    expect(custos).toHaveLength(2);
    expect(custos.every((c) => c.unit_cost_cents === 1200)).toBe(true);
  });

  it('a transferência não se apaga', async () => {
    const { id } = await novoProduto();
    await abastecer(id, MATRIZ, 20);
    const { id: transferencia } = await transferirEstoque({
      tenantId: TENANT,
      produtoId: id,
      origemId: MATRIZ,
      destinoId: FILIAL,
      quantidade: 5,
      diaDaUnidade: HOJE,
      autorizadas: [],
      ator,
    });

    await expect(
      withTenant(TENANT, async (tx) =>
        tx.$executeRaw`DELETE FROM stock_transfers WHERE id = ${transferencia}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('a lista mostra de onde para onde, com quem mandou', async () => {
    const { id } = await novoProduto();
    await abastecer(id, MATRIZ, 20);
    await transferirEstoque({
      tenantId: TENANT,
      produtoId: id,
      origemId: MATRIZ,
      destinoId: FILIAL,
      quantidade: 5,
      nota: 'reposição de sexta',
      diaDaUnidade: HOJE,
      autorizadas: [],
      ator,
    });

    const lista = await transferenciasDaCasa(TENANT);
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      produto: 'Pomada modeladora',
      deNome: 'Matriz',
      paraNome: 'Filial Pituba',
      quantidade: 5,
      quem: 'Matheus',
      nota: 'reposição de sexta',
    });
  });

  it('quem administra só a filial não tira estoque da matriz', async () => {
    /**
     * Achado da `/security-review` do bloco 58, e o caminho é concreto: o id da
     * unidade mais antiga sai na **página pública**, então o gerente escopado
     * não precisa adivinhar nada — basta mandá-lo no corpo. O seletor recusava
     * a matriz corretamente; o `POST` a aceitava.
     *
     * A recusa usa a mesma mensagem de unidade inexistente, para não confirmar
     * o id a quem o tem.
     */
    const { id } = await novoProduto();
    await abastecer(id, MATRIZ, 20);

    await expect(
      transferirEstoque({
        tenantId: TENANT,
        produtoId: id,
        origemId: MATRIZ,
        destinoId: FILIAL,
        quantidade: 20,
        diaDaUnidade: HOJE,
        autorizadas: [FILIAL],
        ator,
      }),
    ).rejects.toMatchObject({ code: 'unidade_nao_encontrada' });

    expect(await saldoEm(id, MATRIZ)).toBe(20);
    expect(await saldoEm(id, FILIAL)).toBe(0);
  });

  it('o histórico e o saldo por loja param nas unidades que a pessoa administra', async () => {
    const { id } = await novoProduto();
    await abastecer(id, MATRIZ, 20);
    await transferirEstoque({
      tenantId: TENANT,
      produtoId: id,
      origemId: MATRIZ,
      destinoId: FILIAL,
      quantidade: 5,
      diaDaUnidade: HOJE,
      autorizadas: [],
      ator,
    });

    // A transferência tocou a filial, então ela aparece para quem a administra.
    expect(await transferenciasDaCasa(TENANT, [FILIAL])).toHaveLength(1);
    // O saldo da matriz, não.
    const saldos = await saldosPorUnidade(TENANT, [FILIAL]);
    expect(saldos.map((s) => s.unidadeId)).toEqual([FILIAL]);
  });

  it('a barbearia vizinha não vê a transferência da outra', async () => {
    const { id } = await novoProduto();
    await abastecer(id, MATRIZ, 20);
    await transferirEstoque({
      tenantId: TENANT,
      produtoId: id,
      origemId: MATRIZ,
      destinoId: FILIAL,
      quantidade: 5,
      diaDaUnidade: HOJE,
      autorizadas: [],
      ator,
    });

    expect(await transferenciasDaCasa(RIVAL)).toHaveLength(0);
    expect(await saldosPorUnidade(RIVAL)).toHaveLength(0);
  });

  // -- a mensalidade do clube ganha unidade (lacuna do DRE, fechada aqui) ------

  it('a mensalidade do clube entra no DRE da loja onde a pessoa assinou', async () => {
    /**
     * Era a lacuna declarada do DRE por unidade, e o motivo escrito era honesto:
     * `club_invoices` não tinha loja, então numa rede a mensalidade aparecia
     * inteira no relatório das duas. A unidade é gravada **na adesão** e
     * congelada — recalculá-la faria o DRE de março mudar quando o cliente
     * trocasse de loja em maio.
     */
    const CLIENTE = 'c5858585-0000-0000-0000-000000000001';
    const PLANO = 'b5858585-0000-0000-0000-000000000001';
    await exec(`
      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CLIENTE}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO club_plans (id, tenant_id, name, price_cents)
      VALUES ('${PLANO}', '${TENANT}', 'Clube Barba', 9900);
    `);

    const assinatura = await assinar({
      tenantId: TENANT, customerId: CLIENTE, planId: PLANO, locationId: FILIAL, ator,
    });

    await exec(`
      INSERT INTO club_invoices (tenant_id, subscription_id, period_start, period_end,
                                 due_at, amount_cents, status, paid_at)
      VALUES ('${TENANT}', '${assinatura.id}', '${HOJE}T00:00:00Z', '2026-12-01T00:00:00Z',
              '${HOJE}T00:00:00Z', 9900, 'paga', '${HOJE}T14:00:00Z');
    `);

    const daFilial = await dreDoPeriodo({
      tenantId: TENANT, locationId: FILIAL, de: '2026-11-01', ate: '2026-11-30',
    });
    const daMatriz = await dreDoPeriodo({
      tenantId: TENANT, locationId: MATRIZ, de: '2026-11-01', ate: '2026-11-30',
    });

    expect(daFilial.atual.receitaAssinaturasCents).toBe(9900);
    expect(daMatriz.atual.receitaAssinaturasCents).toBe(0);
  });

  it('a trilha registra a transferência dentro da transação que a criou', async () => {
    const { id } = await novoProduto();
    await abastecer(id, MATRIZ, 20);
    await transferirEstoque({
      tenantId: TENANT,
      produtoId: id,
      origemId: MATRIZ,
      destinoId: FILIAL,
      quantidade: 5,
      diaDaUnidade: HOJE,
      autorizadas: [],
      ator,
    });

    const trilha = await withTenant(TENANT, async (tx) =>
      tx.$queryRaw<{ action: string }[]>`
        SELECT action FROM audit_log WHERE action = 'stock.transferred'
      `,
    );
    expect(trilha).toHaveLength(1);
  });
});
