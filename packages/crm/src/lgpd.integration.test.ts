import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import {
  abrirPedidoDoTitular,
  consentimentosDoCliente,
  encerrarPedidoDoTitular,
  exportarDadosDoTitular,
  LgpdError,
  pedidosDoTitular,
  PRAZO_DO_PEDIDO_DIAS,
  registrarConsentimento,
} from './lgpd.js';

/**
 * Os direitos do titular contra Postgres real (bloco 31).
 *
 * O que só o banco responde: que o histórico não some, que o espelho que o
 * disparo de campanha lê acompanha a decisão, que a exportação de uma barbearia
 * não alcança a outra, e que uma tabela nova com dado de cliente não entra em
 * produção sem entrar na exportação junto.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '31313131-1111-1111-1111-111111111111';
const RIVAL = '31313131-2222-2222-2222-222222222222';
const LOCAL = 'a1313131-0000-0000-0000-000000000001';
const CARLOS = 'c1313131-0000-0000-0000-000000000001';
const DELA = 'c1313131-0000-0000-0000-000000000002';
const DONO = 'd1313131-0000-0000-0000-000000000001';

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const ator = { id: DONO, name: 'Matheus' };

describeIfDb('direitos do titular', () => {
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
      INSERT INTO tenants (id, name, dpo_name, dpo_email)
      VALUES ('${TENANT}', 'Domari', 'Matheus Cardoso', 'dpo@domari.com.br');
      INSERT INTO tenants (id, name) VALUES ('${RIVAL}', 'Vizinha');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777'),
        ('${DELA}', '${RIVAL}', 'Cliente da vizinha', '+5571977776666');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');
    `);
  });

  // -- consentimento ----------------------------------------------------------

  it('a decisão vira histórico, e o disparo de campanha lê o espelho', async () => {
    await registrarConsentimento({
      tenantId: TENANT,
      customerId: CARLOS,
      finalidade: 'marketing',
      concedido: true,
      versaoDoTexto: 'promo-2026-01',
      ip: '200.1.2.3',
    });

    const espelho = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ accepts_marketing: boolean; marketing_consent_version: string }[]>`
        SELECT accepts_marketing, marketing_consent_version FROM customers
         WHERE id = ${CARLOS}::uuid
      `,
    );
    expect(espelho[0]).toMatchObject({
      accepts_marketing: true,
      marketing_consent_version: 'promo-2026-01',
    });
  });

  it('revogar não apaga a concessão — as duas ficam', async () => {
    // É o par de datas que responde a uma contestação. Uma tabela com uma linha
    // por finalidade só responde a primeira, e mal.
    await registrarConsentimento({
      tenantId: TENANT, customerId: CARLOS, finalidade: 'marketing',
      concedido: true, versaoDoTexto: 'v1',
    });
    await registrarConsentimento({
      tenantId: TENANT, customerId: CARLOS, finalidade: 'marketing',
      concedido: false, versaoDoTexto: 'v1',
    });

    const { atuais, historico } = await consentimentosDoCliente(TENANT, CARLOS);
    expect(historico).toHaveLength(2);
    expect(atuais.marketing?.concedido).toBe(false);
    expect(historico.some((d) => d.concedido)).toBe(true);
  });

  it('as quatro finalidades são independentes', async () => {
    // Agendar não autoriza campanha, e consentir foto não autoriza publicá-la.
    await registrarConsentimento({
      tenantId: TENANT, customerId: CARLOS, finalidade: 'service',
      concedido: true, versaoDoTexto: 'v1',
    });
    await registrarConsentimento({
      tenantId: TENANT, customerId: CARLOS, finalidade: 'photos',
      concedido: true, versaoDoTexto: 'v1',
    });

    const { atuais } = await consentimentosDoCliente(TENANT, CARLOS);
    expect(atuais.service?.concedido).toBe(true);
    expect(atuais.photos?.concedido).toBe(true);
    expect(atuais.marketing).toBeUndefined();
    expect(atuais.photos_public).toBeUndefined();

    const espelho = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ accepts_marketing: boolean }[]>`
        SELECT accepts_marketing FROM customers WHERE id = ${CARLOS}::uuid
      `,
    );
    expect(espelho[0]?.accepts_marketing).toBe(false);
  });

  it('consentimento sem versão do texto é recusado', async () => {
    // "Ele aceitou" sem dizer o que ele leu não responde nada numa contestação.
    await expect(
      registrarConsentimento({
        tenantId: TENANT, customerId: CARLOS, finalidade: 'marketing',
        concedido: true, versaoDoTexto: '   ',
      }),
    ).rejects.toMatchObject({ code: 'version_required' });
  });

  it('o cliente da vizinha não recebe consentimento por esta barbearia', async () => {
    await expect(
      registrarConsentimento({
        tenantId: TENANT, customerId: DELA, finalidade: 'marketing',
        concedido: true, versaoDoTexto: 'v1',
      }),
    ).rejects.toBeInstanceOf(LgpdError);
  });

  it('registrar pelo balcão deixa trilha; pelo titular, não', async () => {
    await registrarConsentimento({
      tenantId: TENANT, customerId: CARLOS, finalidade: 'marketing',
      concedido: true, versaoDoTexto: 'v1', registradoPor: ator,
    });
    await registrarConsentimento({
      tenantId: TENANT, customerId: CARLOS, finalidade: 'photos',
      concedido: true, versaoDoTexto: 'v1',
    });

    const trilha = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM audit_log WHERE action = 'customer.consent_recorded'
      `,
    );
    // Uma linha, não duas: `audit_log` é a trilha de quem **da casa** mexeu em
    // quê, e a decisão do próprio titular não é isso.
    expect(Number(trilha[0]?.n)).toBe(1);
  });

  // -- exportação -------------------------------------------------------------

  it('a exportação traz o cadastro, o histórico e o encarregado da barbearia', async () => {
    await registrarConsentimento({
      tenantId: TENANT, customerId: CARLOS, finalidade: 'marketing',
      concedido: true, versaoDoTexto: 'promo-2026-01',
    });

    const dados = await exportarDadosDoTitular(TENANT, CARLOS);

    expect(dados.cadastro['nome']).toBe('Carlos Souza');
    expect(dados.cadastro['telefone']).toBe('+5571988887777');
    expect(dados.consentimentos).toHaveLength(1);
    expect(dados.barbearia).toEqual({
      nome: 'Domari',
      encarregado: 'Matheus Cardoso <dpo@domari.com.br>',
    });
  });

  it('a exportação não alcança o cliente de outra barbearia', async () => {
    await expect(exportarDadosDoTitular(TENANT, DELA)).rejects.toMatchObject({
      code: 'customer_not_found',
    });
  });

  /**
   * A guarda contra a tabela nova que ninguém lembra de exportar.
   *
   * A lista de nove consultas em `exportarDadosDoTitular` é escrita à mão de
   * propósito — varrer o catálogo pareceria mais completo e traria dado de
   * outra pessoa que só menciona esta. O custo é envelhecer, e este teste é
   * quem cobra: toda tabela com `customer_id` ou entra na exportação, ou entra
   * na lista de exceções **com o motivo escrito aqui**.
   */
  it('toda tabela com dado do cliente está na exportação ou na exceção escrita', async () => {
    const NA_EXPORTACAO = new Set([
      'customers',
      'customer_consents',
      'customer_preferences',
      'appointments',
      'orders',
      'customer_ledger',
      'notifications',
      'queue_entries',
      // A lista de espera (bloco 38). "Eu pedi para ser avisado do sábado de
      // manhã e nunca me avisaram" é exatamente o que a exportação responde.
      'waitlist_entries',
      // Os recados (bloco 40). "Eu reclamei da espera e vocês nunca me
      // responderam" é exatamente o que a exportação existe para responder.
      'feedbacks',
      // O saldo de fidelidade (bloco 41). "Quantos pontos eu tinha?" é dado do
      // titular tanto quanto o saldo de fiado.
      'loyalty_entries',
      // Os pacotes (bloco 42). "Eu comprei cinco cortes e vocês dizem que só
      // restam dois" é a pergunta, e o consumo unidade a unidade é a resposta.
      'customer_packages',
      // As avaliações (bloco 43). O texto que a pessoa escreveu sobre um
      // atendimento é dado dela tanto quanto a anotação da ficha.
      'reviews',
    ]);

    const EXCECOES = new Map([
      // Token de sessão é credencial, não dado pessoal: exportá-lo entregaria um
      // acesso vivo num arquivo que o titular recebe por e-mail.
      ['customer_sessions', 'credencial, não dado do titular'],
      // A que barbearia o pedido pertence e quando vence. É registro do
      // processo, e vai na resposta do pedido, não dentro do pacote de dados.
      ['data_requests', 'registro do processo, não conteúdo'],
    ]);

    const tabelas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ table_name: string }[]>`
        SELECT DISTINCT c.table_name
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_name = c.table_name AND t.table_schema = c.table_schema
         WHERE c.table_schema = 'public'
           AND c.column_name = 'customer_id'
           AND t.table_type = 'BASE TABLE'
      `,
    );

    const esquecidas = tabelas
      .map((t) => t.table_name)
      .filter((nome) => !NA_EXPORTACAO.has(nome) && !EXCECOES.has(nome));

    expect(
      esquecidas,
      `tabela com dado de cliente fora da exportação: ${esquecidas.join(', ')}`,
    ).toEqual([]);
  });

  // -- o pedido do titular ----------------------------------------------------

  it('o pedido nasce com prazo gravado, não calculado na leitura', async () => {
    const agora = new Date('2026-05-01T12:00:00Z');
    const pedido = await abrirPedidoDoTitular({
      tenantId: TENANT, customerId: CARLOS, tipo: 'export', agora,
    });

    expect(pedido.venceEm.toISOString()).toBe(
      new Date(agora.getTime() + PRAZO_DO_PEDIDO_DIAS * 86_400_000).toISOString(),
    );
    expect(pedido.estado).toBe('open');
  });

  it('pedir duas vezes devolve o mesmo pedido, com o mesmo vencimento', async () => {
    /**
     * O caso real: o titular manda no WhatsApp, a recepção registra pela ficha,
     * e ele clica no botão da tela dele achando que o primeiro não passou.
     *
     * Duas linhas fariam o mesmo prazo ter duas respostas — e o segundo
     * vencimento seria mais tarde, o que **atrasa** a obrigação em vez de
     * duplicá-la.
     */
    const primeiro = await abrirPedidoDoTitular({
      tenantId: TENANT, customerId: CARLOS, tipo: 'export',
      agora: new Date('2026-05-01T12:00:00Z'),
    });
    const segundo = await abrirPedidoDoTitular({
      tenantId: TENANT, customerId: CARLOS, tipo: 'export',
      agora: new Date('2026-05-09T12:00:00Z'),
    });

    expect(segundo.id).toBe(primeiro.id);
    expect(segundo.venceEm.toISOString()).toBe(primeiro.venceEm.toISOString());
    expect(await pedidosDoTitular(TENANT)).toHaveLength(1);

    // Tipo diferente é direito diferente, e abre pedido próprio.
    const exclusao = await abrirPedidoDoTitular({
      tenantId: TENANT, customerId: CARLOS, tipo: 'deletion',
    });
    expect(exclusao.id).not.toBe(primeiro.id);
  });

  it('pedir para cliente que não existe é recusado, não vira pedido órfão', async () => {
    await expect(
      abrirPedidoDoTitular({
        tenantId: TENANT,
        customerId: '31313131-9999-9999-9999-999999999999',
        tipo: 'export',
      }),
    ).rejects.toBeInstanceOf(LgpdError);
  });

  it('atender encerra o pedido e deixa trilha', async () => {
    const pedido = await abrirPedidoDoTitular({
      tenantId: TENANT, customerId: CARLOS, tipo: 'export',
    });
    await encerrarPedidoDoTitular({
      tenantId: TENANT, pedidoId: pedido.id, atendido: true, ator,
    });

    const abertos = await pedidosDoTitular(TENANT);
    expect(abertos).toHaveLength(0);

    const trilha = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ action: string }[]>`
        SELECT action FROM audit_log WHERE action LIKE 'lgpd.%'
      `,
    );
    expect(trilha[0]?.action).toBe('lgpd.request_fulfilled');
  });

  it('recusar exige motivo escrito', async () => {
    // A LGPD admite recusa; recusa sem motivo registrado é a que não se defende.
    const pedido = await abrirPedidoDoTitular({
      tenantId: TENANT, customerId: CARLOS, tipo: 'deletion',
    });

    await expect(
      encerrarPedidoDoTitular({
        tenantId: TENANT, pedidoId: pedido.id, atendido: false, nota: ' ', ator,
      }),
    ).rejects.toBeInstanceOf(LgpdError);

    await encerrarPedidoDoTitular({
      tenantId: TENANT,
      pedidoId: pedido.id,
      atendido: false,
      nota: 'obrigação fiscal de guarda por cinco anos',
      ator,
    });
    const todos = await pedidosDoTitular(TENANT, true);
    expect(todos[0]).toMatchObject({ estado: 'refused' });
  });

  it('pedido já encerrado não encerra de novo', async () => {
    const pedido = await abrirPedidoDoTitular({
      tenantId: TENANT, customerId: CARLOS, tipo: 'export',
    });
    await encerrarPedidoDoTitular({
      tenantId: TENANT, pedidoId: pedido.id, atendido: true, ator,
    });

    await expect(
      encerrarPedidoDoTitular({
        tenantId: TENANT, pedidoId: pedido.id, atendido: true, ator,
      }),
    ).rejects.toBeInstanceOf(LgpdError);
  });
});
