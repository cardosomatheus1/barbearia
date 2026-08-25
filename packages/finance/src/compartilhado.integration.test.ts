import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProgramaDeFidelidade } from '@barbearia/core';
import { abrirCaixa } from './caixa.js';
import { abrirComanda, adicionarItem, fecharComanda, receberFiado } from './comanda.js';
import { ajustarSaldo, saldoDoCliente, salvarPrograma } from './fidelidade.js';
import { estornarVenda } from './estorno.js';

/**
 * Fidelidade e fiado entre unidades, contra Postgres real (bloco 59).
 *
 * O que só o banco prova: que trocar o interruptor não faz saldo antigo sumir,
 * que o resgate tira do bolso compartilhado primeiro — e portanto o mesmo ponto
 * não é gasto duas vezes —, e que a dívida por unidade é derivada do extrato e
 * não da coluna acumulada.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '59595959-1111-1111-1111-111111111111';
const MATRIZ = 'a5959595-0000-0000-0000-000000000001';
const FILIAL = 'a5959595-0000-0000-0000-000000000002';
const CARLOS = 'c5959595-0000-0000-0000-000000000001';
const STAFF = 'd5959595-0000-0000-0000-000000000001';
const CORTE = 'f5959595-0000-0000-0000-000000000001';

const HOJE = '2026-11-01';
const AGORA = new Date('2026-11-01T14:00:00Z');
const ator = { id: STAFF, name: 'Matheus' };
const operador = { staffId: STAFF, staffName: 'Matheus' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const ligar = (extra: Partial<ProgramaDeFidelidade> = {}) =>
  salvarPrograma({
    tenantId: TENANT,
    ator,
    programa: {
      modo: 'cashback',
      pontosPorReal: 1,
      valorDoPontoCents: 1,
      visitasParaPremio: 10,
      cashbackBps: 1000,
      validadeDias: null,
      escopo: 'empresa',
      ...extra,
    },
  });

/** Uma venda paga em dinheiro, na loja pedida. Devolve o que ela gerou. */
async function venderEm(locationId: string, precoCents = 10_000): Promise<void> {
  const { id } = await abrirComanda({
    tenantId: TENANT,
    locationId,
    customerId: CARLOS,
    staffId: STAFF,
  });
  await adicionarItem({
    tenantId: TENANT,
    locationId,
    orderId: id,
    tipo: 'service',
    serviceId: CORTE,
    descricao: 'Corte',
    quantidade: 1,
    precoUnitarioCents: precoCents,
    ...operador,
  });
  await fecharComanda({
    tenantId: TENANT,
    locationId,
    orderId: id,
    pagamentos: [{ forma: 'cash', valorCents: precoCents }],
    hojeNaUnidade: HOJE,
    ...operador,
  });
}

describeIfDb('fidelidade e fiado entre unidades', () => {
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
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari');

      INSERT INTO locations (id, tenant_id, name, timezone) VALUES
        ('${MATRIZ}', '${TENANT}', 'Matriz', 'America/Bahia'),
        ('${FILIAL}', '${TENANT}', 'Filial Pituba', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164, credit_limit_cents)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777', 30000);

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CORTE}', '${TENANT}', 'Corte', 10000, 30);
    `);
    await abrirCaixa({
      tenantId: TENANT, locationId: MATRIZ, openingCents: 20000, ...operador,
    });
    await abrirCaixa({
      tenantId: TENANT, locationId: FILIAL, openingCents: 20000, ...operador,
    });
  });

  // -- fidelidade -------------------------------------------------------------

  it('por empresa, o que se ganha numa loja vale na outra', async () => {
    await ligar();
    await venderEm(MATRIZ);

    // 10% de R$ 100 = R$ 10 em cashback, e ele vale nas duas.
    expect((await saldoDoCliente(TENANT, CARLOS, AGORA, MATRIZ)).saldo).toBe(1000);
    expect((await saldoDoCliente(TENANT, CARLOS, AGORA, FILIAL)).saldo).toBe(1000);
  });

  it('por unidade, o que se ganha numa loja não vale na outra', async () => {
    await ligar({ escopo: 'unidade' });
    await venderEm(MATRIZ);

    expect((await saldoDoCliente(TENANT, CARLOS, AGORA, MATRIZ)).saldo).toBe(1000);
    expect((await saldoDoCliente(TENANT, CARLOS, AGORA, FILIAL)).saldo).toBe(0);
  });

  it('o cliente, que não está em loja nenhuma, vê o bolso de cada uma', async () => {
    /**
     * A tela do cliente não tem unidade: ele abre o app em casa, e não há
     * balcão que tenha escolhido a loja por ele. A rota passava `null`, e
     * `null` não casa com bolso nenhum — quem ganhou 340 na Pituba lia **zero**
     * enquanto o balcão oferecia os 340.
     *
     * A resposta certa não é somar tudo num número só: R$ 10 na matriz mais
     * R$ 20 na filial não são R$ 30 em lugar nenhum, e um total faria a pessoa
     * pedir no balcão um resgate que a comanda recusa. A tela mostra os bolsos
     * com o nome da loja.
     */
    await ligar({ escopo: 'unidade' });
    await venderEm(MATRIZ);
    await venderEm(FILIAL);
    await venderEm(FILIAL);

    const meu = await saldoDoCliente(TENANT, CARLOS, AGORA);

    // Nada é compartilhado: tudo nasceu com escopo de unidade.
    expect(meu.saldoCompartilhado).toBe(0);
    // E o número de cima é tudo o que ele tem, não o compartilhado vazio: a
    // tela escrevia "0 pontos" sobre uma lista que dizia 3000.
    expect(meu.saldo).toBe(3000);
    expect(meu.porUnidade.map((l) => [l.unidade, l.saldo])).toEqual([
      ['Filial Pituba', 2000],
      ['Matriz', 1000],
    ]);
  });

  it('bolso único sem compartilhado não vira lista de um item', async () => {
    /**
     * A barbearia de uma loja só com programa por unidade tem um bolso e nada
     * compartilhado: a lista repetiria embaixo o número que já está em cima.
     * É a decisão do seletor de uma opção só — uma lista de um item não é
     * informação, é a tela dizendo duas vezes a mesma coisa.
     */
    await ligar({ escopo: 'unidade' });
    await venderEm(MATRIZ);

    const meu = await saldoDoCliente(TENANT, CARLOS, AGORA);
    expect(meu.saldo).toBe(1000);
    expect(meu.porUnidade).toEqual([]);
  });

  it('sob empresa o cliente não vê lista de loja nenhuma', async () => {
    // O compartilhado já é tudo; uma lista repetiria o mesmo número embaixo
    // dele, e a tela passaria a somar duas vezes aos olhos de quem lê.
    await ligar();
    await venderEm(MATRIZ);

    const meu = await saldoDoCliente(TENANT, CARLOS, AGORA);
    expect(meu.saldo).toBe(1000);
    expect(meu.porUnidade).toEqual([]);
  });

  it('trocar o interruptor não faz o saldo antigo sumir', async () => {
    /**
     * É a razão de o escopo ser congelado em cada lançamento em vez de lido do
     * cadastro na hora do saldo. A barbearia que passa para `unidade` em maio
     * faria os pontos de abril sumirem — eles não têm loja, porque foram ganhos
     * quando loja não importava, e o cliente ouviu no balcão que valiam.
     */
    await ligar();
    await venderEm(MATRIZ);

    await ligar({ escopo: 'unidade' });
    await venderEm(FILIAL);

    // O de abril continua valendo nas duas; o de maio, só na filial.
    expect((await saldoDoCliente(TENANT, CARLOS, AGORA, MATRIZ)).saldo).toBe(1000);
    expect((await saldoDoCliente(TENANT, CARLOS, AGORA, FILIAL)).saldo).toBe(2000);
  });

  it('o extrato diz em qual loja cada linha nasceu', async () => {
    // "Onde eu ganhei isso?" é a pergunta que chega junto de "por que caiu?".
    await ligar({ escopo: 'unidade' });
    await venderEm(FILIAL);

    const extrato = (await saldoDoCliente(TENANT, CARLOS, AGORA, FILIAL)).extrato;
    expect(extrato[0]).toMatchObject({ escopo: 'unidade', unidade: 'Filial Pituba' });
  });

  it('o resgate tira do bolso compartilhado primeiro, e o ponto não é gasto duas vezes', async () => {
    /**
     * Saindo do bolso da loja, o saldo compartilhado seria gasto na matriz — o
     * bolso da matriz iria a negativo — e continuaria inteiro para gastar na
     * filial. Este teste é o que prende a ordem.
     */
    await ligar();
    await venderEm(MATRIZ); // R$ 10 compartilhados
    await ligar({ escopo: 'unidade' });
    await venderEm(MATRIZ); // R$ 10 só da matriz

    expect((await saldoDoCliente(TENANT, CARLOS, AGORA, MATRIZ)).saldo).toBe(2000);
    expect((await saldoDoCliente(TENANT, CARLOS, AGORA, FILIAL)).saldo).toBe(1000);

    // Resgata R$ 10 na matriz: sai do compartilhado, e a filial fica sem nada.
    const { id } = await abrirComanda({
      tenantId: TENANT, locationId: MATRIZ, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: MATRIZ, orderId: id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 1,
      precoUnitarioCents: 10_000, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT,
      locationId: MATRIZ,
      orderId: id,
      resgateQuantidade: 1000,
      pagamentos: [
        { forma: 'fidelidade', valorCents: 1000 },
        { forma: 'cash', valorCents: 9000 },
      ],
      hojeNaUnidade: HOJE,
      ...operador,
    });

    expect((await saldoDoCliente(TENANT, CARLOS, AGORA, FILIAL)).saldo).toBe(0);
  });

  // -- os quatro achados da revisão de segurança -------------------------------

  it('estornar a venda devolve o ponto ao bolso de onde ele saiu', async () => {
    /**
     * Escrito no compartilhado, o estorno de um acúmulo de unidade não acha lote
     * nenhum para consumir — `lotes()` só desconta uma saída contra as entradas
     * que a precedem — e a linha negativa é **descartada em silêncio**. O
     * cliente ficava com os pontos de uma venda devolvida, e comprar-e-estornar
     * virava máquina de fabricar crédito.
     */
    await ligar({ escopo: 'unidade' });

    const { id } = await abrirComanda({
      tenantId: TENANT, locationId: MATRIZ, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: MATRIZ, orderId: id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 1,
      precoUnitarioCents: 10_000, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: MATRIZ, orderId: id,
      pagamentos: [{ forma: 'cash', valorCents: 10_000 }],
      hojeNaUnidade: HOJE, ...operador,
    });
    expect((await saldoDoCliente(TENANT, CARLOS, AGORA, MATRIZ)).saldo).toBe(1000);

    await estornarVenda({
      tenantId: TENANT, locationId: MATRIZ, orderId: id,
      motivo: 'Venda lançada em duplicidade', hoje: HOJE, ...operador,
    });

    expect((await saldoDoCliente(TENANT, CARLOS, AGORA, MATRIZ)).saldo).toBe(0);
  });

  it('tirar e devolver à mão soma zero, e não o dobro', async () => {
    /**
     * A conferência olhava o saldo misturado e a linha ia sempre para o
     * compartilhado: tirar 300 passava e era descartado, devolver 300 criava um
     * lote vivo lá, e o cliente ficava com o dobro. Sem corrida nenhuma — duas
     * operações que somam zero, na ordem em que qualquer balcão as faria.
     */
    await ligar({ escopo: 'unidade' });
    await venderEm(MATRIZ);
    expect((await saldoDoCliente(TENANT, CARLOS, AGORA, MATRIZ)).saldo).toBe(1000);

    const tirar = {
      tenantId: TENANT, customerId: CARLOS, locationId: MATRIZ,
      motivo: 'lançado por engano na comanda errada', ator, agora: AGORA,
    };
    await ajustarSaldo({
        idempotencyKey: 'audit-test-ajustarSaldo-1', ...tirar, quantidade: -1000 });
    expect((await saldoDoCliente(TENANT, CARLOS, AGORA, MATRIZ)).saldo).toBe(0);

    await ajustarSaldo({
        idempotencyKey: 'audit-test-ajustarSaldo-2', ...tirar, quantidade: 1000 });
    expect((await saldoDoCliente(TENANT, CARLOS, AGORA, MATRIZ)).saldo).toBe(1000);
  });

  // -- fiado ------------------------------------------------------------------

  it('por empresa, a dívida é uma só e o limite vale para a rede', async () => {
    const { id } = await abrirComanda({
      tenantId: TENANT, locationId: MATRIZ, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: MATRIZ, orderId: id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 1,
      precoUnitarioCents: 10_000, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: MATRIZ, orderId: id,
      pagamentos: [{ forma: 'fiado', valorCents: 10_000 }],
      hojeNaUnidade: HOJE, ...operador,
    });

    // Limite de R$ 300, dívida de R$ 100: a filial só deixa levar mais R$ 200.
    const segunda = await abrirComanda({
      tenantId: TENANT, locationId: FILIAL, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: FILIAL, orderId: segunda.id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 3,
      precoUnitarioCents: 10_000, ...operador,
    });
    await expect(
      fecharComanda({
        tenantId: TENANT, locationId: FILIAL, orderId: segunda.id,
        pagamentos: [{ forma: 'fiado', valorCents: 30_000 }],
        hojeNaUnidade: HOJE, ...operador,
      }),
    ).rejects.toMatchObject({ code: 'pagamento_invalido' });
  });

  it('por unidade, cada loja conta a sua dívida contra o mesmo limite', async () => {
    /**
     * O limite não é repartido: "pode levar R$ 300 sem pagar" é uma frase sobre
     * a pessoa, e dividi-la entre as lojas faria abrir a segunda loja cortar
     * pela metade o crédito de todo mundo sem ninguém ter decidido nada.
     */
    await exec(`UPDATE tenants SET credit_scope = 'unidade' WHERE id = '${TENANT}'`);

    const { id } = await abrirComanda({
      tenantId: TENANT, locationId: MATRIZ, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: MATRIZ, orderId: id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 3,
      precoUnitarioCents: 10_000, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: MATRIZ, orderId: id,
      pagamentos: [{ forma: 'fiado', valorCents: 30_000 }],
      hojeNaUnidade: HOJE, ...operador,
    });

    // A matriz está no teto. A filial ainda deixa, porque a dívida é de lá.
    const naFilial = await abrirComanda({
      tenantId: TENANT, locationId: FILIAL, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: FILIAL, orderId: naFilial.id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 1,
      precoUnitarioCents: 10_000, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: FILIAL, orderId: naFilial.id,
      pagamentos: [{ forma: 'fiado', valorCents: 10_000 }],
      hojeNaUnidade: HOJE, ...operador,
    });

    // E a matriz continua barrando.
    const deNovo = await abrirComanda({
      tenantId: TENANT, locationId: MATRIZ, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: MATRIZ, orderId: deNovo.id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 1,
      precoUnitarioCents: 10_000, ...operador,
    });
    await expect(
      fecharComanda({
        tenantId: TENANT, locationId: MATRIZ, orderId: deNovo.id,
        pagamentos: [{ forma: 'fiado', valorCents: 10_000 }],
        hojeNaUnidade: HOJE, ...operador,
      }),
    ).rejects.toMatchObject({ code: 'pagamento_invalido' });
  });

  it('pagar numa loja quita a dívida da outra, e não vira crédito lá', async () => {
    /**
     * Pagar no balcão de outra loja é normal: o cliente devia na matriz e passou
     * na filial. Carimbando a linha com a loja do balcão, o bolso da filial
     * ficava **positivo** e o limite lá passava a valer duas vezes — repetindo
     * pegar-e-pagar, o crédito na filial não tinha teto.
     */
    await exec(`UPDATE tenants SET credit_scope = 'unidade' WHERE id = '${TENANT}'`);

    const { id } = await abrirComanda({
      tenantId: TENANT, locationId: MATRIZ, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: MATRIZ, orderId: id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 3,
      precoUnitarioCents: 10_000, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: MATRIZ, orderId: id,
      pagamentos: [{ forma: 'fiado', valorCents: 30_000 }],
      hojeNaUnidade: HOJE, ...operador,
    });

    // Paga tudo na filial.
    await receberFiado({
        idempotencyKey: 'audit-test-receberFiado-1',
      tenantId: TENANT, locationId: FILIAL, customerId: CARLOS,
      amountCents: 30_000, forma: 'cash', ...operador,
    });

    // A quitação foi da matriz: a filial não ficou com crédito nenhum.
    const porLoja = await admin.$queryRawUnsafe<{ location_id: string | null; total: bigint }[]>(
      `SELECT location_id, sum(amount_cents) AS total FROM customer_ledger
        WHERE customer_id = $1::uuid GROUP BY location_id`,
      CARLOS,
    );
    expect(porLoja).toHaveLength(1);
    expect(porLoja[0]?.location_id).toBe(MATRIZ);
    expect(Number(porLoja[0]?.total)).toBe(0);

    // E a filial não empresta contra crédito que não existe.
    const naFilial = await abrirComanda({
      tenantId: TENANT, locationId: FILIAL, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: FILIAL, orderId: naFilial.id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 4,
      precoUnitarioCents: 10_000, ...operador,
    });
    await expect(
      fecharComanda({
        tenantId: TENANT, locationId: FILIAL, orderId: naFilial.id,
        pagamentos: [{ forma: 'fiado', valorCents: 40_000 }],
        hojeNaUnidade: HOJE, ...operador,
      }),
    ).rejects.toMatchObject({ code: 'pagamento_invalido' });
  });

  it('o extrato do fiado guarda em qual loja a dívida nasceu', async () => {
    // A coluna precisa estar preenchida em todos os caminhos: um preenchido e
    // outro não faz o saldo por loja mentir com número.
    const { id } = await abrirComanda({
      tenantId: TENANT, locationId: FILIAL, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: FILIAL, orderId: id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 1,
      precoUnitarioCents: 10_000, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: FILIAL, orderId: id,
      pagamentos: [{ forma: 'fiado', valorCents: 10_000 }],
      hojeNaUnidade: HOJE, ...operador,
    });

    const linhas = await admin.$queryRawUnsafe<{ location_id: string | null }[]>(
      `SELECT location_id FROM customer_ledger WHERE customer_id = $1::uuid`,
      CARLOS,
    );
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.location_id).toBe(FILIAL);
  });
});
