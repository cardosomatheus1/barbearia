import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { abrirCaixa, caixaAberto } from './caixa.js';
import {
  FinanceiroError,
  agendaDoFinanceiro,
  cancelarContaDoFinanceiro,
  categoriasFinanceiras,
  contasFinanceiras,
  criarCategoriaFinanceira,
  criarContaDoFinanceiro,
  criarContaFinanceira,
  definirLimiteDeFiado,
  lancarSaldoInicialDeFiado,
  quitarContaDoFinanceiro,
  transferenciasRecentes,
  transferirEntreContas,
} from './financeiro.js';

/**
 * Financeiro contra Postgres real (bloco 51, SPEC §3.10).
 *
 * O que só o banco prova: que a conta paga pela gaveta e o movimento de caixa
 * nascem na mesma transação, que o id de categoria vindo do corpo não atravessa
 * a fronteira do tenant, e que o limite de fiado passa a existir — a venda fiada
 * que o bloco 18 recusava por estourar zero.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '51515151-1111-1111-1111-111111111111';
const RIVAL = '51515151-2222-2222-2222-222222222222';
const LOCATION = 'a1515151-0000-0000-0000-000000000001';
const RIVAL_LOCATION = 'a1515151-0000-0000-0000-000000000002';
const CARLOS = 'c1515151-0000-0000-0000-000000000001';
const STAFF = 'f1515151-0000-0000-0000-000000000001';
const CATEGORIA_RIVAL = 'd1515151-0000-0000-0000-000000000009';

const HOJE = '2026-11-10';
const operador = { staffId: STAFF, staffName: 'Maria Recepção' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('financeiro', () => {
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

      INSERT INTO locations (id, tenant_id, name, timezone) VALUES
        ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia'),
        ('${RIVAL_LOCATION}', '${RIVAL}', 'Deles', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Maria', 'maria@domari.com.br', 'x', 'receptionist');

      INSERT INTO financial_categories (id, tenant_id, name, direction)
      VALUES ('${CATEGORIA_RIVAL}', '${RIVAL}', 'Aluguel deles', 'pagar');
    `);
  });

  const conta = (extra: Record<string, unknown> = {}) =>
    criarContaDoFinanceiro({
      tenantId: TENANT,
      locationId: LOCATION,
      direcao: 'pagar',
      descricao: 'Distribuidora São Paulo',
      valorCents: 48_000,
      vencimentoEm: '2026-11-15',
      ...operador,
      ...extra,
    });

  // -------------------------------------------------------------------------
  // A agenda
  // -------------------------------------------------------------------------

  it('a agenda soma o aberto, separa o vencido e projeta o saldo', async () => {
    await conta({ valorCents: 48_000, vencimentoEm: '2026-11-15' });
    await conta({ valorCents: 30_000, vencimentoEm: '2026-11-01' });
    await conta({ direcao: 'receber', descricao: 'Aluguel da cadeira', valorCents: 90_000 });

    const agenda = await agendaDoFinanceiro({
      tenantId: TENANT,
      locationId: LOCATION,
      hoje: HOJE,
    });

    expect(agenda.resumo.aPagarCents).toBe(78_000);
    expect(agenda.resumo.aReceberCents).toBe(90_000);
    expect(agenda.resumo.vencidoAPagarCents).toBe(30_000);
    expect(agenda.resumo.saldoProjetadoCents).toBe(12_000);
    expect(agenda.contas.find((c) => c.valorCents === 30_000)?.prazo)
      .toBe('Venceu há 9 dias');
  });

  it('a conta de outra barbearia não aparece na agenda desta', async () => {
    /**
     * Nenhuma consulta deste arquivo repete `tenant_id` no `WHERE`: quem filtra
     * é a política. Este teste é o que prova que ela está mesmo filtrando.
     */
    await exec(`
      INSERT INTO bills (tenant_id, location_id, direction, description,
                         amount_cents, due_on, created_by_name)
      VALUES ('${RIVAL}', '${RIVAL_LOCATION}', 'pagar', 'Aluguel deles',
              999_00, current_date, 'Outro');
    `);

    const agenda = await agendaDoFinanceiro({
      tenantId: TENANT,
      locationId: RIVAL_LOCATION,
      hoje: HOJE,
    });
    expect(agenda.contas).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Classificação
  // -------------------------------------------------------------------------

  it('a categoria de outra barbearia é recusada, apesar da chave estrangeira aceitar', async () => {
    /**
     * A checagem de integridade referencial do Postgres **ignora row security**:
     * sem o `SELECT` sob a política antes de gravar, a chave estrangeira
     * aceitaria classificar a despesa desta barbearia com a categoria da
     * vizinha — e o DRE do bloco 52 agruparia por uma etiqueta que esta casa não
     * consegue nem ler.
     */
    await expect(conta({ categoriaId: CATEGORIA_RIVAL })).rejects.toMatchObject({
      code: 'categoria_invalida',
    });
  });

  it('categoria de receita não classifica despesa', async () => {
    // A direção trocada entra no DRE com o sinal invertido, e nada fica vermelho
    // até o resultado do mês estar errado.
    const receita = await criarCategoriaFinanceira({
      tenantId: TENANT,
      nome: 'Aluguel de cadeira',
      direcao: 'receber',
    });
    await expect(conta({ categoriaId: receita.id })).rejects.toMatchObject({
      code: 'direcao_incompativel',
    });
  });

  it('duas categorias com o mesmo nome e a mesma direção são erro de digitação', async () => {
    await criarCategoriaFinanceira({ tenantId: TENANT, nome: 'Produtos', direcao: 'pagar' });
    await expect(
      criarCategoriaFinanceira({ tenantId: TENANT, nome: '  produtos ', direcao: 'pagar' }),
    ).rejects.toMatchObject({ code: 'nome_repetido' });

    // A mesma palavra do outro lado é outra coisa, e passa.
    await criarCategoriaFinanceira({ tenantId: TENANT, nome: 'Produtos', direcao: 'receber' });
    expect(await categoriasFinanceiras(TENANT)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Quitação e conciliação
  // -------------------------------------------------------------------------

  it('quitar pela gaveta grava a conta e o movimento de caixa juntos', async () => {
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 100_000, ...operador });
    const criada = await conta({ valorCents: 48_000 });

    await quitarContaDoFinanceiro({
      tenantId: TENANT,
      locationId: LOCATION,
      contaId: criada.id,
      valorPagoCents: 46_000,
      pagaEm: HOJE,
      pelaGaveta: true,
      ...operador,
    });

    const caixa = await caixaAberto(TENANT, LOCATION);
    const saida = caixa?.movimentos.find((m) => m.kind === 'bill_payment');
    expect(saida?.amountCents).toBe(-46_000);
    // O esperado do fechamento enxerga o dinheiro que saiu: sem isso a
    // conferência do dia acusa falta e alguém procura ladrão onde houve
    // pagamento.
    expect(caixa?.esperadoAgoraCents).toBe(54_000);

    const agenda = await agendaDoFinanceiro({
      tenantId: TENANT,
      locationId: LOCATION,
      hoje: HOJE,
      incluirFechadas: true,
    });
    const paga = agenda.contas.find((c) => c.id === criada.id);
    expect(paga?.estado).toBe('paga');
    expect(paga?.valorPagoCents).toBe(46_000);
    expect(paga?.pagaPelaGaveta).toBe(true);
  });

  it('quitar sem caixa aberto pela gaveta é recusado', async () => {
    // Desde o bloco 18 nada entra nem sai da gaveta sem sessão: a divergência do
    // fechamento precisa ter dono.
    const criada = await conta();
    await expect(
      quitarContaDoFinanceiro({
        tenantId: TENANT,
        locationId: LOCATION,
        contaId: criada.id,
        valorPagoCents: 48_000,
        pagaEm: HOJE,
        pelaGaveta: true,
        ...operador,
      }),
    ).rejects.toBeInstanceOf(FinanceiroError);
  });

  it('pagar por fora da gaveta não mexe no caixa', async () => {
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 100_000, ...operador });
    const criada = await conta();
    await quitarContaDoFinanceiro({
      tenantId: TENANT,
      locationId: LOCATION,
      contaId: criada.id,
      valorPagoCents: 48_000,
      pagaEm: HOJE,
      pelaGaveta: false,
      ...operador,
    });
    const caixa = await caixaAberto(TENANT, LOCATION);
    expect(caixa?.esperadoAgoraCents).toBe(100_000);
  });

  it('não se tira da gaveta mais do que há nela', async () => {
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 10_000, ...operador });
    const criada = await conta({ valorCents: 48_000 });
    await expect(
      quitarContaDoFinanceiro({
        tenantId: TENANT,
        locationId: LOCATION,
        contaId: criada.id,
        valorPagoCents: 48_000,
        pagaEm: HOJE,
        pelaGaveta: true,
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'valor_pago_invalido' });
  });

  it('quitar duas vezes não paga duas vezes', async () => {
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 200_000, ...operador });
    const criada = await conta();
    const quitar = () =>
      quitarContaDoFinanceiro({
        tenantId: TENANT,
        locationId: LOCATION,
        contaId: criada.id,
        valorPagoCents: 48_000,
        pagaEm: HOJE,
        pelaGaveta: true,
        ...operador,
      });

    await quitar();
    await expect(quitar()).rejects.toMatchObject({ code: 'conta_nao_aberta' });

    const caixa = await caixaAberto(TENANT, LOCATION);
    expect(caixa?.movimentos.filter((m) => m.kind === 'bill_payment')).toHaveLength(1);
  });

  it('a conta de outra barbearia não é quitável nem cancelável por esta', async () => {
    await exec(`
      INSERT INTO bills (id, tenant_id, location_id, direction, description,
                         amount_cents, due_on, created_by_name)
      VALUES ('b1515151-0000-0000-0000-000000000001', '${RIVAL}', '${RIVAL_LOCATION}',
              'pagar', 'Aluguel deles', 999_00, current_date, 'Outro');
    `);
    await expect(
      quitarContaDoFinanceiro({
        tenantId: TENANT,
        locationId: RIVAL_LOCATION,
        contaId: 'b1515151-0000-0000-0000-000000000001',
        valorPagoCents: 100,
        pagaEm: HOJE,
        pelaGaveta: false,
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'conta_nao_encontrada' });
  });

  it('cancelar exige motivo escrito e tira a conta do total', async () => {
    const criada = await conta();
    await expect(
      cancelarContaDoFinanceiro({
        tenantId: TENANT,
        locationId: LOCATION,
        contaId: criada.id,
        motivo: ' ',
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'motivo_obrigatorio' });

    await cancelarContaDoFinanceiro({
      tenantId: TENANT,
      locationId: LOCATION,
      contaId: criada.id,
      motivo: 'Nota lançada em duplicidade',
      ...operador,
    });

    const agenda = await agendaDoFinanceiro({
      tenantId: TENANT,
      locationId: LOCATION,
      hoje: HOJE,
    });
    expect(agenda.resumo.aPagarCents).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Transferência
  // -------------------------------------------------------------------------

  it('tirar da gaveta para o banco vira sangria e chega em algum lugar', async () => {
    /**
     * É o buraco que este bloco fecha: até aqui a sangria era uma saída que
     * sumia. Agora o dinheiro sai da gaveta **e** entra na conta do banco, com
     * as duas pontas na mesma linha.
     */
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 100_000, ...operador });
    const gaveta = await criarContaFinanceira({
      autorizadas: [],
      tenantId: TENANT,
      nome: 'Gaveta da Matriz',
      locationId: LOCATION,
      ehGaveta: true,
    });
    const banco = await criarContaFinanceira({ autorizadas: [], tenantId: TENANT, nome: 'Banco do Brasil' });

    await transferirEntreContas({
      tenantId: TENANT,
      locationId: LOCATION,
      deContaId: gaveta.id,
      paraContaId: banco.id,
      valorCents: 70_000,
      quandoEm: HOJE,
      ...operador,
    });

    const caixa = await caixaAberto(TENANT, LOCATION);
    expect(caixa?.esperadoAgoraCents).toBe(30_000);

    const lista = await transferenciasRecentes({ tenantId: TENANT, locationId: LOCATION });
    expect(lista[0]?.deNome).toBe('Gaveta da Matriz');
    expect(lista[0]?.paraNome).toBe('Banco do Brasil');
    expect(lista[0]?.valorCents).toBe(70_000);
  });

  it('transferir para a conta de outra barbearia é recusado', async () => {
    /**
     * A contagem tem que bater com o pedido: somar uma conta legítima com uma de
     * fora daria uma linha só, e um `length > 0` deixaria o dinheiro sair do
     * tenant. É a lição do bloco 39, e ela é o motivo de a conferência ser por
     * contagem e não por existência.
     */
    await exec(`
      INSERT INTO financial_accounts (id, tenant_id, name)
      VALUES ('a5151515-0000-0000-0000-000000000009', '${RIVAL}', 'Banco deles');
    `);
    const minha = await criarContaFinanceira({ autorizadas: [], tenantId: TENANT, nome: 'Cofre' });

    await expect(
      transferirEntreContas({
        tenantId: TENANT,
        locationId: LOCATION,
        deContaId: minha.id,
        paraContaId: 'a5151515-0000-0000-0000-000000000009',
        valorCents: 1000,
        quandoEm: HOJE,
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'conta_bancaria_invalida' });
  });

  it('o dinheiro que entra na gaveta aparece no fechamento', async () => {
    /**
     * Achado da revisão de segurança deste bloco: a primeira versão só
     * registrava a saída. Depositar **na** gaveta entrava na lista de
     * transferências e sumia do caixa — e a conferência do dia acusaria sobra
     * que ninguém explica, que é o espelho exato do defeito que o bloco existe
     * para consertar.
     */
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 10_000, ...operador });
    const gaveta = await criarContaFinanceira({
      autorizadas: [],
      tenantId: TENANT,
      nome: 'Gaveta da Matriz',
      locationId: LOCATION,
      ehGaveta: true,
    });
    const cofre = await criarContaFinanceira({ autorizadas: [], tenantId: TENANT, nome: 'Cofre' });

    await transferirEntreContas({
      tenantId: TENANT,
      locationId: LOCATION,
      deContaId: cofre.id,
      paraContaId: gaveta.id,
      valorCents: 50_000,
      quandoEm: HOJE,
      ...operador,
    });

    const caixa = await caixaAberto(TENANT, LOCATION);
    expect(caixa?.esperadoAgoraCents).toBe(60_000);
    expect(caixa?.movimentos.some((m) => m.kind === 'supply')).toBe(true);
  });

  it('o segundo toque com a mesma chave devolve a mesma transferência', async () => {
    /**
     * Aqui a chave é obrigatória e não dá para trocar por estado: dois depósitos
     * de R$ 500 no mesmo dia são caso legítimo, e nada distingue a segunda
     * transferência da repetição da primeira. É o oposto do saldo inicial, que a
     * própria existência do extrato barra.
     */
    const cofre = await criarContaFinanceira({ autorizadas: [], tenantId: TENANT, nome: 'Cofre' });
    const banco = await criarContaFinanceira({ autorizadas: [], tenantId: TENANT, nome: 'Banco' });
    const pedir = () =>
      transferirEntreContas({
        tenantId: TENANT,
        locationId: LOCATION,
        deContaId: cofre.id,
        paraContaId: banco.id,
        valorCents: 50_000,
        quandoEm: HOJE,
        idempotencyKey: 'balcao:1',
        ...operador,
      });

    const primeira = await pedir();
    const segunda = await pedir();
    expect(segunda.id).toBe(primeira.id);
    expect(await transferenciasRecentes({ tenantId: TENANT, locationId: LOCATION }))
      .toHaveLength(1);
  });

  it('transferir para a mesma conta é recusado antes de tocar o banco', async () => {
    const cofre = await criarContaFinanceira({ autorizadas: [], tenantId: TENANT, nome: 'Cofre' });
    await expect(
      transferirEntreContas({
        tenantId: TENANT,
        locationId: LOCATION,
        deContaId: cofre.id,
        paraContaId: cofre.id,
        valorCents: 1000,
        quandoEm: HOJE,
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'mesma_conta' });
  });

  it('a gaveta é uma por unidade', async () => {
    await criarContaFinanceira({
      autorizadas: [],
      tenantId: TENANT,
      nome: 'Gaveta',
      locationId: LOCATION,
      ehGaveta: true,
    });
    await expect(
      criarContaFinanceira({
        autorizadas: [],
        tenantId: TENANT,
        nome: 'Gaveta 2',
        locationId: LOCATION,
        ehGaveta: true,
      }),
    ).rejects.toThrow();
    expect((await contasFinanceiras(TENANT)).filter((c) => c.ehGaveta)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Fiado
  // -------------------------------------------------------------------------

  it('o limite de fiado passa a existir, e é o que destrava a venda fiada', async () => {
    /**
     * A coluna nasceu no bloco 18 com zero e nenhuma rota que a escrevesse: toda
     * venda fiada era recusada por estourar um limite que ninguém conseguia
     * levantar. Este teste é a prova de que a origem do dado agora existe.
     */
    const antes = await admin.$queryRawUnsafe<{ credit_limit_cents: number }[]>(
      `SELECT credit_limit_cents FROM customers WHERE id = '${CARLOS}'`,
    );
    expect(antes[0]?.credit_limit_cents).toBe(0);

    await definirLimiteDeFiado({
      tenantId: TENANT,
      customerId: CARLOS,
      limiteCents: 20_000,
      ...operador,
    });

    const depois = await admin.$queryRawUnsafe<{ credit_limit_cents: number }[]>(
      `SELECT credit_limit_cents FROM customers WHERE id = '${CARLOS}'`,
    );
    expect(depois[0]?.credit_limit_cents).toBe(20_000);
  });

  it('mexer no limite é auditado, com o antes e o depois', async () => {
    await definirLimiteDeFiado({
      tenantId: TENANT,
      customerId: CARLOS,
      limiteCents: 20_000,
      ...operador,
    });
    const trilha = await admin.$queryRawUnsafe<{ action: string; before: unknown; after: unknown }[]>(
      `SELECT action, before, after FROM audit_log WHERE tenant_id = '${TENANT}'`,
    );
    expect(trilha[0]?.action).toBe('debt.limit_changed');
    expect(trilha[0]?.after).toMatchObject({ limiteCents: 20_000 });
  });

  it('limite acima do teto e negativo são recusados', async () => {
    for (const limite of [-1, 5_000_001]) {
      await expect(
        definirLimiteDeFiado({
          tenantId: TENANT,
          customerId: CARLOS,
          limiteCents: limite,
          ...operador,
        }),
      ).rejects.toMatchObject({ code: 'valor_invalido' });
    }
  });

  it('o cliente de outra barbearia não tem limite alterado por esta', async () => {
    await exec(`
      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('c5151515-0000-0000-0000-000000000009', '${RIVAL}', 'Deles', '+5571900000000');
    `);
    await expect(
      definirLimiteDeFiado({
        tenantId: TENANT,
        customerId: 'c5151515-0000-0000-0000-000000000009',
        limiteCents: 10_000,
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'cliente_nao_encontrado' });
  });

  it('o saldo herdado do sistema antigo entra no razão que já existe', async () => {
    /**
     * Uma linha por pessoa, com o motivo escrito, e no mesmo extrato de sempre —
     * não numa segunda tabela de saldo inicial. Duas fontes para "quanto ele
     * deve" é o que a SPEC §3.5 proíbe em letras.
     */
    const { saldoCents } = await lancarSaldoInicialDeFiado({
      tenantId: TENANT,
      customerId: CARLOS,
      deveCents: 8500,
      motivo: 'Saldo em aberto no caderno até 09/11',
      ...operador,
    });
    expect(saldoCents).toBe(-8500);

    const razao = await admin.$queryRawUnsafe<
      { kind: string; amount_cents: number; balance_after_cents: number; note: string }[]
    >(`SELECT kind, amount_cents, balance_after_cents, note FROM customer_ledger
        WHERE customer_id = '${CARLOS}'`);
    expect(razao).toHaveLength(1);
    expect(razao[0]?.kind).toBe('adjustment');
    expect(razao[0]?.amount_cents).toBe(-8500);
    expect(razao[0]?.balance_after_cents).toBe(-8500);
    expect(razao[0]?.note).toContain('caderno');
  });

  it('o saldo inicial só existe uma vez, e quem o barra é o extrato', async () => {
    /**
     * O toque duplo é barrado pelo **estado**, não por chave: "saldo inicial" é
     * por definição a primeira linha do extrato. A guarda segura o segundo toque
     * de outro aparelho, de outra sessão e com chave nova — que é o que uma
     * chave gerada pelo cliente não garante.
     */
    const lancar = () =>
      lancarSaldoInicialDeFiado({
        tenantId: TENANT,
        customerId: CARLOS,
        deveCents: 8500,
        motivo: 'Saldo em aberto no caderno',
        ...operador,
      });

    await lancar();
    await expect(lancar()).rejects.toMatchObject({ code: 'ja_tem_extrato' });

    const razao = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM customer_ledger WHERE customer_id = '${CARLOS}'`,
    );
    expect(Number(razao[0]?.n)).toBe(1);
  });

  it('saldo herdado sem motivo escrito é recusado', async () => {
    // O extrato do fiado é exatamente o documento que precisa explicar cada
    // centavo quando o cliente discorda.
    await expect(
      lancarSaldoInicialDeFiado({
        tenantId: TENANT,
        customerId: CARLOS,
        deveCents: 8500,
        motivo: '  ',
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'motivo_obrigatorio' });
  });
});
