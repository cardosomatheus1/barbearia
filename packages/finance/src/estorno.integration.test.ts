import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { abrirCaixa, caixaAberto } from './caixa.js';
import { abrirComanda, adicionarItem, ajustarComanda, fecharComanda } from './comanda.js';
import { estornarVenda, transferirPacote } from './estorno.js';
import { salvarRegraDeComissao } from './comissao.js';
import { salvarProduto } from './estoque.js';
import { salvarPrograma } from './fidelidade.js';
import { salvarPacoteDoCatalogo } from './pacote.js';
import { conceberVale, cancelarVale, tetoDoVale, valesDoPeriodo } from './vale.js';
import { fecharPeriodoDeComissao } from './comissao.js';
import { dreDoPeriodo } from './dre.js';

/**
 * Vale, estorno e DRE contra Postgres real (bloco 52, SPEC §3.10).
 *
 * O que só o banco prova: que o estorno desfaz as seis contrapartidas na mesma
 * transação, que o vale sai da gaveta e volta na folha uma vez só, e que a venda
 * estornada some do DRE — que era o motivo de o estado novo existir.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '52525252-1111-1111-1111-111111111111';
const RIVAL = '52525252-2222-2222-2222-222222222222';
const LOCATION = 'a2525252-0000-0000-0000-000000000001';
const RUAN = 'b2525252-0000-0000-0000-000000000001';
const CORTE = 'e2525252-0000-0000-0000-000000000001';
const CARLOS = 'c2525252-0000-0000-0000-000000000001';
const DIEGO = 'c2525252-0000-0000-0000-000000000002';
const STAFF = 'f2525252-0000-0000-0000-000000000001';

const HOJE = '2026-11-20';
const operador = { staffId: STAFF, staffName: 'Maria Recepção' };
const ator = { id: STAFF, name: 'Maria Recepção' };
const fecha = { ...operador, hojeNaUnidade: HOJE };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('vale, estorno e DRE', () => {
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
      VALUES ('${CORTE}', '${TENANT}', 'Corte', 5000, 30);

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777'),
        ('${DIEGO}', '${TENANT}', 'Diego Martins', '+5571988886666');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Maria', 'maria@domari.com.br', 'x', 'receptionist');
    `);
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 100_000, ...operador });
    await salvarRegraDeComissao({
      tenantId: TENANT,
      modo: 'percent',
      valor: 4000,
      ...operador,
    });
  });

  /** Uma venda de corte fechada em dinheiro, como o balcão faz. */
  async function venderCorte(
    extra: { customerId?: string | null; forma?: 'cash' | 'fiado' } = {},
  ): Promise<string> {
    const aberta = await abrirComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId: extra.customerId ?? CARLOS,
      staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      tipo: 'service',
      descricao: 'Corte',
      serviceId: CORTE,
      professionalId: RUAN,
      quantidade: 1,
      precoUnitarioCents: 5000,
      ...operador,
    });
    await fecharComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      pagamentos: [{ forma: extra.forma ?? 'cash', valorCents: 5000 }],
      ...fecha,
    });
    return aberta.id;
  }

  // -------------------------------------------------------------------------
  // Estorno
  // -------------------------------------------------------------------------

  it('estornar desfaz a comissão no período aberto e marca a venda', async () => {
    const orderId = await venderCorte();

    const resumo = await estornarVenda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId,
      motivo: 'Cliente reclamou do corte e foi reembolsado',
      hoje: HOJE,
      ...operador,
    });

    expect(resumo.comissoesEstornadas).toBe(1);

    const venda = await admin.$queryRawUnsafe<{ status: string; refund_reason: string }[]>(
      `SELECT status::text AS status, refund_reason FROM orders WHERE id = '${orderId}'`,
    );
    expect(venda[0]?.status).toBe('refunded');
    expect(venda[0]?.refund_reason).toContain('reclamou');

    const comissao = await admin.$queryRawUnsafe<{ sign: number; base_cents: number }[]>(
      `SELECT sign, base_cents FROM commission_entries WHERE order_id = '${orderId}'
        ORDER BY sign DESC`,
    );
    expect(comissao.map((c) => c.sign)).toEqual([1, -1]);
    // A base do estorno é a mesma da venda: quem calcula soma os dois e chega a
    // zero, sem precisar saber que houve estorno.
    expect(comissao[0]?.base_cents).toBe(comissao[1]?.base_cents);
  });

  it('o dinheiro volta da gaveta na mesma transação', async () => {
    const antes = await caixaAberto(TENANT, LOCATION);
    const orderId = await venderCorte();
    const comVenda = await caixaAberto(TENANT, LOCATION);
    expect(comVenda?.esperadoAgoraCents).toBe((antes?.esperadoAgoraCents ?? 0) + 5000);

    await estornarVenda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId,
      motivo: 'Erro de lançamento no balcão',
      hoje: HOJE,
      ...operador,
    });

    const depois = await caixaAberto(TENANT, LOCATION);
    expect(depois?.esperadoAgoraCents).toBe(antes?.esperadoAgoraCents);
  });

  it('o fiado lançado na venda é abatido do saldo do cliente', async () => {
    await exec(`UPDATE customers SET credit_limit_cents = 20000 WHERE id = '${CARLOS}'`);
    const orderId = await venderCorte({ forma: 'fiado' });

    const devendo = await admin.$queryRawUnsafe<{ balance_cents: number }[]>(
      `SELECT balance_cents FROM customers WHERE id = '${CARLOS}'`,
    );
    expect(devendo[0]?.balance_cents).toBe(-5000);

    const resumo = await estornarVenda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId,
      motivo: 'Serviço não foi prestado',
      hoje: HOJE,
      ...operador,
    });

    expect(resumo.fiadoAbatidoCents).toBe(5000);
    const zerado = await admin.$queryRawUnsafe<{ balance_cents: number }[]>(
      `SELECT balance_cents FROM customers WHERE id = '${CARLOS}'`,
    );
    expect(zerado[0]?.balance_cents).toBe(0);
  });

  it('o produto volta ao estoque com o custo congelado da saída', async () => {
    /**
     * Ler o custo do cadastro faria a devolução de janeiro entrar a preço de
     * agosto, e a diferença apareceria como lucro ou prejuízo de estoque que
     * nunca existiu.
     */
    const produto = await salvarProduto({
      tenantId: TENANT,
      nome: 'Pomada',
      tipo: 'resale',
      custoCents: 1200,
      precoCents: 3000,
      minimo: 0,
      unidade: 'un',
      ativo: true,
      ator,
    });
    await exec(`
      INSERT INTO stock_movements (tenant_id, product_id, location_id, kind, quantity,
                                   unit_cost_cents, business_day, reason)
      VALUES ('${TENANT}', '${produto.id}', '${LOCATION}', 'entrada', 10, 1200,
              '${HOJE}', 'compra');
    `);

    const aberta = await abrirComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId: CARLOS,
      staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      tipo: 'product',
      descricao: 'Pomada',
      productId: produto.id,
      professionalId: RUAN,
      quantidade: 2,
      precoUnitarioCents: 3000,
      ...operador,
    });
    await fecharComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: 6000 }],
      ...fecha,
    });

    // O custo de reposição sobe **depois** da venda.
    await exec(`UPDATE products SET cost_cents = 2500 WHERE id = '${produto.id}'`);

    const resumo = await estornarVenda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      motivo: 'Cliente devolveu a pomada lacrada',
      hoje: HOJE,
      ...operador,
    });

    expect(resumo.produtosDevolvidos).toBe(2);
    const volta = await admin.$queryRawUnsafe<{ unit_cost_cents: number; quantity: number }[]>(
      `SELECT unit_cost_cents, quantity FROM stock_movements
        WHERE order_id = '${aberta.id}' AND kind = 'entrada'`,
    );
    expect(volta[0]?.unit_cost_cents).toBe(1200);
    expect(volta[0]?.quantity).toBe(2);
  });

  it('o crédito acumulado na venda é desfeito; o resgatado não volta', async () => {
    /**
     * O crédito resgatado pagou um serviço que aconteceu — devolvê-lo daria ao
     * cliente o saldo de volta **e** o corte que ele já levou.
     */
    await salvarPrograma({
      tenantId: TENANT,
      programa: {
        modo: 'cashback',
        pontosPorReal: 1,
        valorDoPontoCents: 1,
        visitasParaPremio: 10,
        cashbackBps: 1000,
        validadeDias: null,
        escopo: 'empresa',
      },
      ator,
    });

    const orderId = await venderCorte();
    const acumulado = await admin.$queryRawUnsafe<{ amount: number }[]>(
      `SELECT amount FROM loyalty_entries WHERE order_id = '${orderId}' AND kind = 'acumulo'`,
    );
    expect(acumulado[0]?.amount).toBe(500);

    const resumo = await estornarVenda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId,
      motivo: 'Venda lançada em duplicidade',
      hoje: HOJE,
      ...operador,
    });

    expect(resumo.fidelidadeDesfeitaCents).toBe(500);
    const saldo = await admin.$queryRawUnsafe<{ total: number }[]>(
      `SELECT coalesce(sum(amount), 0)::int AS total FROM loyalty_entries
        WHERE customer_id = '${CARLOS}'`,
    );
    expect(saldo[0]?.total).toBe(0);
  });

  it('estornar duas vezes não desfaz duas vezes', async () => {
    const orderId = await venderCorte();
    const estornar = () =>
      estornarVenda({
        tenantId: TENANT,
        locationId: LOCATION,
        orderId,
        motivo: 'Erro de lançamento',
        hoje: HOJE,
        ...operador,
      });

    await estornar();
    await expect(estornar()).rejects.toMatchObject({ code: 'ja_estornada' });

    const comissoes = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM commission_entries WHERE order_id = '${orderId}' AND sign = -1`,
    );
    expect(Number(comissoes[0]?.n)).toBe(1);
  });

  it('a venda de outra barbearia não é estornável por esta', async () => {
    await exec(`
      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('a2525252-0000-0000-0000-000000000009', '${RIVAL}', 'Deles', 'America/Bahia');
      INSERT INTO orders (id, tenant_id, location_id, status, business_day, closed_at, total_cents)
      VALUES ('d2525252-0000-0000-0000-000000000009', '${RIVAL}',
              'a2525252-0000-0000-0000-000000000009', 'paid', '${HOJE}', now(), 9000);
    `);
    await expect(
      estornarVenda({
        tenantId: TENANT,
        locationId: 'a2525252-0000-0000-0000-000000000009',
        orderId: 'd2525252-0000-0000-0000-000000000009',
        motivo: 'tentativa',
        hoje: HOJE,
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'venda_nao_encontrada' });
  });

  it('sem motivo escrito, o estorno é recusado antes de tocar em nada', async () => {
    const orderId = await venderCorte();
    await expect(
      estornarVenda({
        tenantId: TENANT,
        locationId: LOCATION,
        orderId,
        motivo: ' ',
        hoje: HOJE,
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'motivo_obrigatorio' });

    const comissoes = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM commission_entries WHERE order_id = '${orderId}' AND sign = -1`,
    );
    expect(Number(comissoes[0]?.n)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Vale
  // -------------------------------------------------------------------------

  it('o teto do vale é o que ele já fez, e sai da mesma conta do extrato', async () => {
    await venderCorte();
    await venderCorte();

    const teto = await tetoDoVale({
      locationId: LOCATION,
      tenantId: TENANT,
      professionalId: RUAN,
      de: '2026-11-01',
      ate: '2026-11-30',
    });
    // Dois cortes de R$ 50 a 40% = R$ 40.
    expect(teto.comissaoAcumuladaCents).toBe(4000);
    expect(teto.disponivelCents).toBe(4000);
  });

  it('adiantar mais do que ele fez é recusado, com o teto na resposta', async () => {
    await venderCorte();
    await expect(
      conceberVale({
        tenantId: TENANT,
        locationId: LOCATION,
        professionalId: RUAN,
        valorCents: 2001,
        concedidoEm: HOJE,
        de: '2026-11-01',
        ate: '2026-11-30',
        pelaGaveta: false,
        ...operador,
      }),
    ).rejects.toMatchObject({
      code: 'vale_maior_que_a_comissao',
      detalhe: { disponivelCents: 2000 },
    });
  });

  it('dois vales não estouram o mesmo teto', async () => {
    // Sem descontar o que já foi pego, dois adiantamentos de R$ 20 num mês de
    // R$ 20 de comissão passariam os dois, cada um olhando o teto sozinho.
    await venderCorte();
    const pedir = (valorCents: number) =>
      conceberVale({
        tenantId: TENANT,
        locationId: LOCATION,
        professionalId: RUAN,
        valorCents,
        concedidoEm: HOJE,
        de: '2026-11-01',
        ate: '2026-11-30',
        pelaGaveta: false,
        ...operador,
      });

    await pedir(2000);
    await expect(pedir(1)).rejects.toMatchObject({ code: 'vale_maior_que_a_comissao' });
  });

  it('o vale pela gaveta sai do caixa', async () => {
    await venderCorte();
    const antes = await caixaAberto(TENANT, LOCATION);

    await conceberVale({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      valorCents: 2000,
      concedidoEm: HOJE,
      de: '2026-11-01',
      ate: '2026-11-30',
      pelaGaveta: true,
      motivo: 'Adiantamento pedido pelo Ruan',
      ...operador,
    });

    const depois = await caixaAberto(TENANT, LOCATION);
    expect(depois?.esperadoAgoraCents).toBe((antes?.esperadoAgoraCents ?? 0) - 2000);
  });

  it('o fechamento desconta o vale uma vez e o congela', async () => {
    /**
     * Fora da transação do fechamento existiria a janela em que a folha foi
     * fechada e os vales continuam abertos — e o mês seguinte os descontaria de
     * novo, cobrando duas vezes o mesmo adiantamento.
     */
    await venderCorte();
    await venderCorte();
    await conceberVale({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      valorCents: 1500,
      concedidoEm: HOJE,
      de: '2026-11-01',
      ate: '2026-11-30',
      pelaGaveta: false,
      ...operador,
    });

    await fecharPeriodoDeComissao({
      tenantId: TENANT,
      de: '2026-11-01',
      ate: '2026-11-30',
      ...operador,
    });

    const linha = await admin.$queryRawUnsafe<
      { amount_cents: number; advance_cents: number }[]
    >(`SELECT amount_cents, advance_cents FROM commission_closure_lines
        WHERE professional_id = '${RUAN}'`);
    expect(linha[0]?.amount_cents).toBe(4000);
    expect(linha[0]?.advance_cents).toBe(1500);

    const vales = await valesDoPeriodo({ locationId: LOCATION, tenantId: TENANT, de: '2026-11-01', ate: '2026-11-30' });
    expect(vales[0]?.estado).toBe('descontado');
  });

  it('cancelar um vale que saiu da gaveta devolve o dinheiro à gaveta', async () => {
    /**
     * Achado da `/security-review` deste bloco, e o mais caro dela. A primeira
     * versão só virava o estado: o dinheiro tinha saído de verdade, o
     * `withdrawal` continuava gravado, e cancelar apagava a dívida — o
     * fechamento do dia batia ao centavo, a folha não descontava nada, e o teto
     * voltava inteiro. Dava para repetir conceder-cancelar até esvaziar a
     * gaveta, deixando só uma fila de sangrias de aparência normal.
     */
    await venderCorte();
    const antes = await caixaAberto(TENANT, LOCATION);

    const vale = await conceberVale({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      valorCents: 2000,
      concedidoEm: HOJE,
      de: '2026-11-01',
      ate: '2026-11-30',
      pelaGaveta: true,
      ...operador,
    });

    await cancelarVale({
      locationId: LOCATION,
      tenantId: TENANT,
      valeId: vale.id,
      motivo: 'Lançado no profissional errado',
      ...operador,
    });

    const depois = await caixaAberto(TENANT, LOCATION);
    expect(depois?.esperadoAgoraCents).toBe(antes?.esperadoAgoraCents);
    expect(depois?.movimentos.some((m) => m.kind === 'supply')).toBe(true);
  });

  it('o fechamento não consome o vale de quem não tem comissão no período', async () => {
    /**
     * O outro achado da revisão, e ele não precisa de má-fé para acontecer:
     * Ruan pega vale em julho, tira agosto de férias, e o fechamento de agosto
     * — sem nenhum atendimento dele — apagava o adiantamento de julho. Quando
     * julho fechasse depois, ele receberia a comissão cheia e ficaria com o
     * dinheiro do vale.
     *
     * O vale fica **aberto**, e é descontado pelo primeiro fechamento que de
     * fato paga aquela pessoa.
     */
    await venderCorte();
    const vale = await conceberVale({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      valorCents: 1000,
      concedidoEm: '2026-11-05',
      de: '2026-11-01',
      ate: '2026-11-30',
      pelaGaveta: false,
      ...operador,
    });

    // Um período em que ninguém atendeu: o de dezembro.
    await exec(`
      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('b2525252-0000-0000-0000-000000000002', '${TENANT}', '${LOCATION}',
              'Bruno', 'professional');
      INSERT INTO orders (id, tenant_id, location_id, status, business_day, closed_at, total_cents)
      VALUES ('d2525252-0000-0000-0000-000000000007', '${TENANT}', '${LOCATION}',
              'paid', '2026-12-10', now(), 5000);
      INSERT INTO order_items (tenant_id, order_id, kind, description, quantity,
                               unit_price_cents, professional_id)
      VALUES ('${TENANT}', 'd2525252-0000-0000-0000-000000000007', 'service', 'Corte', 1,
              5000, 'b2525252-0000-0000-0000-000000000002');
      INSERT INTO commission_entries (tenant_id, professional_id, order_id, earned_on,
                                      mode, value, base_cents)
      VALUES ('${TENANT}', 'b2525252-0000-0000-0000-000000000002',
              'd2525252-0000-0000-0000-000000000007', '2026-12-10', 'percent', 4000, 5000);
    `);

    await fecharPeriodoDeComissao({
      tenantId: TENANT,
      de: '2026-12-01',
      ate: '2026-12-31',
      ...operador,
    });

    const depois = await admin.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status::text AS status FROM professional_advances WHERE id = '${vale.id}'`,
    );
    expect(depois[0]?.status).toBe('aberto');

    // E quando novembro fechar, aí sim ele é descontado — de quem o pegou.
    await fecharPeriodoDeComissao({
      tenantId: TENANT,
      de: '2026-11-01',
      ate: '2026-11-30',
      ...operador,
    });
    const enfim = await admin.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status::text AS status FROM professional_advances WHERE id = '${vale.id}'`,
    );
    expect(enfim[0]?.status).toBe('descontado');
  });

  it('o segundo toque com a mesma chave não adianta duas vezes', async () => {
    await venderCorte();
    const pedir = () =>
      conceberVale({
        tenantId: TENANT,
        locationId: LOCATION,
        professionalId: RUAN,
        valorCents: 1000,
        concedidoEm: HOJE,
        de: '2026-11-01',
        ate: '2026-11-30',
        pelaGaveta: false,
        idempotencyKey: 'balcao:1',
        ...operador,
      });

    const primeiro = await pedir();
    const segundo = await pedir();
    expect(segundo.id).toBe(primeiro.id);
    expect(await valesDoPeriodo({ locationId: LOCATION, tenantId: TENANT, de: '2026-11-01', ate: '2026-11-30' }))
      .toHaveLength(1);
  });

  it('cancelar exige motivo e só vale para o que está aberto', async () => {
    await venderCorte();
    const vale = await conceberVale({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      valorCents: 1000,
      concedidoEm: HOJE,
      de: '2026-11-01',
      ate: '2026-11-30',
      pelaGaveta: false,
      ...operador,
    });

    await expect(
      cancelarVale({ locationId: LOCATION, tenantId: TENANT, valeId: vale.id, motivo: 'x', ...operador }),
    ).rejects.toMatchObject({ code: 'motivo_obrigatorio' });

    await cancelarVale({
      locationId: LOCATION,
      tenantId: TENANT,
      valeId: vale.id,
      motivo: 'Lançado no profissional errado',
      ...operador,
    });
    await expect(
      cancelarVale({ locationId: LOCATION, tenantId: TENANT, valeId: vale.id, motivo: 'de novo', ...operador }),
    ).rejects.toMatchObject({ code: 'vale_nao_aberto' });

    // Cancelado sai da conta do teto: o dinheiro voltou.
    const teto = await tetoDoVale({
      locationId: LOCATION,
      tenantId: TENANT,
      professionalId: RUAN,
      de: '2026-11-01',
      ate: '2026-11-30',
    });
    expect(teto.jaAdiantadoCents).toBe(0);
  });

  // -------------------------------------------------------------------------
  // DRE
  // -------------------------------------------------------------------------

  it('a venda estornada some do DRE — que é o motivo do estado novo', async () => {
    await venderCorte();
    const estornada = await venderCorte();

    const antes = await dreDoPeriodo({
      tenantId: TENANT,
      locationId: LOCATION,
      de: '2026-11-01',
      ate: '2026-11-30',
    });
    expect(antes.atual.receitaServicosCents).toBe(10_000);

    await estornarVenda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: estornada,
      motivo: 'Venda lançada em duplicidade',
      hoje: HOJE,
      ...operador,
    });

    const depois = await dreDoPeriodo({
      tenantId: TENANT,
      locationId: LOCATION,
      de: '2026-11-01',
      ate: '2026-11-30',
    });
    expect(depois.atual.receitaServicosCents).toBe(5000);
    // A comissão também: o lançamento negativo entrou no mesmo período.
    expect(depois.atual.comissoesCents).toBe(2000);
  });

  it('o desconto concedido aparece no DRE, e a receita continua bruta', async () => {
    /**
     * Era o defeito: a comanda fecha pelo valor com desconto, o caixa bate, a
     * comissão sai sobre a base já reduzida — e **só** o relatório do dono não
     * sabia. Uma venda de R$ 50 com R$ 10 de desconto entrava como R$ 50 de
     * receita, e o resultado do mês crescia exatamente os R$ 10 que a casa
     * abriu mão.
     *
     * A receita bruta continua R$ 50 de propósito: `bruto` ignora taxa e
     * desconto, senão "bruto" quer dizer "bruto menos uma coisa". O que muda é
     * o desconto virar linha de custo — e é ela que devolve ao dono o número
     * que `finance.discount` e `max_discount_bps` existem para controlar.
     */
    const comanda = await abrirComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId: CARLOS,
      staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: comanda.id,
      tipo: 'service',
      descricao: 'Corte',
      serviceId: CORTE,
      professionalId: RUAN,
      quantidade: 1,
      precoUnitarioCents: 5000,
      ...operador,
    });
    await ajustarComanda({
      locationId: LOCATION,
      tenantId: TENANT,
      orderId: comanda.id,
      desconto: { tipo: 'amount', valor: 1000, motivo: 'cliente de sempre, combinado com o dono' },
      staffId: STAFF,
      staffName: 'Maria',
    });
    await fecharComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: comanda.id,
      pagamentos: [{ forma: 'cash', valorCents: 4000 }],
      ...fecha,
    });

    const dre = await dreDoPeriodo({
      tenantId: TENANT,
      locationId: LOCATION,
      de: '2026-11-01',
      ate: '2026-11-30',
    });

    expect(dre.atual.receitaServicosCents).toBe(5000);
    expect(dre.atual.descontosCents).toBe(1000);
    // O que de fato sobrou: R$ 40 entraram, e a comissão saiu sobre os R$ 40.
    expect(dre.atual.receitaBrutaCents - dre.atual.descontosCents).toBe(4000);
    expect(dre.atual.resultadoCents).toBe(4000 - dre.atual.comissoesCents - dre.atual.taxasCents);
  });

  it('a despesa paga do bloco 51 entra no resultado', async () => {
    await venderCorte();
    await exec(`
      INSERT INTO bills (tenant_id, location_id, direction, description, amount_cents,
                         due_on, status, paid_on, paid_cents, created_by_name)
      VALUES ('${TENANT}', '${LOCATION}', 'pagar', 'Aluguel', 200000, '${HOJE}',
              'paga', '${HOJE}', 200000, 'Maria');
    `);

    const dre = await dreDoPeriodo({
      tenantId: TENANT,
      locationId: LOCATION,
      de: '2026-11-01',
      ate: '2026-11-30',
    });
    expect(dre.atual.despesasCents).toBe(200_000);
    expect(dre.atual.resultadoCents).toBeLessThan(0);
  });

  it('o comparativo é contra uma janela do mesmo tamanho', async () => {
    await venderCorte();
    const dre = await dreDoPeriodo({
      tenantId: TENANT,
      locationId: LOCATION,
      de: '2026-11-01',
      ate: '2026-11-30',
    });
    expect(dre.comparadoDe).toBe('2026-10-02');
    expect(dre.comparadoAte).toBe('2026-10-31');
    expect(dre.anterior.receitaBrutaCents).toBe(0);
  });

  it('o DRE de uma barbearia não enxerga a venda da outra', async () => {
    await venderCorte();
    await exec(`
      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('a2525252-0000-0000-0000-000000000009', '${RIVAL}', 'Deles', 'America/Bahia');
      INSERT INTO orders (id, tenant_id, location_id, status, business_day, closed_at, total_cents)
      VALUES ('d2525252-0000-0000-0000-000000000008', '${RIVAL}',
              'a2525252-0000-0000-0000-000000000009', 'paid', '${HOJE}', now(), 90000);
    `);

    const dre = await dreDoPeriodo({
      tenantId: TENANT,
      locationId: 'a2525252-0000-0000-0000-000000000009',
      de: '2026-11-01',
      ate: '2026-11-30',
    });
    expect(dre.atual.receitaBrutaCents).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Transferência de pacote
  // -------------------------------------------------------------------------

  async function venderPacote(transferivel: boolean): Promise<string> {
    const catalogo = await salvarPacoteDoCatalogo({
      tenantId: TENANT,
      nome: '5 cortes',
      serviceId: CORTE,
      quantidade: 5,
      precoCents: 25_000,
      validadeDias: null,
      transferivel,
      ativo: true,
      ator,
    });
    const aberta = await abrirComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId: CARLOS,
      staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      tipo: 'package',
      descricao: '5 cortes',
      packageId: catalogo.id,
      professionalId: RUAN,
      quantidade: 1,
      precoUnitarioCents: 25_000,
      ...operador,
    });
    await fecharComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: 25_000 }],
      ...fecha,
    });

    const linhas = await admin.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM customer_packages WHERE customer_id = '${CARLOS}'`,
    );
    const id = linhas[0]?.id;
    if (!id) throw new Error('pacote não foi criado');
    return id;
  }

  it('o pacote transferível muda de dono com as unidades restantes', async () => {
    const pacoteId = await venderPacote(true);

    const { unidadesMovidas } = await transferirPacote({
      tenantId: TENANT,
      customerPackageId: pacoteId,
      paraCustomerId: DIEGO,
      motivo: 'Presente do pai para o filho',
      ...operador,
    });

    expect(unidadesMovidas).toBe(5);
    const dono = await admin.$queryRawUnsafe<{ customer_id: string }[]>(
      `SELECT customer_id FROM customer_packages WHERE id = '${pacoteId}'`,
    );
    expect(dono[0]?.customer_id).toBe(DIEGO);
  });

  it('a receita já reconhecida fica com o primeiro dono', async () => {
    /**
     * `package_uses` é fato consumado, com a data em que foi reconhecida.
     * Reatribuí-la reescreveria o resultado de um mês que já fechou — é a mesma
     * razão de a comissão fechada ser imutável.
     */
    const pacoteId = await venderPacote(true);

    // Consome uma unidade antes de transferir.
    const aberta = await abrirComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId: CARLOS,
      staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      tipo: 'service',
      descricao: 'Corte',
      serviceId: CORTE,
      professionalId: RUAN,
      quantidade: 1,
      precoUnitarioCents: 5000,
      ...operador,
    });
    await fecharComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      pagamentos: [{ forma: 'pacote', valorCents: 5000 }],
      servicoDoPacote: CORTE,
      ...fecha,
    });

    const { unidadesMovidas } = await transferirPacote({
      tenantId: TENANT,
      customerPackageId: pacoteId,
      paraCustomerId: DIEGO,
      motivo: 'Presente',
      ...operador,
    });
    expect(unidadesMovidas).toBe(4);

    const usos = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM package_uses WHERE customer_package_id = '${pacoteId}'`,
    );
    expect(Number(usos[0]?.n)).toBe(1);

    const registro = await admin.$queryRawUnsafe<
      { from_customer_id: string; units_moved: number }[]
    >(`SELECT from_customer_id, units_moved FROM package_transfers
        WHERE customer_package_id = '${pacoteId}'`);
    expect(registro[0]?.from_customer_id).toBe(CARLOS);
    expect(registro[0]?.units_moved).toBe(4);
  });

  it('pacote vendido como intransferível não passa adiante', async () => {
    /**
     * `transferable` é congelado na compra desde o bloco 42: ligar a
     * transferência no catálogo hoje não pode tornar transferível o que foi
     * vendido ontem como intransferível.
     */
    const pacoteId = await venderPacote(false);
    await expect(
      transferirPacote({
        tenantId: TENANT,
        customerPackageId: pacoteId,
        paraCustomerId: DIEGO,
        motivo: 'Presente',
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'pacote_nao_transferivel' });
  });

  it('o cliente de outra barbearia não recebe pacote desta', async () => {
    /**
     * A checagem de integridade referencial do Postgres ignora row security: sem
     * o `SELECT` sob a política antes de gravar, a chave estrangeira aceitaria
     * mandar o pacote para fora do tenant.
     */
    const pacoteId = await venderPacote(true);
    await exec(`
      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('c2525252-0000-0000-0000-000000000009', '${RIVAL}', 'Deles', '+5571900000000');
    `);
    await expect(
      transferirPacote({
        tenantId: TENANT,
        customerPackageId: pacoteId,
        paraCustomerId: 'c2525252-0000-0000-0000-000000000009',
        motivo: 'Presente',
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'destino_nao_encontrado' });
  });

  it('transferir sem motivo escrito é recusado', async () => {
    const pacoteId = await venderPacote(true);
    await expect(
      transferirPacote({
        tenantId: TENANT,
        customerPackageId: pacoteId,
        paraCustomerId: DIEGO,
        motivo: ' ',
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'motivo_obrigatorio' });
  });
});
