import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakePaymentProvider } from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import { abrirCaixa } from './caixa.js';
import { abrirComanda, adicionarItem } from './comanda.js';
import { confirmarCobranca, criarCobrancaDaComanda } from './cobranca-online.js';
import { salvarRegraDeComissao } from './comissao.js';
import { repassesDoPeriodo, splitDaVenda } from './split.js';

/**
 * Split de pagamento contra Postgres real (bloco 49, SPEC §3.5).
 *
 * O que só o banco prova: que a derivação é idempotente sob a reentrega do
 * webhook, que a soma das partes é o pagamento ao centavo, que o split não
 * derruba a transação do Pix quando não fecha, e que ele nasce **desligado**.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '49494949-1111-1111-1111-111111111111';
const LOCATION = '49494949-aaaa-0000-0000-000000000001';
const RUAN = '49494949-bbbb-0000-0000-000000000001';
const BRUNO = '49494949-bbbb-0000-0000-000000000002';
const CORTE = '49494949-eeee-0000-0000-000000000001';
const BARBA = '49494949-eeee-0000-0000-000000000002';
const CARLOS = '49494949-cccc-0000-0000-000000000001';
const STAFF = '49494949-ffff-0000-0000-000000000001';

const HOJE = '2026-09-10';
const AGORA = new Date('2026-09-10T12:00:00Z');
const operador = { staffId: STAFF, staffName: 'Maria Recepção' };
const periodo = { tenantId: TENANT, de: '2026-09-01', ate: '2026-09-30' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('split de pagamento', () => {
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

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Maria', 'maria@domari.com.br', 'x', 'owner');

      INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
        ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan'),
        ('${BRUNO}', '${TENANT}', '${LOCATION}', 'Bruno');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes) VALUES
        ('${CORTE}', '${TENANT}', 'Corte', 6000, 30),
        ('${BARBA}', '${TENANT}', 'Barba', 4000, 25);
    `);

    await abrirCaixa({
      tenantId: TENANT, locationId: LOCATION, openingCents: 10_000, ...operador,
    });
    // 40% em tudo, que é a alíquota do exemplo da SPEC §3.5.
    await salvarRegraDeComissao({ tenantId: TENANT, modo: 'percent', valor: 4000, ...operador });
  });

  /**
   * Ligar o split é da barbearia; a alíquota é da plataforma.
   *
   * Por isso são duas tabelas: `tenants.split_enabled` e
   * `tenant_platform.platform_fee_bps`. A separação é achado da revisão deste
   * bloco — com as duas em `tenants`, a rota do painel deixava o cliente
   * definir o preço que paga.
   */
  const ligarSplit = async (bps = 500) => {
    await exec(`
      UPDATE tenants SET split_enabled = true WHERE id = '${TENANT}';

      INSERT INTO tenant_platform (tenant_id, name, platform_fee_bps)
      VALUES ('${TENANT}', 'Domari', ${bps})
      ON CONFLICT (tenant_id) DO UPDATE SET platform_fee_bps = ${bps};
    `);
  };

  /** Uma comanda de R$ 100 com um corte do Ruan. */
  async function comandaDe100(): Promise<string> {
    const comanda = await abrirComanda({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: comanda.id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 1,
      precoUnitarioCents: 10_000, professionalId: RUAN, ...operador,
    });
    return comanda.id;
  }

  async function pagarPeloPix(orderId: string, evento = 'ev-1'): Promise<void> {
    const provider = new FakePaymentProvider();
    const cobranca = await criarCobrancaDaComanda({
      tenantId: TENANT, locationId: LOCATION, orderId, meio: 'pix',
      idempotencyKey: `toque-${orderId}`, provider, agora: AGORA, ...operador,
    });
    if (!cobranca.pagamentoId) throw new Error('cobrança sem id no adquirente');
    await confirmarCobranca({
      tenantId: TENANT,
      eventoId: evento,
      tipo: 'payment_intent.succeeded',
      pagamentoId: cobranca.pagamentoId,
      estado: 'pago',
      hojeNaUnidade: HOJE,
    });
  }

  const valorDe = (fatias: readonly { parte: string; valorCents: number }[], parte: string) =>
    fatias.filter((f) => f.parte === parte).reduce((s, f) => s + f.valorCents, 0);

  it('o split nasce desligado, e a venda paga não gera repasse nenhum', async () => {
    /**
     * *"Arquitetura preparada desde o início, mesmo que ativada só no Release
     * 3."* Ligado por omissão, toda barbearia já instalada veria a próxima venda
     * ser repartida sem ninguém ter decidido nada.
     */
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    expect(await splitDaVenda(TENANT, orderId)).toBeNull();
  });

  it('ligado, o exemplo da SPEC acontece de verdade', async () => {
    // R$ 100 → R$ 55 casa, R$ 40 profissional, R$ 5 plataforma.
    await ligarSplit(500);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const split = await splitDaVenda(TENANT, orderId);
    expect(split?.pagamentoCents).toBe(10_000);
    expect(valorDe(split?.fatias ?? [], 'barbearia')).toBe(5500);
    expect(valorDe(split?.fatias ?? [], 'profissional')).toBe(4000);
    expect(valorDe(split?.fatias ?? [], 'plataforma')).toBe(500);
  });

  it('a soma das partes é o pagamento, e a parte da casa já nasce liquidada', async () => {
    /**
     * A conta da casa **é** para onde o adquirente manda por padrão: não existe
     * transferência a fazer. Marcá-la pendente encheria a fila de liquidação do
     * bloco 50 com linhas que nunca teriam o que repassar.
     */
    await ligarSplit(317);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const split = await splitDaVenda(TENANT, orderId);
    const soma = (split?.fatias ?? []).reduce((s, f) => s + f.valorCents, 0);
    expect(soma).toBe(10_000);

    const casa = split?.fatias.find((f) => f.parte === 'barbearia');
    expect(casa?.estado).toBe('liquidado');
    expect(split?.fatias.find((f) => f.parte === 'profissional')?.estado).toBe('pendente');
  });

  it('a reentrega do webhook não cria a segunda cópia de cada parte', async () => {
    /**
     * O adquirente reentrega por desenho. Sem o índice único, a mesma
     * confirmação criaria a segunda fatia de cada parte — o profissional
     * receberia duas vezes, e a soma deixaria de ser o pagamento.
     *
     * Aqui a reentrega chega com **evento novo**, que é o caso que a chave
     * primária de `order_charge_events` não pega.
     */
    await ligarSplit(500);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId, 'ev-1');

    const antes = await splitDaVenda(TENANT, orderId);
    await withTenant(TENANT, async (tx) => {
      const [c] = await tx.$queryRaw<{ id: string; psp_payment_id: string }[]>`
        SELECT id, psp_payment_id FROM order_charges WHERE order_id = ${orderId}::uuid
      `;
      if (!c) throw new Error('sem cobrança');
      await confirmarCobranca({
        tenantId: TENANT, eventoId: 'ev-2', tipo: 'payment_intent.succeeded',
        pagamentoId: c.psp_payment_id, estado: 'pago', hojeNaUnidade: HOJE,
      });
    });

    const depois = await splitDaVenda(TENANT, orderId);
    expect(depois?.fatias).toHaveLength(antes?.fatias.length ?? 0);
  });

  it('dois barbeiros na mesma comanda viram duas fatias, e a plataforma não dobra', async () => {
    await ligarSplit(500);
    const comanda = await abrirComanda({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: comanda.id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 1,
      precoUnitarioCents: 6000, professionalId: RUAN, ...operador,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: comanda.id, tipo: 'service',
      serviceId: BARBA, descricao: 'Barba', quantidade: 1,
      precoUnitarioCents: 4000, professionalId: BRUNO, ...operador,
    });
    await pagarPeloPix(comanda.id);

    const split = await splitDaVenda(TENANT, comanda.id);
    const deProfissionais = (split?.fatias ?? []).filter((f) => f.parte === 'profissional');
    expect(deProfissionais).toHaveLength(2);
    expect(valorDe(split?.fatias ?? [], 'plataforma')).toBe(500);
    expect((split?.fatias ?? []).reduce((s, f) => s + f.valorCents, 0)).toBe(10_000);
  });

  it('comissão que não cabe no pagamento não derruba a venda', async () => {
    /**
     * É a lição do bloco 35 aplicada aqui, e esta é literalmente a transação do
     * webhook do Pix: uma exceção volta atrás com o dinheiro **sem registro
     * nenhum**, o adquirente reentrega por dias e a varredura para no meio do
     * laço.
     *
     * Com comissão de 100% e alíquota de plataforma de 30%, o split não fecha. O
     * que acontece é o valor ficar inteiro com a casa, com o motivo escrito — e
     * a venda continua paga.
     */
    await exec(`UPDATE commission_rules SET value = 10000 WHERE tenant_id = '${TENANT}';`);
    await ligarSplit(3000);

    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const paga = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM orders WHERE id = ${orderId}::uuid
      `,
    );
    expect(paga[0]?.status).toBe('paid');

    const split = await splitDaVenda(TENANT, orderId);
    expect(split?.fatias).toHaveLength(1);
    expect(split?.fatias[0]).toMatchObject({ parte: 'barbearia', estado: 'retido' });
    expect(split?.fatias[0]?.valorCents).toBe(10_000);
    expect(split?.fatias[0]?.ultimoErro).toBe('comissao_maior_que_o_pagamento');
  });

  it('sem alíquota da plataforma, o repasse é só casa e profissional', async () => {
    await ligarSplit(0);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const split = await splitDaVenda(TENANT, orderId);
    expect(split?.fatias.some((f) => f.parte === 'plataforma')).toBe(false);
    expect(valorDe(split?.fatias ?? [], 'barbearia')).toBe(6000);
    expect(valorDe(split?.fatias ?? [], 'profissional')).toBe(4000);
  });

  it('o extrato de repasses recorta pelo profissional', async () => {
    /**
     * Mesmo recorte de `extratoDeComissao`, e pela mesma razão: barbeiro que vê
     * o repasse do colega é o motivo nº 1 de briga interna em barbearia.
     */
    await ligarSplit(500);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const todos = await repassesDoPeriodo(periodo);
    expect(todos.length).toBeGreaterThan(1);

    const soDoRuan = await repassesDoPeriodo({ ...periodo, somenteProfessionalId: RUAN });
    expect(soDoRuan).toHaveLength(1);
    expect(soDoRuan[0]?.professionalId).toBe(RUAN);

    const soDoBruno = await repassesDoPeriodo({ ...periodo, somenteProfessionalId: BRUNO });
    expect(soDoBruno).toHaveLength(0);
  });

  it('venda paga na maquininha da casa não tem split', async () => {
    /**
     * Split é repartição de um pagamento que passou pelo **nosso** adquirente. O
     * dinheiro da maquininha da barbearia nunca esteve conosco, e não há o que
     * repartir — é por isso que `charge_id` não é nulo em vez de o split existir
     * "para toda venda".
     */
    await ligarSplit(500);
    const orderId = await comandaDe100();
    const { fecharComanda } = await import('./comanda.js');
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId,
      pagamentos: [{ forma: 'cash', valorCents: 10_000 }],
      hojeNaUnidade: HOJE, agora: AGORA, ...operador,
    });

    expect(await splitDaVenda(TENANT, orderId)).toBeNull();
  });
});
