import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProgramaDeFidelidade } from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import { abrirCaixa } from './caixa.js';
import { abrirComanda, adicionarItem, fecharComanda } from './comanda.js';
import {
  FidelidadeError,
  ajustarSaldo,
  conferirResgate,
  expirarSaldos,
  saldoDoCliente,
  salvarPrograma,
} from './fidelidade.js';

/**
 * A fidelidade contra Postgres real (bloco 41, SPEC §4.8).
 *
 * O que só o banco prova: que o saldo entra e sai **na mesma transação** que
 * fecha a venda, que o extrato é append-only, que a reentrada do fechamento não
 * dobra saldo — e que o corte grátis não gera o crédito do próximo corte grátis.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '41414141-1111-1111-1111-111111111111';
const RIVAL = '41414141-2222-2222-2222-222222222222';
const LOCATION = 'a1414141-0000-0000-0000-000000000001';
const RUAN = 'b1414141-0000-0000-0000-000000000001';
const CABELO = 'e1414141-0000-0000-0000-000000000001';
const CARLOS = 'c1414141-0000-0000-0000-000000000001';
const STAFF = 'f1414141-0000-0000-0000-000000000001';

const HOJE = '2026-10-01';
const AGORA = new Date('2026-10-01T12:00:00Z');
const operador = { staffId: STAFF, staffName: 'Maria Recepção' };
const ator = { id: STAFF, name: 'Maria Recepção' };
const fecha = { ...operador, hojeNaUnidade: HOJE };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('fidelidade', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE staff_directory CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Vizinha');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', 'Cabelo', 5000, 30);

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Maria', 'maria@domari.com.br', 'x', 'receptionist');
    `);
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 20000, ...operador });
  });

  /**
   * `Partial<ProgramaDeFidelidade>` e não `Record<string, unknown>` com `as
   * never`.
   *
   * O `as never` desligava o compilador, e foi assim que `escopo` — campo novo e
   * obrigatório do bloco 59 — chegou ao banco como nulo: a coluna tem
   * `DEFAULT 'empresa'`, mas um `NULL` explícito passa por cima do padrão. O
   * tipo é a guarda de que um campo novo aparece aqui em vez de virar erro de
   * `NOT NULL` em dezenove testes.
   */
  const ligar = (extra: Partial<ProgramaDeFidelidade> = {}) =>
    salvarPrograma({
      tenantId: TENANT,
      ator,
      programa: {
        modo: 'pontos',
        pontosPorReal: 1,
        valorDoPontoCents: 1,
        visitasParaPremio: 10,
        cashbackBps: 500,
        validadeDias: null,
        escopo: 'empresa',
        ...extra,
      },
    });

  /** Uma comanda com um corte, pronta para fechar. */
  async function comanda(precoCents = 5000, comCliente = true): Promise<string> {
    const aberta = await abrirComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      ...(comCliente ? { customerId: CARLOS } : {}),
      staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      tipo: 'service',
      serviceId: CABELO,
      descricao: 'Corte',
      quantidade: 1,
      precoUnitarioCents: precoCents,
      professionalId: RUAN,
      ...operador,
    });
    return aberta.id;
  }

  const saldo = () => saldoDoCliente(TENANT, CARLOS, AGORA);

  // -- o programa --------------------------------------------------------------

  it('barbearia nova nasce sem programa, e isso não é erro', async () => {
    expect((await saldo()).modo).toBe('nenhum');
  });

  it('trocar de modelo é um UPDATE, nunca uma segunda linha', async () => {
    // A chave primária no tenant é o que torna "um modelo por barbearia" um
    // fato do schema, e não uma regra que alguém precisa lembrar de aplicar.
    await ligar({ modo: 'pontos' });
    await ligar({ modo: 'cashback' });

    const linhas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ mode: string }[]>`SELECT mode::text AS mode FROM loyalty_programs`,
    );
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.mode).toBe('cashback');
  });

  // -- o acúmulo ---------------------------------------------------------------

  it('a venda credita pontos na mesma transação que a fecha', async () => {
    await ligar({ modo: 'pontos', pontosPorReal: 1 });
    const id = await comanda(5000);

    await fecharComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: id,
      pagamentos: [{ forma: 'cash', valorCents: 5000 }],
      ...fecha,
    });

    expect(await saldo()).toMatchObject({ modo: 'pontos', saldo: 50 });
  });

  it('cashback devolve os cinco por cento em centavos', async () => {
    await ligar({ modo: 'cashback', cashbackBps: 500 });
    const id = await comanda(5000);
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: id,
      pagamentos: [{ forma: 'cash', valorCents: 5000 }], ...fecha,
    });

    expect((await saldo()).saldo).toBe(250);
  });

  it('visitas conta uma por venda, e diz quanto falta para o prêmio', async () => {
    await ligar({ modo: 'visitas', visitasParaPremio: 10 });
    const id = await comanda(5000);
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: id,
      pagamentos: [{ forma: 'cash', valorCents: 5000 }], ...fecha,
    });

    expect(await saldo()).toMatchObject({ saldo: 1, faltaParaPremio: 9 });
  });

  it('venda sem cliente identificado não credita ninguém', async () => {
    // Não é erro: a venda avulsa de produto acontece o dia inteiro.
    await ligar({ modo: 'pontos' });
    const id = await comanda(5000, false);
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: id,
      pagamentos: [{ forma: 'cash', valorCents: 5000 }], ...fecha,
    });

    const linhas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM loyalty_entries`,
    );
    expect(Number(linhas[0]?.n)).toBe(0);
  });

  it('sem programa ligado, nenhuma venda credita nada', async () => {
    const id = await comanda(5000);
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: id,
      pagamentos: [{ forma: 'cash', valorCents: 5000 }], ...fecha,
    });
    expect((await saldo()).saldo).toBe(0);
  });

  it('a gorjeta não gera fidelidade', async () => {
    /**
     * Ela é do barbeiro. Premiar o cliente por ela seria a barbearia pagando
     * fidelidade com dinheiro que não é dela.
     */
    await ligar({ modo: 'pontos', pontosPorReal: 1 });
    const id = await comanda(5000);
    await withTenant(TENANT, (tx) =>
      tx.$executeRaw`UPDATE orders SET tip_cents = 1000 WHERE id = ${id}::uuid`,
    );

    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: id,
      pagamentos: [{ forma: 'cash', valorCents: 6000 }], ...fecha,
    });

    // 50 pontos pelos R$ 50 do corte, e nenhum pelos R$ 10 de gorjeta.
    expect((await saldo()).saldo).toBe(50);
  });

  // -- o resgate ---------------------------------------------------------------

  async function comSaldo(quantidade: number): Promise<void> {
    await ajustarSaldo({
      tenantId: TENANT,
      customerId: CARLOS,
      quantidade,
      motivo: 'saldo inicial para o teste',
      ator,
      agora: AGORA,
    });
  }

  it('o resgate sai do saldo na mesma transação que fecha a comanda', async () => {
    /**
     * Fora dela, a comanda fecharia com o crédito aplicado e o saldo continuaria
     * intacto — crédito infinito, gasto uma vez por comanda. É o defeito com o
     * pior desfecho possível deste bloco.
     */
    await ligar({ modo: 'cashback' });
    await comSaldo(1000);

    const id = await comanda(5000);
    await fecharComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: id,
      pagamentos: [
        { forma: 'fidelidade', valorCents: 1000 },
        { forma: 'cash', valorCents: 4000 },
      ],
      resgateQuantidade: 1000,
      ...fecha,
    });

    // Gastou os mil e ganhou 5% sobre os R$ 40 que pagou de verdade.
    expect((await saldo()).saldo).toBe(200);
  });

  it('resgatar sem saldo é recusado antes de a comanda fechar', async () => {
    await ligar({ modo: 'cashback' });
    const id = await comanda(5000);

    await expect(
      fecharComanda({
        tenantId: TENANT,
        locationId: LOCATION,
        orderId: id,
        pagamentos: [
          { forma: 'fidelidade', valorCents: 1000 },
          { forma: 'cash', valorCents: 4000 },
        ],
        resgateQuantidade: 1000,
        ...fecha,
      }),
    ).rejects.toBeInstanceOf(FidelidadeError);

    // E a comanda continua aberta: nada foi cobrado.
    const linhas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM orders WHERE id = ${id}::uuid
      `,
    );
    expect(linhas[0]?.status).toBe('open');
  });

  it('o valor do resgate é reconferido sob a trava, não aceito da tela', async () => {
    // Entre a montagem do pagamento e o fechamento pode ter entrado outro
    // resgate do mesmo saldo. Aceitar o número da tela seria aceitar o saldo de
    // dois minutos atrás.
    await ligar({ modo: 'cashback' });
    await comSaldo(1000);
    const id = await comanda(5000);

    await expect(
      fecharComanda({
        tenantId: TENANT,
        locationId: LOCATION,
        orderId: id,
        // Diz que resgatou R$ 30 e manda só 10 de quantidade.
        pagamentos: [
          { forma: 'fidelidade', valorCents: 3000 },
          { forma: 'cash', valorCents: 2000 },
        ],
        resgateQuantidade: 1000,
        ...fecha,
      }),
    ).rejects.toThrow();
  });

  it('resgate sem cliente identificado é recusado', async () => {
    await ligar({ modo: 'cashback' });
    const id = await comanda(5000, false);

    await expect(
      fecharComanda({
        tenantId: TENANT,
        locationId: LOCATION,
        orderId: id,
        pagamentos: [
          { forma: 'fidelidade', valorCents: 1000 },
          { forma: 'cash', valorCents: 4000 },
        ],
        resgateQuantidade: 1000,
        ...fecha,
      }),
    ).rejects.toThrow();
  });

  it('o corte grátis não gera o crédito do próximo corte grátis', async () => {
    // O laço que a SPEC §4.8 nomeia em uma linha.
    await ligar({ modo: 'visitas', visitasParaPremio: 10 });
    await comSaldo(10);

    const id = await comanda(5000);
    await fecharComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: id,
      pagamentos: [{ forma: 'fidelidade', valorCents: 5000 }],
      resgateQuantidade: 10,
      ...fecha,
    });

    // Dez visitas saíram e nenhuma entrou: a conta inteira foi o prêmio.
    expect((await saldo()).saldo).toBe(0);
  });

  it('conferirResgate recusa meio prêmio no modo visitas', async () => {
    await ligar({ modo: 'visitas', visitasParaPremio: 10 });
    await comSaldo(12);

    await expect(
      conferirResgate({
        tenantId: TENANT, customerId: CARLOS, quantidade: 5, tetoCents: 5000, tetoDeUmServicoCents: 5000, agora: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'premio_incompleto' });
  });

  // -- o extrato ---------------------------------------------------------------

  it('o extrato é append-only: a aplicação não reescreve lançamento', async () => {
    /**
     * "Meus pontos sumiram" é a pergunta, e o extrato é a resposta. Resposta que
     * pode ser reescrita não responde nada — mesma decisão de `customer_ledger`
     * e da trilha.
     */
    await ligar({ modo: 'pontos' });
    await comSaldo(100);

    await expect(
      withTenant(TENANT, (tx) => tx.$executeRaw`UPDATE loyalty_entries SET amount = 9999`),
    ).rejects.toThrow();
    await expect(
      withTenant(TENANT, (tx) => tx.$executeRaw`DELETE FROM loyalty_entries`),
    ).rejects.toThrow();
  });

  it('ajuste sem motivo escrito é recusado', async () => {
    // Um ajuste sem explicação é indefensável na primeira vez que o dono
    // perguntar — e ele cria valor gastável no balcão.
    await ligar({ modo: 'pontos' });
    await expect(
      ajustarSaldo({ tenantId: TENANT, customerId: CARLOS, quantidade: 100, motivo: 'oi', ator }),
    ).rejects.toMatchObject({ code: 'motivo_curto' });
  });

  it('ajuste negativo não deixa o saldo abaixo de zero', async () => {
    // Saldo negativo é uma dívida que este produto não sabe cobrar — fiado tem
    // tabela própria.
    await ligar({ modo: 'pontos' });
    await comSaldo(50);
    await expect(
      ajustarSaldo({
        tenantId: TENANT, customerId: CARLOS, quantidade: -100,
        motivo: 'correcao de lancamento duplicado', ator, agora: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'saldo_insuficiente' });
  });

  it('o ajuste manual entra na trilha de dinheiro', async () => {
    await ligar({ modo: 'pontos' });
    await comSaldo(100);

    const trilha = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ action: string }[]>`SELECT action FROM audit_log`,
    );
    expect(trilha.map((t) => t.action)).toContain('loyalty.adjusted');
  });

  // -- a validade --------------------------------------------------------------

  it('o saldo vencido some da leitura antes de a varredura rodar', async () => {
    await ligar({ modo: 'pontos', validadeDias: 30 });
    await comSaldo(100);

    const depois = new Date(AGORA.getTime() + 31 * 86_400_000);
    expect((await saldoDoCliente(TENANT, CARLOS, depois)).saldo).toBe(0);
  });

  it('a varredura grava a expiração, e não a grava duas vezes', async () => {
    /**
     * Sem descontar o que já foi gravado, a varredura diária enterraria o
     * extrato em linhas de expiração e o saldo iria a menos-mil.
     */
    await ligar({ modo: 'pontos', validadeDias: 30 });
    await comSaldo(100);

    const depois = new Date(AGORA.getTime() + 31 * 86_400_000);
    expect(await expirarSaldos(TENANT, depois)).toBe(1);
    expect(await expirarSaldos(TENANT, depois)).toBe(0);

    const extrato = (await saldoDoCliente(TENANT, CARLOS, depois)).extrato;
    expect(extrato.filter((l) => l.tipo === 'expiracao')).toHaveLength(1);
  });

  // -- o isolamento ------------------------------------------------------------

  it('a barbearia vizinha não enxerga o saldo desta', async () => {
    await ligar({ modo: 'pontos' });
    await comSaldo(100);
    expect((await saldoDoCliente(RIVAL, CARLOS, AGORA)).saldo).toBe(0);
  });
});
