import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakePaymentProvider, FakeSplitProvider } from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import { abrirCaixa } from './caixa.js';
import { abrirComanda, adicionarItem } from './comanda.js';
import { confirmarCobranca, criarCobrancaDaComanda } from './cobranca-online.js';
import { salvarRegraDeComissao } from './comissao.js';
import {
  cadastrarRecebedor,
  conciliarRecebedores,
  estornarSplitDaVenda,
  liquidarRepasses,
  recebedores,
  repassesDoPeriodo,
  splitDaVenda,
} from './split.js';

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
const FILIAL = '49494949-aaaa-0000-0000-000000000002';
const RUAN = '49494949-bbbb-0000-0000-000000000001';
const BRUNO = '49494949-bbbb-0000-0000-000000000002';
const PROF_FILIAL = '49494949-bbbb-0000-0000-000000000003';
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
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia'),
             ('${FILIAL}', '${TENANT}', 'Filial', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Maria', 'maria@domari.com.br', 'x', 'owner');

      INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
        ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan'),
        ('${BRUNO}', '${TENANT}', '${LOCATION}', 'Bruno'),
        ('${PROF_FILIAL}', '${TENANT}', '${FILIAL}', 'Da Filial');

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
      provider: new FakePaymentProvider(),
      agora: AGORA,
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
        pagamentoId: c.psp_payment_id, estado: 'pago',
        provider: new FakePaymentProvider(), agora: AGORA,
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

  // -- KYC, liquidação e estorno (bloco 50) ------------------------------------

  it('painel e cadastro de recebedor respeitam a unidade atual', async () => {
    const lista = await recebedores(TENANT, LOCATION);
    expect(lista.map((r) => r.professionalId)).not.toContain(PROF_FILIAL);

    await expect(cadastrarRecebedor({
      tenantId: TENANT, locationId: LOCATION, professionalId: PROF_FILIAL,
      documento: '12345678900', banco: '001', agencia: '1234', conta: '12345-6',
      idempotencyKey: 'kyc-outra-unidade', provider: new FakeSplitProvider(),
      ...operador,
    })).rejects.toMatchObject({ code: 'profissional_nao_encontrado' });
  });

  const cadastro = (provider: FakeSplitProvider, professionalId = RUAN) =>
    cadastrarRecebedor({
      locationId: LOCATION,
      tenantId: TENANT,
      professionalId,
      documento: '12345678900',
      banco: '260',
      agencia: '0001',
      conta: '1234567-8',
      idempotencyKey: `kyc-${professionalId}`,
      provider,
      ...operador,
      agora: AGORA,
    });

  it('o cadastro no adquirente nasce pendente, e nada do banco é gravado aqui', async () => {
    /**
     * *"O onboarding disso é assíncrono."* Documento, banco, agência e conta
     * atravessam para o adquirente — quem tem obrigação regulatória de
     * guardá-los é ele. Deste lado fica a referência opaca, pela mesma razão do
     * token do cartão do clube.
     */
    const provider = new FakeSplitProvider();
    const { estado } = await cadastro(provider);

    expect(estado).toBe('pendente');
    expect(provider.recebedores[0]?.documento).toBe('12345678900');

    const lista = await recebedores(TENANT);
    const ruan = lista.find((r) => r.professionalId === RUAN);
    expect(ruan).toMatchObject({ kyc: 'pendente', temRecebedor: true });
  });

  it('a trilha do cadastro não guarda dado bancário', async () => {
    // Trilha não é lugar de conta bancária de terceiro. O que entra é o estado.
    const provider = new FakeSplitProvider();
    await cadastro(provider);

    const [linha] = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ after: unknown }[]>`
        SELECT after FROM audit_log WHERE action = 'split.recipient_changed' LIMIT 1
      `,
    );
    expect(JSON.stringify(linha?.after)).not.toContain('12345678900');
    expect(JSON.stringify(linha?.after)).not.toContain('1234567-8');
  });

  it('sem cadastro aprovado a parte é retida, e a venda não é bloqueada', async () => {
    /**
     * A frase mais importante da seção: *"enquanto pendente, o pagamento cai
     * integralmente na barbearia e a comissão é paga fora, **sem bloquear a
     * venda**"*. O caminho óbvio — recusar a venda até o barbeiro estar
     * aprovado — produziria a barbearia descobrindo no balcão, com o cliente na
     * frente, que não consegue cobrar.
     */
    await ligarSplit(500);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const provider = new FakeSplitProvider();
    const resultado = await liquidarRepasses({ tenantId: TENANT, provider, agora: AGORA });

    expect(resultado.retidos).toBe(1);
    expect(provider.repasses).toHaveLength(1); // só a da plataforma
    const split = await splitDaVenda(TENANT, orderId);
    expect(split?.fatias.find((f) => f.parte === 'profissional')?.estado).toBe('retido');
  });

  it('aprovado, o repasse sai e a parte fica liquidada', async () => {
    await ligarSplit(0);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const provider = new FakeSplitProvider();
    provider.proximoEstadoDoRecebedor = 'aprovado';
    await cadastro(provider);
    provider.proximoResultado = { ok: true, transferenciaId: 'tr_1' };

    const resultado = await liquidarRepasses({ tenantId: TENANT, provider, agora: AGORA });
    expect(resultado.repassados).toBe(1);

    const split = await splitDaVenda(TENANT, orderId);
    const doRuan = split?.fatias.find((f) => f.parte === 'profissional');
    expect(doRuan).toMatchObject({ estado: 'liquidado', valorCents: 4000 });
  });

  it('depois de três recusas, desiste e retém — e cada tentativa fica registrada', async () => {
    /**
     * O contador entra no `WHERE` do `UPDATE` que reivindica a tentativa, e é
     * ele que impede dois workers de mandarem o mesmo repasse duas vezes. A
     * pergunta que chega é "por que o Ruan não recebeu?", e a resposta é o motivo
     * da terceira tentativa — não o número três.
     */
    await ligarSplit(0);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const provider = new FakeSplitProvider();
    provider.proximoEstadoDoRecebedor = 'aprovado';
    await cadastro(provider);
    provider.proximoResultado = { ok: false, codigo: 'conta_invalida', motivo: 'conta inválida', definitiva: true };

    for (let i = 0; i < 3; i += 1) {
      await liquidarRepasses({ tenantId: TENANT, provider, agora: AGORA });
    }
    const ultima = await liquidarRepasses({ tenantId: TENANT, provider, agora: AGORA });
    expect(ultima.desistidos).toBe(1);
    expect(provider.repasses).toHaveLength(3);

    const tentativas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM split_transfers`,
    );
    expect(Number(tentativas[0]?.n)).toBe(3);

    const split = await splitDaVenda(TENANT, orderId);
    expect(split?.fatias.find((f) => f.parte === 'profissional')?.estado).toBe('retido');
  });

  it('a conciliação descobre a aprovação que o webhook perdeu', async () => {
    // Rede de segurança, pelo mesmo desenho da conciliação de cobranças do bloco
    // 35: webhook perdido não pode deixar um barbeiro aprovado recebendo pelo
    // fechamento para sempre.
    const provider = new FakeSplitProvider();
    await cadastro(provider);

    provider.proximoEstadoDoRecebedor = 'aprovado';
    const conciliado = await conciliarRecebedores({ tenantId: TENANT, provider, agora: AGORA });
    expect(conciliado).toMatchObject({ conferidos: 1, aprovados: 1 });

    const lista = await recebedores(TENANT);
    expect(lista.find((r) => r.professionalId === RUAN)?.kyc).toBe('aprovado');
  });

  it('a tela mostra quanto está retido por falta de cadastro', async () => {
    /**
     * O cadastro no adquirente é burocracia que ninguém faz por gosto. A coluna
     * que diz "R$ 40 do Ruan passaram pela casa porque ele não terminou o
     * cadastro" é o que faz o cadastro acontecer.
     */
    await ligarSplit(0);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);
    await liquidarRepasses({ tenantId: TENANT, provider: new FakeSplitProvider(), agora: AGORA });

    const lista = await recebedores(TENANT);
    expect(lista.find((r) => r.professionalId === RUAN)?.retidoCents).toBe(4000);
  });

  it('estorno antes da liquidação cancela a parte, e ninguém deve nada', async () => {
    await ligarSplit(500);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const desfeito = await withTenant(TENANT, (tx) =>
      estornarSplitDaVenda(tx, { orderId, quandoISO: HOJE }),
    );
    expect(desfeito.cobrados).toBe(0);
    expect(desfeito.cancelados).toBeGreaterThan(0);

    const split = await splitDaVenda(TENANT, orderId);
    expect(split?.fatias.every((f) => f.estado === 'estornado')).toBe(true);
  });

  it('estorno de repasse já liquidado vira dívida do profissional', async () => {
    /**
     * *"Estorno com split já liquidado exige política explícita de
     * recuperação."* O dinheiro entrou na conta dele e nenhum adquirente deixa a
     * plataforma sacar de um recebedor. A política é comissão negativa no
     * período aberto — o mesmo mecanismo do estorno de venda desde o bloco 19, e
     * o que o barbeiro já entende.
     */
    await ligarSplit(0);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const provider = new FakeSplitProvider();
    provider.proximoEstadoDoRecebedor = 'aprovado';
    await cadastro(provider);
    provider.proximoResultado = { ok: true, transferenciaId: 'tr_1' };
    await liquidarRepasses({ tenantId: TENANT, provider, agora: AGORA });

    const desfeito = await withTenant(TENANT, (tx) =>
      estornarSplitDaVenda(tx, { orderId, quandoISO: HOJE }),
    );
    expect(desfeito.cobrados).toBe(1);

    const [divida] = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ value: number; sign: number; professional_id: string }[]>`
        SELECT value, sign, professional_id FROM commission_entries WHERE sign = -1
      `,
    );
    expect(divida).toMatchObject({ value: 4000, sign: -1, professional_id: RUAN });
  });

  it('a parte da casa liquidada não vira dívida de ninguém', async () => {
    // O dinheiro nunca saiu de lá: o estorno volta da conta dela pelo próprio
    // adquirente, e não há de quem cobrar.
    await ligarSplit(500);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    await withTenant(TENANT, (tx) => estornarSplitDaVenda(tx, { orderId, quandoISO: HOJE }));

    const negativas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM commission_entries WHERE sign = -1
      `,
    );
    expect(Number(negativas[0]?.n)).toBe(0);
  });

  it('estornar duas vezes não cria duas dívidas', async () => {
    await ligarSplit(0);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const provider = new FakeSplitProvider();
    provider.proximoEstadoDoRecebedor = 'aprovado';
    await cadastro(provider);
    provider.proximoResultado = { ok: true, transferenciaId: 'tr_1' };
    await liquidarRepasses({ tenantId: TENANT, provider, agora: AGORA });

    await withTenant(TENANT, (tx) => estornarSplitDaVenda(tx, { orderId, quandoISO: HOJE }));
    const segundo = await withTenant(TENANT, (tx) =>
      estornarSplitDaVenda(tx, { orderId, quandoISO: HOJE }),
    );
    expect(segundo).toMatchObject({ cancelados: 0, cobrados: 0 });
  });

  it('estorno no meio da chamada ao adquirente cobra do profissional', async () => {
    /**
     * O achado da `/security-review` deste bloco, e ele era caro.
     *
     * `FOR UPDATE` sem escrita não separa nada: a liquidação solta a linha antes
     * de falar com o adquirente, e o estorno entrava exatamente nessa janela,
     * lia `pendente`, marcava `estornado` e concluía que ninguém devia nada.
     * Segundos depois o adquirente confirmava a transferência — cliente
     * reembolsado, barbeiro com o dinheiro, dívida nunca criada.
     *
     * O conserto é o estado `liquidando`, e este teste o exercita pelo meio: o
     * estorno roda **enquanto** o provedor está respondendo.
     */
    await ligarSplit(0);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const provider = new FakeSplitProvider();
    provider.proximoEstadoDoRecebedor = 'aprovado';
    await cadastro(provider);

    // O provedor "demora", e é durante a demora que a venda é estornada.
    const lento: typeof provider = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      transferir: async (pedido: { fatiaId: string }) => {
        await withTenant(TENANT, (tx) => estornarSplitDaVenda(tx, { orderId, quandoISO: HOJE }));
        return { ok: true as const, transferenciaId: `tr_${pedido.fatiaId}` };
      },
    });

    const resultado = await liquidarRepasses({ tenantId: TENANT, provider: lento, agora: AGORA });

    // O repasse saiu de verdade, e o produto sabe disso: não foi contado como
    // sucesso silencioso, e a dívida do profissional existe.
    expect(resultado.divergentes).toBeGreaterThan(0);

    const [divida] = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ value: number; professional_id: string }[]>`
        SELECT value, professional_id FROM commission_entries WHERE sign = -1
      `,
    );
    expect(divida).toMatchObject({ value: 4000, professional_id: RUAN });

    const tentativas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ ok: boolean }[]>`SELECT ok FROM split_transfers`,
    );
    expect(tentativas.some((t) => t.ok)).toBe(true);
  });

  it('falha definitiva depois do estorno em voo desfaz o clawback provisório', async () => {
    await ligarSplit(0);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const provider = new FakeSplitProvider();
    provider.proximoEstadoDoRecebedor = 'aprovado';
    await cadastro(provider);

    const falhaDepoisDoEstorno: typeof provider = Object.assign(
      Object.create(Object.getPrototypeOf(provider)),
      provider,
      {
        transferir: async () => {
          await withTenant(TENANT, (tx) => estornarSplitDaVenda(tx, { orderId, quandoISO: HOJE }));
          return { ok: false as const, codigo: 'conta_bloqueada', motivo: 'não transferiu', definitiva: true };
        },
      },
    );

    const resultado = await liquidarRepasses({ tenantId: TENANT, provider: falhaDepoisDoEstorno, agora: AGORA });
    expect(resultado.compensados).toBe(1);

    const soma = await withTenant(TENANT, (tx) => tx.$queryRaw<{ total: bigint }[]>`
      SELECT coalesce(sum(sign * value), 0)::bigint AS total
        FROM commission_entries
       WHERE order_id = ${orderId}::uuid AND order_item_id IS NULL
    `);
    expect(Number(soma[0]?.total)).toBe(0);

    const [fatia] = await withTenant(TENANT, (tx) => tx.$queryRaw<{
      recovery_pending: boolean;
      clawback_entry_id: string | null;
      clawback_reversal_entry_id: string | null;
    }[]>`
      SELECT recovery_pending, clawback_entry_id, clawback_reversal_entry_id
        FROM payment_splits
       WHERE order_id = ${orderId}::uuid AND party = 'profissional'
    `);
    expect(fatia).toMatchObject({ recovery_pending: false });
    expect(fatia?.clawback_entry_id).toBeTruthy();
    expect(fatia?.clawback_reversal_entry_id).toBeTruthy();
  });

  it('falha ambígua no repasse estornado é reapresentada com a mesma intenção até desfecho', async () => {
    await ligarSplit(0);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const provider = new FakeSplitProvider();
    provider.proximoEstadoDoRecebedor = 'aprovado';
    await cadastro(provider);
    const chaves: string[] = [];
    let primeira = true;
    const recuperavel: typeof provider = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      transferir: async (pedido: { idempotencyKey: string }) => {
        chaves.push(pedido.idempotencyKey);
        if (primeira) {
          primeira = false;
          await withTenant(TENANT, (tx) => estornarSplitDaVenda(tx, { orderId, quandoISO: HOJE }));
          throw new Error('resposta perdida');
        }
        return { ok: false as const, codigo: 'conta_bloqueada', motivo: 'não transferiu', definitiva: true };
      },
    });

    const uma = await liquidarRepasses({ tenantId: TENANT, provider: recuperavel, agora: AGORA });
    expect(uma.compensados).toBe(0);
    const duas = await liquidarRepasses({ tenantId: TENANT, provider: recuperavel, agora: AGORA });
    expect(duas.compensados).toBe(1);
    expect(chaves).toHaveLength(2);
    expect(new Set(chaves).size).toBe(1);
  });

  it('a chamada que não responde não vira segundo repasse', async () => {
    /**
     * Um tempo limite é o caso em que o adquirente **executou** a transferência
     * e a resposta se perdeu. A parte fica em `liquidando`, e a régua não a
     * retenta às cegas — quem a resgata é a volta seguinte, e ela vai com a mesma
     * chave de idempotência, que faz o adquirente devolver o resultado da
     * primeira em vez de pagar de novo.
     */
    await ligarSplit(0);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const provider = new FakeSplitProvider();
    provider.proximoEstadoDoRecebedor = 'aprovado';
    await cadastro(provider);

    const mudo: typeof provider = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      transferir: async () => { throw new Error('tempo limite'); },
    });

    await liquidarRepasses({ tenantId: TENANT, provider: mudo, agora: AGORA });
    // A volta seguinte, ainda dentro da hora: a parte continua em espera.
    const segunda = await liquidarRepasses({ tenantId: TENANT, provider: mudo, agora: AGORA });
    expect(segunda.repassados).toBe(0);

    const split = await splitDaVenda(TENANT, orderId);
    const doRuan = split?.fatias.find((f) => f.parte === 'profissional');
    expect(doRuan?.estado).toBe('falhou');
  });

  it('a chave que vai ao adquirente é estável entre tentativas', async () => {
    /**
     * O oposto da chave da cobrança do clube, e a diferença é a direção do
     * dinheiro: lá ela varia por tentativa porque retentar um cartão recusado é
     * uma cobrança nova; aqui, uma chave nova faria o adquirente executar a
     * **segunda transferência**.
     */
    await ligarSplit(0);
    const orderId = await comandaDe100();
    await pagarPeloPix(orderId);

    const provider = new FakeSplitProvider();
    provider.proximoEstadoDoRecebedor = 'aprovado';
    await cadastro(provider);
    provider.proximoResultado = { ok: false, codigo: 'indisponivel', motivo: 'fora do ar', definitiva: false };

    await liquidarRepasses({ tenantId: TENANT, provider, agora: AGORA });
    await liquidarRepasses({ tenantId: TENANT, provider, agora: AGORA });

    const doProfissional = provider.repasses.filter((r) => r.recebedorId !== '');
    expect(doProfissional).toHaveLength(1);
    expect(new Set(doProfissional.map((r) => r.idempotencyKey)).size).toBe(1);
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
      hojeNaUnidade: HOJE, ...operador,
    });

    expect(await splitDaVenda(TENANT, orderId)).toBeNull();
  });
});
