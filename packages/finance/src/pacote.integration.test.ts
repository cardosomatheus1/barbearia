import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { saldoDoCliente } from './fidelidade.js';
import { abrirCaixa } from './caixa.js';
import { abrirComanda, adicionarItem, fecharComanda } from './comanda.js';
import {
  PacoteError,
  catalogoDePacotes,
  consumoDisponivel,
  pacotesDoCliente,
  receitaDePacotes,
  reembolsarPacote,
  salvarPacoteDoCatalogo,
} from './pacote.js';

/**
 * Pacotes contra Postgres real (bloco 42, SPEC §4.7).
 *
 * O que só o banco prova: que a unidade sai do pacote **na mesma transação** que
 * fecha a venda, que a reentrada do fechamento não consome duas, que a receita
 * diferida bate com o que ainda não foi entregue — e que o reembolso devolve o
 * proporcional, não o preço cheio.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '42424242-1111-1111-1111-111111111111';
const RIVAL = '42424242-2222-2222-2222-222222222222';
const LOCATION = 'a2424242-0000-0000-0000-000000000001';
const RUAN = 'b2424242-0000-0000-0000-000000000001';
const CORTE = 'e2424242-0000-0000-0000-000000000001';
const BARBA = 'e2424242-0000-0000-0000-000000000002';
const CARLOS = 'c2424242-0000-0000-0000-000000000001';
const STAFF = 'f2424242-0000-0000-0000-000000000001';

const HOJE = '2026-11-01';
const AGORA = new Date('2026-11-01T12:00:00Z');
const operador = { staffId: STAFF, staffName: 'Maria Recepção' };
const ator = { id: STAFF, name: 'Maria Recepção' };
const fecha = { ...operador, hojeNaUnidade: HOJE };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('pacotes', () => {
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

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes) VALUES
        ('${CORTE}', '${TENANT}', 'Corte', 5000, 30),
        ('${BARBA}', '${TENANT}', 'Barba', 3000, 20);

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Maria', 'maria@domari.com.br', 'x', 'receptionist');
    `);
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 20000, ...operador });
  });

  const noCatalogo = (extra: Record<string, unknown> = {}) =>
    salvarPacoteDoCatalogo({
      tenantId: TENANT,
      nome: '5 cortes',
      serviceId: CORTE,
      quantidade: 5,
      precoCents: 25_000,
      validadeDias: null,
      transferivel: false,
      ativo: true,
      ator,
      ...extra,
    });

  /** Vende um pacote numa comanda fechada, como o balcão faz. */
  async function comprar(packageId: string, precoCents = 25_000): Promise<void> {
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
      quantidade: 1,
      // O preço sai do catálogo; este número é ignorado de propósito.
      precoUnitarioCents: precoCents,
      packageId,
      ...operador,
    });
    await fecharComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      pagamentos: [{ forma: 'pix', valorCents: precoCents }],
      ...fecha,
    });
  }

  /** Usa uma unidade num corte, como o balcão faz. */
  async function usar(valorCents = 5000): Promise<string> {
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
      serviceId: CORTE,
      descricao: 'Corte',
      quantidade: 1,
      precoUnitarioCents: valorCents,
      professionalId: RUAN,
      ...operador,
    });
    await fecharComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: aberta.id,
      pagamentos: [{ forma: 'pacote', valorCents }],
      servicoDoPacote: CORTE,
      ...fecha,
    });
    return aberta.id;
  }

  const meus = () => pacotesDoCliente(TENANT, CARLOS, AGORA);

  // -- o catálogo --------------------------------------------------------------

  it('o pacote nasce no catálogo com o serviço que ele cobre', async () => {
    await noCatalogo();
    const catalogo = await catalogoDePacotes(TENANT);
    expect(catalogo[0]).toMatchObject({ nome: '5 cortes', servicoNome: 'Corte', quantidade: 5 });
  });

  it('serviço de outra barbearia não vira pacote aqui', async () => {
    /**
     * A checagem de integridade referencial do Postgres ignora row security: a
     * chave estrangeira aceitaria o id, e o pacote nasceria cobrindo um corte
     * que esta casa não vende.
     */
    await exec(`
      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('a2424242-0000-0000-0000-0000000000ff', '${RIVAL}', 'Filial', 'America/Bahia');
      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('e2424242-0000-0000-0000-0000000000ff', '${RIVAL}', 'Corte alheio', 4000, 30);
    `);
    await expect(
      noCatalogo({ serviceId: 'e2424242-0000-0000-0000-0000000000ff' }),
    ).rejects.toMatchObject({ code: 'catalogo_nao_encontrado' });
  });

  // -- a venda -----------------------------------------------------------------

  it('vender congela serviço, quantidade e valor da unidade', async () => {
    /**
     * O corte avulso sobe para R$ 70 em março e as cinco unidades compradas em
     * janeiro continuam valendo R$ 50 cada. Recalcular na leitura faria a
     * receita **já reconhecida** mudar de valor.
     */
    const { id } = await noCatalogo();
    await comprar(id);

    await withTenant(TENANT, (tx) =>
      tx.$executeRaw`UPDATE services SET price_cents = 7000 WHERE id = ${CORTE}::uuid`,
    );

    const pacotes = await meus();
    expect(pacotes[0]).toMatchObject({
      total: 5,
      usados: 0,
      valorDaUnidadeCents: 5000,
      estado: 'ativo',
    });
  });

  it('vender sem cliente identificado é recusado', async () => {
    const { id } = await noCatalogo();
    const aberta = await abrirComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id, tipo: 'package',
      descricao: '5 cortes', quantidade: 1, precoUnitarioCents: 25_000,
      packageId: id, ...operador,
    });

    await expect(
      fecharComanda({
        tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
        pagamentos: [{ forma: 'pix', valorCents: 25_000 }],
        ...fecha,
      }),
    ).rejects.toThrow();
  });

  // -- o consumo ---------------------------------------------------------------

  it('usar tira uma unidade na mesma transação que fecha a comanda', async () => {
    /**
     * Fora dela, a comanda fecharia com o corte quitado e o pacote continuaria
     * cheio: crédito infinito, um corte por comanda.
     */
    const { id } = await noCatalogo();
    await comprar(id);
    await usar();

    expect((await meus())[0]).toMatchObject({ usados: 1, restam: 4 });
  });

  it('o pacote não cobre outro serviço', async () => {
    const { id } = await noCatalogo();
    await comprar(id);

    expect(
      await consumoDisponivel({
        tenantId: TENANT, customerId: CARLOS, serviceId: BARBA, agora: AGORA,
      }),
    ).toBeNull();
  });

  it('esgotado o pacote, não há mais o que consumir', async () => {
    const { id } = await noCatalogo({ quantidade: 2, precoCents: 10_000 });
    await comprar(id, 10_000);
    await usar();
    await usar();

    expect((await meus())[0]).toMatchObject({ usados: 2, estado: 'esgotado' });
    expect(
      await consumoDisponivel({
        tenantId: TENANT, customerId: CARLOS, serviceId: CORTE, agora: AGORA,
      }),
    ).toBeNull();
  });

  it('pacote vencido não é consumido, mesmo com saldo', async () => {
    // É o caso que mais aparece no balcão, e o que a recepção tenta usar.
    const { id } = await noCatalogo({ validadeDias: 30 });
    await comprar(id);
    await withTenant(TENANT, (tx) =>
      tx.$executeRaw`UPDATE customer_packages SET expires_at = '2026-10-01T12:00:00Z'`,
    );

    expect(
      await consumoDisponivel({
        tenantId: TENANT, customerId: CARLOS, serviceId: CORTE, agora: AGORA,
      }),
    ).toBeNull();
  });

  it('o pacote que vence antes é consumido primeiro', async () => {
    /**
     * Mesma ordem do saldo de fidelidade: consumir o de prazo maior deixaria
     * vencer saldo que o cliente podia ter usado.
     */
    const { id } = await noCatalogo({ quantidade: 2, precoCents: 10_000, validadeDias: 3650 });
    await comprar(id, 10_000);
    await comprar(id, 10_000);

    /**
     * A data é escrita, não `now() + interval`.
     *
     * O relógio do banco é o de verdade e `AGORA` é congelado em novembro: um
     * vencimento relativo a `now()` cairia **antes** de `AGORA`, e o pacote que
     * o teste quer ver escolhido apareceria vencido. Foi assim que a primeira
     * versão deste teste reprovou por um defeito que não existia.
     */
    const pacotes = await meus();
    await withTenant(TENANT, (tx) =>
      tx.$executeRaw`
        UPDATE customer_packages SET expires_at = '2026-11-06T12:00:00Z'
         WHERE id = ${pacotes[1]!.id}::uuid
      `,
    );

    const escolhido = await consumoDisponivel({
      tenantId: TENANT, customerId: CARLOS, serviceId: CORTE, agora: AGORA,
    });
    expect(escolhido?.customerPackageId).toBe(pacotes[1]!.id);
  });

  it('o consumo é append-only: a aplicação não reescreve nem apaga', async () => {
    // "Por que sumiu um corte do meu pacote?" é a pergunta, e o registro é a
    // resposta. Registro que pode ser reescrito não responde nada.
    const { id } = await noCatalogo();
    await comprar(id);
    await usar();

    await expect(
      withTenant(TENANT, (tx) => tx.$executeRaw`UPDATE package_uses SET value_cents = 1`),
    ).rejects.toThrow();
    await expect(
      withTenant(TENANT, (tx) => tx.$executeRaw`DELETE FROM package_uses`),
    ).rejects.toThrow();
  });

  it('a comissão do barbeiro não cai porque o cliente pagou adiantado', async () => {
    /**
     * O item do corte fica com o preço congelado da unidade, e é de propósito:
     * é ele que dá base à comissão. Zerar o item faria o barbeiro trabalhar de
     * graça por uma decisão comercial da casa.
     */
    await exec(`
      INSERT INTO commission_rules (tenant_id, professional_id, mode, value)
      VALUES ('${TENANT}', '${RUAN}', 'percent', 4000);
    `);
    const { id } = await noCatalogo();
    await comprar(id);
    const orderId = await usar();

    const lancamentos = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ base_cents: number }[]>`
        SELECT base_cents FROM commission_entries WHERE order_id = ${orderId}::uuid
      `,
    );
    expect(lancamentos[0]?.base_cents).toBe(5000);
  });

  // -- a receita diferida ------------------------------------------------------

  it('a venda entra no caixa e não vira receita ainda', async () => {
    /**
     * O número que este bloco existe para dar. A SPEC §4.7 escreve o motivo:
     * "Sem isso, o DRE mostra um mês excelente seguido de meses falsamente
     * ruins."
     */
    const { id } = await noCatalogo();
    await comprar(id);

    expect(await receitaDePacotes(TENANT, HOJE, AGORA)).toEqual({
      vendidoCents: 25_000,
      reconhecidoCents: 0,
      diferidoCents: 25_000,
    });
  });

  it('cada uso reconhece a sua unidade e reduz o diferido', async () => {
    const { id } = await noCatalogo();
    await comprar(id);
    await usar();
    await usar();

    expect(await receitaDePacotes(TENANT, HOJE, AGORA)).toEqual({
      vendidoCents: 25_000,
      reconhecidoCents: 10_000,
      diferidoCents: 15_000,
    });
  });

  it('o pacote vencido some do passivo — a obrigação acabou', async () => {
    // E some porque virou receita: a barbearia não deve mais nada. Mantê-lo
    // diferido para sempre encheria o balanço de um passivo que nunca sai.
    const { id } = await noCatalogo({ validadeDias: 30 });
    await comprar(id);
    await withTenant(TENANT, (tx) =>
      tx.$executeRaw`UPDATE customer_packages SET expires_at = '2026-10-01T12:00:00Z'`,
    );

    expect((await receitaDePacotes(TENANT, HOJE, AGORA)).diferidoCents).toBe(0);
  });

  // -- o reembolso -------------------------------------------------------------

  it('o reembolso devolve o proporcional, não o preço cheio', async () => {
    // Devolver o cheio pagaria de volta cortes já entregues; devolver nada
    // transformaria a compra antecipada em armadilha.
    const { id } = await noCatalogo();
    await comprar(id);
    await usar();
    await usar();

    const pacote = (await meus())[0]!;
    const devolvido = await reembolsarPacote({
      tenantId: TENANT,
      locationId: LOCATION, customerPackageId: pacote.id, ator, agora: AGORA,
    });
    expect(devolvido.valorCents).toBe(15_000);

    const razao = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ amount_cents: number; kind: string }[]>`
        SELECT amount_cents, kind::text AS kind FROM customer_ledger
      `,
    );
    expect(razao[0]).toMatchObject({ kind: 'credit', amount_cents: 15_000 });
  });

  it('não reembolsa duas vezes', async () => {
    const { id } = await noCatalogo();
    await comprar(id);
    const pacote = (await meus())[0]!;

    await reembolsarPacote({ tenantId: TENANT, locationId: LOCATION, customerPackageId: pacote.id, ator, agora: AGORA });
    await expect(
      reembolsarPacote({ tenantId: TENANT, locationId: LOCATION, customerPackageId: pacote.id, ator, agora: AGORA }),
    ).rejects.toMatchObject({ code: 'ja_reembolsado' });
  });

  it('pacote esgotado não devolve nada', async () => {
    const { id } = await noCatalogo({ quantidade: 2, precoCents: 10_000 });
    await comprar(id, 10_000);
    await usar();
    await usar();

    const pacote = (await meus())[0]!;
    await expect(
      reembolsarPacote({ tenantId: TENANT, locationId: LOCATION, customerPackageId: pacote.id, ator, agora: AGORA }),
    ).rejects.toMatchObject({ code: 'nada_a_devolver' });
  });

  it('o pacote reembolsado não some, e sai do consumo', async () => {
    const { id } = await noCatalogo();
    await comprar(id);
    const pacote = (await meus())[0]!;
    await reembolsarPacote({ tenantId: TENANT, locationId: LOCATION, customerPackageId: pacote.id, ator, agora: AGORA });

    expect((await meus())[0]).toMatchObject({ estado: 'reembolsado', reembolsadoCents: 25_000 });
    expect(
      await consumoDisponivel({
        tenantId: TENANT, customerId: CARLOS, serviceId: CORTE, agora: AGORA,
      }),
    ).toBeNull();
  });

  it('o reembolso de outra barbearia não alcança este pacote', async () => {
    const { id } = await noCatalogo();
    await comprar(id);
    const pacote = (await meus())[0]!;

    await expect(
      reembolsarPacote({
        tenantId: RIVAL,
        locationId: LOCATION,
        customerPackageId: pacote.id,
        ator,
        agora: AGORA,
      }),
    ).rejects.toBeInstanceOf(PacoteError);
  });

  it('a barbearia vizinha não enxerga os pacotes desta', async () => {
    const { id } = await noCatalogo();
    await comprar(id);
    expect(await pacotesDoCliente(RIVAL, CARLOS, AGORA)).toHaveLength(0);
  });

  // -- o que a revisão de segurança do bloco 42 achou ---------------------------

  it('o preço do pacote sai do catálogo, não do que a tela mandou', async () => {
    /**
     * Achado da `/security-review`. Com o preço do corpo, um item de R$ 1
     * fecharia a conta por um real e congelaria cinco unidades de R$ 50 — e o
     * reembolso proporcional as devolveria como crédito no razão. Dinheiro
     * criado do nada, e por fora do teto de desconto da casa.
     */
    const { id } = await noCatalogo();
    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
    });
    const comanda = await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id, tipo: 'package',
      descricao: '5 cortes', quantidade: 1, precoUnitarioCents: 100,
      packageId: id, ...operador,
    });

    expect(comanda.totalCents).toBe(25_000);
  });

  it('item de pacote sem pacote não entra na comanda', async () => {
    // Item que ninguém sabe o que vende: o fechamento não teria de onde derivar
    // a venda, e a conta cobraria por um pacote que nunca nasceu.
    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
    });
    await expect(
      adicionarItem({
        tenantId: TENANT, locationId: LOCATION, orderId: aberta.id, tipo: 'package',
        descricao: 'pacote fantasma', quantidade: 1, precoUnitarioCents: 25_000,
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'item_invalido' });
  });

  it('o pacote de corte não paga uma barba', async () => {
    /**
     * Achado da `/security-review`. Os valores batiam — R$ 50 de barba e R$ 50 de
     * unidade —, o domínio aceitava, e o cliente perdia um corte que pagou. A
     * receita ainda era reconhecida no serviço errado.
     */
    const { id } = await noCatalogo();
    await comprar(id);

    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id, tipo: 'service',
      serviceId: BARBA, descricao: 'Barba', quantidade: 1, precoUnitarioCents: 5000,
      professionalId: RUAN, ...operador,
    });

    await expect(
      fecharComanda({
        tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
        pagamentos: [{ forma: 'pacote', valorCents: 5000 }],
        servicoDoPacote: CORTE, ...fecha,
      }),
    ).rejects.toMatchObject({ code: 'pagamento_invalido' });
  });

  it('o banco recusa consumir mais unidades do que foram compradas', async () => {
    /**
     * Achado da `/security-review`: o índice único é por **comanda**, e duas
     * comandas diferentes do mesmo cliente fechando ao mesmo tempo liam
     * "usados = 4" as duas. A aplicação trava a linha, e isto aqui é a segunda
     * camada — a garantia de que ninguém recebe serviço que não pagou é grande
     * demais para morar só numa cláusula que uma reescrita pode perder.
     */
    const { id } = await noCatalogo({ quantidade: 2, precoCents: 10_000 });
    await comprar(id, 10_000);
    await usar();
    await usar();

    const pacote = (await meus())[0]!;
    await expect(
      withTenant(TENANT, (tx) =>
        tx.$executeRaw`
          INSERT INTO package_uses
            (tenant_id, customer_package_id, value_cents, business_day)
          VALUES (${TENANT}::uuid, ${pacote.id}::uuid, 5000, '2026-11-01'::date)
        `,
      ),
    ).rejects.toThrow();
  });


  // -- fidelidade e pacote, que se cruzam sem saber ---------------------------

  it('o pacote não gera cashback duas vezes', async () => {
    /**
     * A convenção é explícita: *"acúmulo sobre o que a pessoa **pagou de
     * verdade** — o que saiu do próprio saldo não gera saldo novo"*, e é a
     * frase que a SPEC §4.8 usa para nomear o laço do corte grátis que compra o
     * próximo corte grátis.
     *
     * O acúmulo desconta `fidelidade` da base e **não** desconta `pacote`. Mas
     * o pacote é receita já reconhecida e já premiada na venda: R$ 250 entram
     * uma vez, e o cashback é creditado na compra **e** em cada uso.
     */
    const pacote = (await noCatalogo()).id;
    await exec(`
      INSERT INTO loyalty_programs (tenant_id, mode, cashback_bps)
      VALUES ('${TENANT}', 'cashback', 500)
      ON CONFLICT (tenant_id) DO UPDATE SET mode = 'cashback', cashback_bps = 500
    `);

    await comprar(pacote);
    const naCompra = await saldoDoCliente(TENANT, CARLOS, AGORA);
    // 5% de R$ 250 — o crédito legítimo, sobre o dinheiro que entrou.
    expect(naCompra.saldo).toBe(1250);

    for (let i = 0; i < 5; i += 1) await usar();

    const depois = await saldoDoCliente(TENANT, CARLOS, AGORA);
    expect(
      depois.saldo,
      `o cashback dobrou: ${depois.saldo} sobre R$ 250 de receita, onde a casa configurou 5%`,
    ).toBe(1250);
  });

  it('o prêmio de visitas não paga a compra de um pacote', async () => {
    /**
     * "A cada dez cortes, um grátis" é um **corte**. O teto do resgate é
     * `comanda.totalCents`, e a decisão foi tomada quando a comanda só tinha
     * serviço — itens de pacote e de produto entraram nos blocos 42 e 44 sem
     * revisitá-lo.
     *
     * Com um pacote de R$ 250 na mesma comanda, o prêmio cobre a comanda
     * inteira: o cliente sai com cinco cortes pré-pagos que ninguém pagou, e
     * eles ainda são reembolsáveis proporcionalmente — virando crédito no razão
     * do fiado.
     */
    const pacote = (await noCatalogo()).id;
    await exec(`
      INSERT INTO loyalty_programs (tenant_id, mode, visits_goal)
      VALUES ('${TENANT}', 'visitas', 10)
      ON CONFLICT (tenant_id) DO UPDATE SET mode = 'visitas', visits_goal = 10
    `);
    await exec(`
      -- O motivo e obrigatorio por CHECK no ajuste manual, e a semente tem que
      -- satisfazer tudo menos a regra sob teste.
      INSERT INTO loyalty_entries (tenant_id, customer_id, kind, amount, mode, scope, note)
      VALUES ('${TENANT}', '${CARLOS}', 'ajuste', 10, 'visitas', 'empresa',
              'Cartao carimbado no papel, migrado a mao')
    `);

    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      tipo: 'service', serviceId: CORTE, descricao: 'Corte', quantidade: 1,
      precoUnitarioCents: 5000, professionalId: RUAN, ...operador,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      tipo: 'package', descricao: '5 cortes', quantidade: 1,
      precoUnitarioCents: 25_000, packageId: pacote, ...operador,
    });

    const fechar = fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      resgateQuantidade: 10,
      pagamentos: [{ forma: 'fidelidade', valorCents: 30_000 }],
      ...fecha,
    });

    await expect(
      fechar,
      'o prêmio de um corte pagou a venda de um pacote de R$ 250',
    ).rejects.toThrow();
  });
});
