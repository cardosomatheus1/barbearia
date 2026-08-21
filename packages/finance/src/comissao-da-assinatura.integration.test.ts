import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { assinar, salvarPlano } from './assinatura.js';
import { abrirCaixa } from './caixa.js';
import { abrirComanda, adicionarItem, fecharComanda } from './comanda.js';
import {
  extratoDeComissao,
  rentabilidadeDoClube,
  salvarModeloDaAssinatura,
  salvarRegraDeComissao,
  simulacaoDaAssinatura,
} from './comissao.js';

/**
 * Comissão sobre assinatura contra Postgres real (bloco 48, SPEC §3.4).
 *
 * O que só o banco prova: que o lançamento sabe de qual assinatura veio, que a
 * mensalidade fica congelada nele, que trocar o modelo muda o extrato **sem
 * reescrever lançamento nenhum**, e que a comanda com dois cortes e um coberto
 * não marca os dois.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '48484848-1111-1111-1111-111111111111';
const LOCAL = 'a4848484-0000-0000-0000-000000000001';
const CARLOS = 'c4848484-0000-0000-0000-000000000001';
const DONO = 'd4848484-0000-0000-0000-000000000001';
const RUAN = 'e4848484-0000-0000-0000-000000000001';
const CORTE = 'f4848484-0000-0000-0000-000000000001';

const HOJE = '2026-11-15';
const AGORA = new Date('2026-11-15T12:00:00Z');
const MENSALIDADE = 14_900;
const PRECO_DO_CORTE = 6000;

const ator = { id: DONO, name: 'Matheus' };
const operador = { staffId: DONO, staffName: 'Matheus' };
const fecha = { ...operador, hojeNaUnidade: HOJE, agora: AGORA };
const periodo = { tenantId: TENANT, de: '2026-11-01', ate: '2026-11-30' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

/**
 * Um corte fechado pelo plano, como o balcão faz.
 *
 * `comQuem` existe para o terceiro estado da simulação: sem profissional no
 * item não há a quem lançar comissão, e é o caso que se parece com "não houve
 * atendimento" sem ser. É o caminho do produto — a recepção pode fechar uma
 * comanda sem dizer quem atendeu —, não um `DELETE` na tabela, que é append-only.
 */
async function cortePeloPlano(comQuem: string | null = RUAN): Promise<void> {
  const aberta = await abrirComanda({
    tenantId: TENANT, locationId: LOCAL, customerId: CARLOS, staffId: DONO,
  });
  await adicionarItem({
    tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'service',
    serviceId: CORTE, descricao: 'Corte', quantidade: 1,
    precoUnitarioCents: PRECO_DO_CORTE,
    ...(comQuem ? { professionalId: comQuem } : {}),
    ...operador,
  });
  await fecharComanda({
    tenantId: TENANT, locationId: LOCAL, orderId: aberta.id,
    pagamentos: [{ forma: 'assinatura', valorCents: PRECO_DO_CORTE }],
    servicoDaAssinatura: CORTE,
    ...fecha,
  });
}

const comissaoTotal = async (): Promise<number> =>
  (await extratoDeComissao(periodo)).totalComissaoCents;

describeIfDb('comissão sobre assinatura', () => {
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
      VALUES ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');

      INSERT INTO professionals (id, tenant_id, location_id, name)
      VALUES ('${RUAN}', '${TENANT}', '${LOCAL}', 'Ruan');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CORTE}', '${TENANT}', 'Corte', ${PRECO_DO_CORTE}, 30);
    `);

    await abrirCaixa({
      tenantId: TENANT, locationId: LOCAL, openingCents: 10_000, ...operador,
    });

    // 40% em tudo, que é a alíquota da SPEC §3.4.
    await salvarRegraDeComissao({
      tenantId: TENANT, modo: 'percent', valor: 4000, ...operador,
    });

    const plano = await salvarPlano({
      tenantId: TENANT,
      nome: 'Premium ilimitado',
      precoCents: MENSALIDADE,
      descontoEmProdutoBps: 0,
      ativo: true,
      beneficios: [{ serviceId: CORTE, quantidade: null, cooldownDias: 0 }],
      ator,
    });
    await assinar({ tenantId: TENANT, customerId: CARLOS, planId: plano.id, ator });
  });

  it('o lançamento sabe de qual assinatura veio, e por quanto ela foi vendida', async () => {
    /**
     * Sem as duas colunas, rateio e híbrido não teriam como existir: os dois
     * dependem do acumulado do período, e "quanto era a mensalidade" não se
     * descobre na leitura sem correr o risco de ela ter mudado no meio.
     */
    await cortePeloPlano();

    const linhas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ club_subscription_id: string | null; subscription_fee_cents: number | null }[]>`
        SELECT club_subscription_id, subscription_fee_cents FROM commission_entries
      `,
    );
    expect(linhas[0]?.club_subscription_id).toBeTruthy();
    expect(linhas[0]?.subscription_fee_cents).toBe(MENSALIDADE);
  });

  it('a mensalidade congelada não muda quando o plano é renegociado', async () => {
    // Subir o Premium em maio não pode mudar a comissão de abril — é a mesma
    // razão do custo do insumo e da taxa do adquirente congelados.
    await cortePeloPlano();
    await exec(`UPDATE club_subscriptions SET price_cents = 19900 WHERE tenant_id = '${TENANT}';`);

    const [linha] = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ subscription_fee_cents: number }[]>`
        SELECT subscription_fee_cents FROM commission_entries LIMIT 1
      `,
    );
    expect(linha?.subscription_fee_cents).toBe(MENSALIDADE);
  });

  it('por uso paga 40% do preço de tabela a cada corte, e é o padrão', async () => {
    await cortePeloPlano();
    await cortePeloPlano();
    await cortePeloPlano();
    await cortePeloPlano();

    // 4 × 40% de R$ 60 = R$ 96, numa mensalidade de R$ 149.
    expect(await comissaoTotal()).toBe(9600);
  });

  it('trocar para rateio muda o extrato sem reescrever lançamento nenhum', async () => {
    /**
     * É a propriedade que dá sentido ao desenho: o lançamento guarda base e
     * regra, e o valor é derivado. Sem isso, mudar de modelo exigiria reescrever
     * o histórico — e um período fechado deixaria de responder o mesmo número.
     */
    await cortePeloPlano();
    await cortePeloPlano();
    await cortePeloPlano();
    await cortePeloPlano();

    const antes = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM commission_entries`,
    );

    await salvarModeloDaAssinatura({
      tenantId: TENANT, modo: 'rateio', tetoBps: 6000, ...operador,
    });

    // 40% de R$ 149, e não 4 × 40% de R$ 60.
    expect(await comissaoTotal()).toBe(5960);

    const depois = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM commission_entries`,
    );
    expect(Number(depois[0]?.n)).toBe(Number(antes[0]?.n));
  });

  it('o híbrido segura no teto da mensalidade', async () => {
    for (let i = 0; i < 4; i += 1) await cortePeloPlano();

    await salvarModeloDaAssinatura({
      tenantId: TENANT, modo: 'hibrido', tetoBps: 6000, ...operador,
    });

    // Renderia R$ 96 por uso; o teto de 60% de R$ 149 é R$ 89,40.
    expect(await comissaoTotal()).toBeLessThanOrEqual(8940);
  });

  it('numa comanda com dois cortes e um coberto, só um vira lançamento de plano', async () => {
    /**
     * Casar por serviço marcaria os dois, e a comissão do corte que o cliente
     * pagou em dinheiro entraria no rateio da mensalidade. Teste de pertinência
     * não é teste de contagem — a lição do bloco 44, aplicada aqui.
     */
    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCAL, customerId: CARLOS, staffId: DONO,
    });
    for (const descricao of ['Corte do Carlos', 'Corte do filho']) {
      await adicionarItem({
        tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'service',
        serviceId: CORTE, descricao, quantidade: 1,
        precoUnitarioCents: PRECO_DO_CORTE, professionalId: RUAN, ...operador,
      });
    }
    await fecharComanda({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id,
      pagamentos: [
        { forma: 'assinatura', valorCents: PRECO_DO_CORTE },
        { forma: 'cash', valorCents: PRECO_DO_CORTE },
      ],
      servicoDaAssinatura: CORTE,
      ...fecha,
    });

    const linhas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM commission_entries
         WHERE club_subscription_id IS NOT NULL
      `,
    );
    expect(Number(linhas[0]?.n)).toBe(1);
  });

  it('o corte de quem não assina não é tocado por nenhum modelo', async () => {
    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCAL, customerId: CARLOS, staffId: DONO,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte avulso', quantidade: 1,
      precoUnitarioCents: PRECO_DO_CORTE, professionalId: RUAN, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: PRECO_DO_CORTE }],
      ...fecha,
    });

    await salvarModeloDaAssinatura({
      tenantId: TENANT, modo: 'rateio', tetoBps: 6000, ...operador,
    });
    // 40% de R$ 60. Ligar o rateio não pode mexer na comissão da casa inteira.
    expect(await comissaoTotal()).toBe(2400);
  });

  // -- a simulação e a rentabilidade -------------------------------------------

  it('a simulação mostra os três modelos sobre os dados reais', async () => {
    for (let i = 0; i < 4; i += 1) await cortePeloPlano();

    const simulacao = await simulacaoDaAssinatura(periodo);

    expect(simulacao.emUso).toBe('por_uso');
    expect(simulacao.receitaCents).toBe(MENSALIDADE);
    expect(simulacao.atendimentos).toBe(4);

    const porModo = new Map(simulacao.modelos.map((m) => [m.modo, m.comissaoCents]));
    expect(porModo.get('por_uso')).toBe(9600);
    expect(porModo.get('rateio')).toBe(5960);
    expect(porModo.get('hibrido')).toBeLessThanOrEqual(8940);
  });

  it('a rentabilidade mostra a margem por assinante, e ela pode ser negativa', async () => {
    /**
     * *"Sem essa tela, o dono descobre que o clube dá prejuízo seis meses
     * depois."* Oito cortes por uso custam R$ 192 numa mensalidade de R$ 149.
     */
    for (let i = 0; i < 8; i += 1) await cortePeloPlano();

    const conta = await rentabilidadeDoClube(periodo);
    expect(conta.modo).toBe('por_uso');
    expect(conta.assinantes).toHaveLength(1);
    expect(conta.assinantes[0]).toMatchObject({ cliente: 'Carlos Souza', usos: 8 });
    expect(conta.margemCents).toBeLessThan(0);

    await salvarModeloDaAssinatura({
      tenantId: TENANT, modo: 'rateio', tetoBps: 6000, ...operador,
    });
    // Com o rateio, a casa não paga mais do que recebeu — a margem vira positiva.
    expect((await rentabilidadeDoClube(periodo)).margemCents).toBeGreaterThan(0);
  });

  it('a simulação de um período sem atendimento de plano não inventa receita', async () => {
    const simulacao = await simulacaoDaAssinatura(periodo);
    expect(simulacao.receitaCents).toBe(0);
    expect(simulacao.atendimentos).toBe(0);
    // E diz que o período foi vazio de verdade — é o que separa este caso do
    // de baixo, que a tela vinha tratando como se fosse o mesmo.
    expect(simulacao.usosNoPeriodo).toBe(0);
  });

  it('sem regra de comissão, a simulação diz que houve atendimento — não que não houve', async () => {
    /**
     * O defeito que o bloco 127 fechou.
     *
     * `commission_entries` só ganha linha com profissional no item **e** regra
     * que case. A barbearia sem regra cadastrada via *"a comparação aparece
     * quando um assinante for atendido"* ao lado da tabela de rentabilidade que
     * listava os assinantes atendidos no mesmo período — duas metades do mesmo
     * painel discordando sobre o mesmo fato, e a que mentia era a que o dono lê
     * antes de escolher o modelo.
     *
     * A regra é apagada **depois** da semente: ela nasce no `beforeEach` de
     * propósito, e a barbearia real é a que nunca a cadastrou.
     */
    await withTenant(TENANT, (tx) => tx.$executeRaw`DELETE FROM commission_rules`);
    for (let i = 0; i < 3; i += 1) await cortePeloPlano();

    const simulacao = await simulacaoDaAssinatura(periodo);

    expect(simulacao.atendimentos, 'sem regra não há lançamento a comparar').toBe(0);
    expect(simulacao.usosNoPeriodo, 'e os atendimentos aconteceram').toBe(3);
    expect(simulacao.temRegraDeComissao).toBe(false);

    // E a rentabilidade, que é a outra metade da tela, concorda com o fato.
    const conta = await rentabilidadeDoClube(periodo);
    expect(conta.assinantes[0]?.usos).toBe(3);
  });

  it('com regra e sem profissional no item, a simulação separa o caso', async () => {
    // Terceiro estado: há regra, houve atendimento, e mesmo assim não há
    // lançamento — porque a comissão é de quem atendeu e o item não diz quem.
    for (let i = 0; i < 2; i += 1) await cortePeloPlano(null);

    const simulacao = await simulacaoDaAssinatura(periodo);
    expect(simulacao.atendimentos).toBe(0);
    expect(simulacao.usosNoPeriodo).toBe(2);
    expect(simulacao.temRegraDeComissao, 'a regra da semente continua lá').toBe(true);
  });

  it('teto fora de 0 a 100% é recusado antes do banco', async () => {
    await expect(
      salvarModeloDaAssinatura({
        tenantId: TENANT, modo: 'hibrido', tetoBps: 20_000, ...operador,
      }),
    ).rejects.toMatchObject({ code: 'aliquota_invalida' });
  });
});
