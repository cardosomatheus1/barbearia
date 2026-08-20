import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { abrirCaixa } from './caixa.js';
import { abrirComanda, adicionarItem, fecharComanda } from './comanda.js';
import { preverConsumo } from '@barbearia/core';
import {
  cmvDoPeriodo,
  consumoMedido,
  custoDeInsumo,
  fichaDoServico,
  lancarMovimento,
  margemPorServico,
  movimentosDoProduto,
  produtos,
  salvarFicha,
  salvarProduto,
} from './estoque.js';

/**
 * Estoque contra Postgres real (bloco 44).
 *
 * O que só o banco prova: que o saldo é uma soma e não uma coluna, que o
 * movimento não se reescreve, que o estoque não fica negativo nem sob corrida,
 * e que a comanda baixa a prateleira na mesma transação em que cobra.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '44444444-1111-1111-1111-111111111111';
const RIVAL = '44444444-2222-2222-2222-222222222222';
const LOCAL = 'a4444444-0000-0000-0000-000000000001';
const CARLOS = 'c4444444-0000-0000-0000-000000000001';
const DONO = 'd4444444-0000-0000-0000-000000000001';
const RUAN = 'e4444444-0000-0000-0000-000000000001';
const CORTE = 'f4444444-0000-0000-0000-000000000001';
const BARBA = 'f4444444-0000-0000-0000-000000000002';

const HOJE = '2026-11-01';
const ator = { id: DONO, name: 'Matheus' };
const operador = { staffId: DONO, staffName: 'Matheus' };
const fecha = { ...operador, hojeNaUnidade: HOJE };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const novoProduto = (extra: Partial<Parameters<typeof salvarProduto>[0]> = {}) =>
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
    ...extra,
  });

const saldoDe = async (id: string) =>
  (await produtos(TENANT, true, new Date(), LOCAL)).find((p) => p.id === id)?.saldo ?? 0;

describeIfDb('estoque', () => {
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

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');

      INSERT INTO professionals (id, tenant_id, location_id, name)
      VALUES ('${RUAN}', '${TENANT}', '${LOCAL}', 'Ruan');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes) VALUES
        ('${CORTE}', '${TENANT}', 'Corte', 6000, 30),
        ('${BARBA}', '${TENANT}', 'Barba', 5500, 25);
    `);
    await abrirCaixa({
      tenantId: TENANT, locationId: LOCAL, openingCents: 10_000, ...operador,
    });
  });

  // -- o saldo é derivado ------------------------------------------------------

  it('produto novo nasce com saldo zero, e isso não é erro', async () => {
    const { id } = await novoProduto();
    expect(await saldoDe(id)).toBe(0);
  });

  it('o saldo é a soma dos movimentos, e o histórico responde por quê', async () => {
    /**
     * "Por que só tem 12 se eu comprei 20?" é a pergunta, e um contador
     * `estoque = 12` não a responde. O histórico é a resposta.
     */
    const { id } = await novoProduto();
    await lancarMovimento({
      tenantId: TENANT, produtoId: id, tipo: 'entrada', quantidade: 20, diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });
    await lancarMovimento({
      tenantId: TENANT, produtoId: id, tipo: 'perda', quantidade: 3,
      diaDaUnidade: HOJE, locationId: LOCAL, motivo: 'dois vidros quebraram na caixa', ator,
    });

    expect(await saldoDe(id)).toBe(17);
    const historico = await movimentosDoProduto(TENANT, id, LOCAL);
    expect(historico).toHaveLength(2);
    expect(historico[0]).toMatchObject({ tipo: 'perda', quantidade: -3, quem: 'Matheus' });
  });

  it('o estoque não fica negativo', async () => {
    // Um estoque em −3 significa que alguém vendeu o que não existe, e o número
    // contamina o CMV do mês inteiro.
    const { id } = await novoProduto();
    await lancarMovimento({
      tenantId: TENANT, produtoId: id, tipo: 'entrada', quantidade: 2, diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });
    await expect(
      lancarMovimento({
        tenantId: TENANT, produtoId: id, tipo: 'saida', quantidade: 5, diaDaUnidade: HOJE, locationId: LOCAL, ator,
      }),
    ).rejects.toMatchObject({ code: 'saldo_insuficiente' });
  });

  it('perda sem motivo escrito é recusada', async () => {
    const { id } = await novoProduto();
    await lancarMovimento({
      tenantId: TENANT, produtoId: id, tipo: 'entrada', quantidade: 5, diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });
    await expect(
      lancarMovimento({
        tenantId: TENANT, produtoId: id, tipo: 'perda', quantidade: 1, diaDaUnidade: HOJE, locationId: LOCAL, ator,
      }),
    ).rejects.toMatchObject({ code: 'motivo_obrigatorio' });
  });

  it('o movimento é append-only: a aplicação não reescreve nem apaga', async () => {
    const { id } = await novoProduto();
    await lancarMovimento({
      tenantId: TENANT, produtoId: id, tipo: 'entrada', quantidade: 5, diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });

    await expect(
      withTenant(TENANT, (tx) => tx.$executeRaw`UPDATE stock_movements SET quantity = 999`),
    ).rejects.toThrow();
    await expect(
      withTenant(TENANT, (tx) => tx.$executeRaw`DELETE FROM stock_movements`),
    ).rejects.toThrow();
  });

  it('perda e ajuste deixam trilha; entrada não', async () => {
    /**
     * As duas primeiras mudam o número sem nota fiscal nem venda. Auditar toda
     * reposição encheria a trilha do que ninguém procura — que é como uma
     * trilha deixa de ser lida.
     */
    const { id } = await novoProduto();
    await lancarMovimento({
      tenantId: TENANT, produtoId: id, tipo: 'entrada', quantidade: 10, diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });
    await lancarMovimento({
      tenantId: TENANT, produtoId: id, tipo: 'perda', quantidade: 1,
      diaDaUnidade: HOJE, locationId: LOCAL, motivo: 'vidro quebrado', ator,
    });

    const trilha = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM audit_log WHERE action = 'stock.adjusted'
      `,
    );
    expect(Number(trilha[0]!.n)).toBe(1);
  });

  // -- o cadastro --------------------------------------------------------------

  it('revenda exige preço; uso interno não tem preço', async () => {
    /**
     * Revenda sem preço aparece na busca da comanda e entra por zero — uma
     * venda que não entra no caixa e some do CMV. Interno com preço é um número
     * que ninguém cobra.
     */
    await expect(
      novoProduto({ tipo: 'resale', precoCents: null }),
    ).rejects.toMatchObject({ code: 'produto_invalido' });

    const { id } = await novoProduto({ nome: 'Shampoo', tipo: 'internal', precoCents: 900 });
    const shampoo = (await produtos(TENANT, true, new Date(), LOCAL)).find((p) => p.id === id);
    expect(shampoo?.precoCents).toBeNull();
  });

  it('a vizinha não vê o estoque desta casa', async () => {
    await novoProduto();
    expect(await produtos(RIVAL, true, new Date(), LOCAL)).toEqual([]);
  });

  // -- a ficha técnica ---------------------------------------------------------

  it('a ficha soma o custo de insumo do serviço', async () => {
    const oleo = await novoProduto({
      nome: 'Óleo pré-barba', tipo: 'internal', precoCents: null, custoCents: 20, unidade: 'ml',
    });
    const lamina = await novoProduto({
      nome: 'Lâmina', tipo: 'internal', precoCents: null, custoCents: 140,
    });

    await salvarFicha({
      tenantId: TENANT,
      serviceId: BARBA,
      itens: [
        { produtoId: oleo.id, quantidade: 5 },
        { produtoId: lamina.id, quantidade: 1 },
      ],
      ator,
    });

    expect(await custoDeInsumo(TENANT, BARBA)).toBe(240);
    expect(await fichaDoServico(TENANT, BARBA)).toHaveLength(2);
  });

  it('produto de revenda não entra na ficha técnica', async () => {
    /**
     * Pendurar uma pomada de revenda na ficha faria o serviço baixar do estoque
     * de venda sem ninguém ter comprado nada.
     */
    const pomada = await novoProduto();
    await expect(
      salvarFicha({
        tenantId: TENANT, serviceId: BARBA, itens: [{ produtoId: pomada.id, quantidade: 1 }], ator,
      }),
    ).rejects.toMatchObject({ code: 'produto_nao_encontrado' });
  });

  it('a ficha não aceita produto de outra barbearia', async () => {
    // A checagem de integridade referencial do Postgres ignora row security: a
    // chave estrangeira aceitaria o id.
    const alheio = await salvarProduto({
      tenantId: RIVAL, nome: 'Shampoo da vizinha', tipo: 'internal', custoCents: 100,
      precoCents: null, minimo: 0, unidade: 'ml', ativo: true,
      ator: { id: DONO, name: 'x' },
    });
    await expect(
      salvarFicha({
        tenantId: TENANT, serviceId: BARBA, itens: [{ produtoId: alheio.id, quantidade: 1 }], ator,
      }),
    ).rejects.toMatchObject({ code: 'produto_nao_encontrado' });
  });

  it('salvar a ficha substitui a anterior inteira', async () => {
    const a = await novoProduto({ nome: 'Talco', tipo: 'internal', precoCents: null, custoCents: 10 });
    const b = await novoProduto({ nome: 'Cera', tipo: 'internal', precoCents: null, custoCents: 20 });

    await salvarFicha({ tenantId: TENANT, serviceId: CORTE, itens: [{ produtoId: a.id, quantidade: 1 }], ator });
    await salvarFicha({ tenantId: TENANT, serviceId: CORTE, itens: [{ produtoId: b.id, quantidade: 2 }], ator });

    const ficha = await fichaDoServico(TENANT, CORTE);
    expect(ficha).toHaveLength(1);
    expect(ficha[0]).toMatchObject({ nome: 'Cera', quantidade: 2 });
  });

  // -- a comanda baixa a prateleira --------------------------------------------

  it('vender um produto baixa o estoque na mesma transação', async () => {
    const { id } = await novoProduto();
    await lancarMovimento({
      tenantId: TENANT, produtoId: id, tipo: 'entrada', quantidade: 10, diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });

    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCAL, customerId: CARLOS, staffId: DONO,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'product',
      descricao: 'Pomada', quantidade: 2, precoUnitarioCents: 0, productId: id, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: 7000 }], ...fecha,
    });

    expect(await saldoDe(id)).toBe(8);
  });

  it('o preço do produto sai do catálogo, não do que a tela mandou', async () => {
    /**
     * Aceitar o preço do corpo faria a pomada de R$ 35 ser vendida por R$ 1 com
     * o estoque baixando um vidro de verdade — desconto sem passar pelo teto da
     * casa, e CMV negativo no relatório.
     */
    const { id } = await novoProduto();
    await lancarMovimento({
      tenantId: TENANT, produtoId: id, tipo: 'entrada', quantidade: 10, diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });

    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCAL, customerId: CARLOS, staffId: DONO,
    });
    const comanda = await adicionarItem({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'product',
      descricao: 'Pomada', quantidade: 1, precoUnitarioCents: 100, productId: id, ...operador,
    });
    expect(comanda.totalCents).toBe(3500);
  });

  it('atender o serviço consome a ficha técnica', async () => {
    const shampoo = await novoProduto({
      nome: 'Shampoo', tipo: 'internal', precoCents: null, custoCents: 50, unidade: 'ml',
    });
    await lancarMovimento({
      tenantId: TENANT, produtoId: shampoo.id, tipo: 'entrada', quantidade: 100,
      diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });
    await salvarFicha({
      tenantId: TENANT, serviceId: CORTE, itens: [{ produtoId: shampoo.id, quantidade: 10 }], ator,
    });

    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCAL, customerId: CARLOS, staffId: DONO,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 1, precoUnitarioCents: 6000,
      professionalId: RUAN, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: 6000 }], ...fecha,
    });

    expect(await saldoDe(shampoo.id)).toBe(90);
  });

  it('shampoo mal contado não impede o cliente de pagar', async () => {
    /**
     * O cliente já foi atendido e já vai pagar. Recusar a comanda por causa de
     * um insumo mal contado seria o sistema impedindo a venda para proteger um
     * número — e o balcão aprenderia a não usar a ficha técnica.
     */
    const shampoo = await novoProduto({
      nome: 'Shampoo', tipo: 'internal', precoCents: null, custoCents: 50, unidade: 'ml',
    });
    await salvarFicha({
      tenantId: TENANT, serviceId: CORTE, itens: [{ produtoId: shampoo.id, quantidade: 10 }], ator,
    });

    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCAL, customerId: CARLOS, staffId: DONO,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 1, precoUnitarioCents: 6000,
      professionalId: RUAN, ...operador,
    });

    const paga = await fecharComanda({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: 6000 }], ...fecha,
    });

    expect(paga.status).toBe('paid');
    // E o estoque continua em zero: a falta vira ausência de movimento, e a
    // contagem do dia acusa.
    expect(await saldoDe(shampoo.id)).toBe(0);
  });

  // -- CMV e margem ------------------------------------------------------------

  it('o CMV do período separa venda, consumo e perda', async () => {
    const pomada = await novoProduto();
    await lancarMovimento({
      tenantId: TENANT, produtoId: pomada.id, tipo: 'entrada', quantidade: 10,
      diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });
    await lancarMovimento({
      tenantId: TENANT, produtoId: pomada.id, tipo: 'perda', quantidade: 2,
      diaDaUnidade: HOJE, locationId: LOCAL, motivo: 'caixa amassada na entrega', ator,
    });

    const cmv = await cmvDoPeriodo(TENANT, HOJE, HOJE, LOCAL);
    expect(cmv.perdaCents).toBe(2400);
    expect(cmv.vendaCents).toBe(0);
  });

  it('a margem de contribuição desconta comissão, insumo e taxa', async () => {
    /**
     * É a decomposição da SPEC §3.8 — os três custos já existiam separados no
     * produto e nunca tinham sido somados.
     */
    await exec(`
      INSERT INTO commission_rules (tenant_id, professional_id, mode, value)
      VALUES ('${TENANT}', '${RUAN}', 'percent', 4000);
    `);

    const shampoo = await novoProduto({
      nome: 'Shampoo', tipo: 'internal', precoCents: null, custoCents: 30, unidade: 'ml',
    });
    await lancarMovimento({
      tenantId: TENANT, produtoId: shampoo.id, tipo: 'entrada', quantidade: 100,
      diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });
    await salvarFicha({
      tenantId: TENANT, serviceId: CORTE, itens: [{ produtoId: shampoo.id, quantidade: 10 }], ator,
    });

    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCAL, customerId: CARLOS, staffId: DONO,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 1, precoUnitarioCents: 6000,
      professionalId: RUAN, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: 6000 }], ...fecha,
    });

    const margens = await margemPorServico(TENANT, HOJE, HOJE, LOCAL);
    const corte = margens.find((m) => m.serviceId === CORTE);

    expect(corte).toMatchObject({
      vezes: 1,
      precoCents: 6000,
      comissaoCents: 2400,
      insumosCents: 300,
    });
    // Dinheiro: R$ 60 − R$ 24 de comissão − R$ 3 de insumo. Sem taxa: pagou em
    // espécie, e a maquininha não cobrou nada.
    expect(corte?.margemCents).toBe(3300);
  });

  it('o insumo é contado uma vez por atendimento, não uma vez por serviço', async () => {
    /**
     * Dois cortes no período consomem duas fichas. A conta que somasse a ficha
     * uma vez só faria o segundo corte parecer mais rentável que o primeiro.
     */
    const shampoo = await novoProduto({
      nome: 'Shampoo', tipo: 'internal', precoCents: null, custoCents: 30, unidade: 'ml',
    });
    await lancarMovimento({
      tenantId: TENANT, produtoId: shampoo.id, tipo: 'entrada', quantidade: 100,
      diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });
    await salvarFicha({
      tenantId: TENANT, serviceId: CORTE, itens: [{ produtoId: shampoo.id, quantidade: 10 }], ator,
    });

    for (const _ of [1, 2]) {
      const aberta = await abrirComanda({
        tenantId: TENANT, locationId: LOCAL, customerId: CARLOS, staffId: DONO,
      });
      await adicionarItem({
        tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'service',
        serviceId: CORTE, descricao: 'Corte', quantidade: 1, precoUnitarioCents: 6000,
        professionalId: RUAN, ...operador,
      });
      await fecharComanda({
        tenantId: TENANT, locationId: LOCAL, orderId: aberta.id,
        pagamentos: [{ forma: 'cash', valorCents: 6000 }], ...fecha,
      });
    }

    const corte = (await margemPorServico(TENANT, HOJE, HOJE, LOCAL)).find((m) => m.serviceId === CORTE);
    expect(corte?.vezes).toBe(2);
    expect(corte?.insumosCents).toBe(600);
  });

  // -- o que a revisão de segurança do bloco 44 achou ---------------------------

  it('vender um produto sem entrada registrada não impede o cliente de pagar', async () => {
    /**
     * Achado mais caro da `/security-review`. Deixar a exceção subir aqui
     * reintroduziria o defeito que o bloco 35 já pagou para aprender:
     * `fecharComanda` roda dentro da transação do webhook do Pix, e uma exceção
     * ali volta atrás com o **dinheiro sem registro nenhum** — com o adquirente
     * reentregando por dias e a varredura parando no meio do laço.
     *
     * E o gatilho é certo: o produto saiu da prateleira, o cliente está indo
     * embora com ele. O que falta é a entrada que ninguém registrou.
     */
    const { id } = await novoProduto();

    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCAL, customerId: CARLOS, staffId: DONO,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'product',
      descricao: 'Pomada', quantidade: 1, precoUnitarioCents: 0, productId: id, ...operador,
    });

    const paga = await fecharComanda({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: 3500 }], ...fecha,
    });

    expect(paga.status).toBe('paid');
    expect(await saldoDe(id)).toBe(0);
  });

  it('dois cortes na mesma comanda consomem duas fichas', async () => {
    /**
     * Achado da `/security-review`: a primeira versão usava `= ANY(...)`, que é
     * teste de pertinência — uma comanda com dois cortes consumia **uma** ficha,
     * e a prateleira ficava com um shampoo a mais que o sistema.
     */
    const shampoo = await novoProduto({
      nome: 'Shampoo', tipo: 'internal', precoCents: null, custoCents: 30, unidade: 'ml',
    });
    await lancarMovimento({
      tenantId: TENANT, produtoId: shampoo.id, tipo: 'entrada', quantidade: 100,
      diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });
    await salvarFicha({
      tenantId: TENANT, serviceId: CORTE, itens: [{ produtoId: shampoo.id, quantidade: 10 }], ator,
    });

    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCAL, customerId: CARLOS, staffId: DONO,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 2, precoUnitarioCents: 6000,
      professionalId: RUAN, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: 12_000 }], ...fecha,
    });

    expect(await saldoDe(shampoo.id)).toBe(80);
  });

  it('mudar o custo do insumo hoje não mexe na margem de ontem', async () => {
    /**
     * Achado da `/security-review`. A primeira versão multiplicava a ficha pelo
     * `products.cost_cents` **de hoje**: subir o preço do shampoo em março
     * mudava a margem de janeiro, e refazer a ficha reescrevia o custo de todo
     * atendimento passado — inclusive de períodos de comissão já fechados.
     */
    const shampoo = await novoProduto({
      nome: 'Shampoo', tipo: 'internal', precoCents: null, custoCents: 30, unidade: 'ml',
    });
    await lancarMovimento({
      tenantId: TENANT, produtoId: shampoo.id, tipo: 'entrada', quantidade: 100,
      diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });
    await salvarFicha({
      tenantId: TENANT, serviceId: CORTE, itens: [{ produtoId: shampoo.id, quantidade: 10 }], ator,
    });

    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCAL, customerId: CARLOS, staffId: DONO,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id, tipo: 'service',
      serviceId: CORTE, descricao: 'Corte', quantidade: 1, precoUnitarioCents: 6000,
      professionalId: RUAN, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: LOCAL, orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: 6000 }], ...fecha,
    });

    const antes = (await margemPorServico(TENANT, HOJE, HOJE, LOCAL)).find((m) => m.serviceId === CORTE);
    expect(antes?.insumosCents).toBe(300);

    // O fornecedor dobra o preço, e a barbearia atualiza o cadastro.
    await salvarProduto({
      tenantId: TENANT, id: shampoo.id, nome: 'Shampoo', tipo: 'internal',
      custoCents: 60, precoCents: null, minimo: 0, unidade: 'ml', ativo: true, ator,
    });
    // E a ficha inteira muda.
    await salvarFicha({ tenantId: TENANT, serviceId: CORTE, itens: [], ator });

    const depois = (await margemPorServico(TENANT, HOJE, HOJE, LOCAL)).find((m) => m.serviceId === CORTE);
    expect(depois?.insumosCents).toBe(300);
    expect(depois?.margemCents).toBe(antes?.margemCents);
  });

  // -- previsão de consumo (bloco 69, SPEC §4.19) -----------------------------

  const AGORA = new Date('2026-11-01T12:00:00Z');

  /** Uma saída de `quantidade` unidades a `semanasAtras` semanas. */
  async function saida(
    produtoId: string,
    tipo: 'venda' | 'consumo' | 'perda' | 'ajuste',
    quantidade: number,
    semanasAtras: number,
  ): Promise<void> {
    await lancarMovimento({
      tenantId: TENANT,
      produtoId,
      tipo,
      quantidade: tipo === 'ajuste' ? -quantidade : quantidade,
      diaDaUnidade: HOJE,
      locationId: LOCAL,
      ...(tipo === 'perda' || tipo === 'ajuste' ? { motivo: 'semente da previsão' } : {}),
      ator,
    });
    /**
     * O carimbo é ancorado em `AGORA`, não no relógio real.
     *
     * O movimento nasce com `now()`, e a janela que a consulta recorta parte do
     * `agora` que o teste passa — que é uma data fixa de 2026. Recuar semanas a
     * partir do relógio real deixa toda a semente **fora** da janela, e a
     * primeira versão deste teste media zero achando que media consumo.
     *
     * E o recorte é uma janela de um minuto **em volta** do relógio real, não
     * "o mais recente": os já carimbados ficam a semanas de distância — no
     * futuro, porque `AGORA` é 2026-11 e o relógio real não —, então ordenar por
     * data pegava um deles em vez do novo, e as três semanas distintas viravam
     * uma. O teste media uma coisa e afirmava outra.
     */
    await exec(
      `UPDATE stock_movements
          SET created_at = timestamptz '${AGORA.toISOString()}' - interval '${semanasAtras} weeks'
        WHERE product_id = '${produtoId}'
          AND created_at > now() - interval '1 minute'
          AND created_at < now() + interval '1 minute'`,
    );
  }

  it('o consumo sai das saídas, e o ajuste não conta', async () => {
    /**
     * `ajuste` é correção de contagem — a linha que aparece quando alguém
     * recontou e achou menos. Somá-lo faria o erro de inventário virar demanda,
     * e a sugestão mandaria comprar o que nunca foi usado.
     */
    const { id } = await novoProduto();
    await lancarMovimento({
      tenantId: TENANT, produtoId: id, tipo: 'entrada', quantidade: 100,
      diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });
    await saida(id, 'venda', 7, 1);
    await saida(id, 'consumo', 7, 2);
    await saida(id, 'perda', 7, 3);
    await saida(id, 'ajuste', 50, 4);

    const [medido] = await consumoMedido({ tenantId: TENANT, agora: AGORA });
    expect(medido?.saidasNaJanela).toBe(21);
    expect(medido?.semanasComSaida).toBe(3);
  });

  it('saída de antes da janela não conta', async () => {
    // Oito semanas, o mesmo número do heatmap: dois lugares do produto dizendo
    // "as últimas semanas" sobre janelas diferentes é a mesma pergunta com duas
    // respostas.
    const { id } = await novoProduto();
    await lancarMovimento({
      tenantId: TENANT, produtoId: id, tipo: 'entrada', quantidade: 100,
      diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });
    await saida(id, 'venda', 5, 2);
    await saida(id, 'venda', 5, 12);

    const [medido] = await consumoMedido({ tenantId: TENANT, agora: AGORA });
    expect(medido?.saidasNaJanela).toBe(5);
  });

  it('produto sem saída devolve zero, e a previsão devolve nulo', async () => {
    // "Não dá para dizer" é diferente de "nunca acaba", e o `null` vem de `core`.
    const { id } = await novoProduto();
    await lancarMovimento({
      tenantId: TENANT, produtoId: id, tipo: 'entrada', quantidade: 10,
      diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });

    const [medido] = await consumoMedido({ tenantId: TENANT, agora: AGORA });
    expect(medido?.saidasNaJanela).toBe(0);
    expect(preverConsumo(medido!).diasAteAcabar).toBeNull();
  });

  it('o consumo da barbearia vizinha não entra no desta', async () => {
    const { id } = await novoProduto();
    await lancarMovimento({
      tenantId: TENANT, produtoId: id, tipo: 'entrada', quantidade: 50,
      diaDaUnidade: HOJE, locationId: LOCAL, ator,
    });
    await saida(id, 'venda', 4, 1);

    const daVizinha = await consumoMedido({ tenantId: RIVAL, agora: AGORA });
    expect(daVizinha.every((c) => c.saidasNaJanela === 0)).toBe(true);
  });
});
