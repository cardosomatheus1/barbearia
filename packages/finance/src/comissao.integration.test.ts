import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { abrirCaixa } from './caixa.js';
import { abrirComanda, adicionarItem, ajustarComanda, fecharComanda } from './comanda.js';
import {
  extratoDeComissao,
  fecharPeriodoDeComissao,
  fechamentosDeComissao,
  regrasDeComissao,
  removerRegraDeComissao,
  aliquotasDoAdquirente,
  salvarAliquotaDoAdquirente,
  salvarConfiguracaoDeComissao,
  salvarRegraDeComissao,
} from './comissao.js';

/**
 * Comissão contra Postgres real.
 *
 * O que só aparece aqui: que fechar a comanda lança a comissão **na mesma
 * transação**, que o desconto da comanda é rateado entre barbeiros diferentes,
 * e que o que foi fechado não entra em conta nenhuma de novo — nem quando a
 * regra muda, nem quando a venda é estornada.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const GLEIDSON = 'bbbbbbbb-0000-0000-0000-000000000002';
const CABELO = 'eeeeeeee-0000-0000-0000-000000000001';
const BARBA = 'eeeeeeee-0000-0000-0000-000000000002';
const CATEGORIA = 'caca0000-0000-0000-0000-000000000001';
const CARLOS = 'cccccccc-0000-0000-0000-000000000001';
const STAFF = 'ffffffff-0000-0000-0000-000000000001';

let admin: PrismaClient;
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const operador = { staffId: STAFF, staffName: 'Matheus Dono' };
const HOJE = '2026-09-10';
const OUTRO_MES = '2026-10-05';

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(parte);
  }
}

describeIfDb('comissão', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(admin, `
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Rival');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional'),
             ('${GLEIDSON}', '${TENANT}', '${LOCATION}', 'Gleidson', 'professional');

      INSERT INTO service_categories (id, tenant_id, name)
      VALUES ('${CATEGORIA}', '${TENANT}', 'Cabelo');

      INSERT INTO services (id, tenant_id, category_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', '${CATEGORIA}', 'Corte', 4000, 30),
             ('${BARBA}', '${TENANT}', NULL, 'Barba', 6000, 30);

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');
    `);
  });

  const regraGeral = (valor = 4000) =>
    salvarRegraDeComissao({ tenantId: TENANT, modo: 'percent', valor, ...operador });

  /** Vende `precoCents` com um barbeiro e fecha a comanda em dinheiro. */
  async function vender(params: {
    readonly professionalId?: string;
    readonly serviceId?: string;
    readonly precoCents: number;
    readonly descontoCents?: number;
    readonly gorjetaCents?: number;
    readonly dia?: string;
    readonly forma?: 'cash' | 'credit' | 'debit' | 'pix';
  }) {
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 0, ...operador })
      .catch(() => undefined);

    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
    });

    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      tipo: 'service',
      serviceId: params.serviceId ?? CABELO,
      descricao: 'Corte',
      quantidade: 1,
      precoUnitarioCents: params.precoCents,
      professionalId: params.professionalId ?? RUAN,
    });

    if (params.descontoCents || params.gorjetaCents) {
      await ajustarComanda({
        locationId: LOCATION,
        tenantId: TENANT, orderId: aberta.id,
        desconto: params.descontoCents
          ? { tipo: 'amount', valor: params.descontoCents, motivo: 'Cliente antigo' }
          : null,
        gorjetaCents: params.gorjetaCents ?? 0,
        ...operador,
      });
    }

    const total = params.precoCents - (params.descontoCents ?? 0) + (params.gorjetaCents ?? 0);
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      pagamentos: [{ forma: params.forma ?? 'cash', valorCents: total }],
      hojeNaUnidade: params.dia ?? HOJE,
      ...operador,
    });

    return aberta.id;
  }

  const extrato = (de = '2026-09-01', ate = '2026-09-30') =>
    extratoDeComissao({ tenantId: TENANT, de, ate });

  // -- o lançamento -----------------------------------------------------------

  it('fechar a comanda lança a comissão', async () => {
    await regraGeral(4000);
    await vender({ precoCents: 10_000 });

    const conta = await extrato();
    expect(conta.linhas).toHaveLength(1);
    expect(conta.linhas[0]).toMatchObject({
      professionalName: 'Ruan',
      baseCents: 10_000,
      comissaoCents: 4_000,
    });
  });

  it('sem regra nenhuma, nada é lançado — e a tela diz quem ficou de fora', async () => {
    // Falta de configuração e comissão zero são coisas diferentes. Sem essa
    // distinção o barbeiro descobre no dia do acerto, olhando um número menor
    // do que esperava, sem nada explicando o porquê.
    await vender({ precoCents: 10_000 });

    const conta = await extrato();
    expect(conta.linhas).toEqual([]);
    expect(conta.semRegra).toEqual([{ professionalName: 'Ruan', itens: 1 }]);
  });

  it('a regra mais específica ganha, e é a copiada para o lançamento', async () => {
    await regraGeral(4000);
    await salvarRegraDeComissao({
      tenantId: TENANT, serviceId: BARBA, modo: 'percent', valor: 5000, ...operador,
    });

    await vender({ serviceId: BARBA, precoCents: 10_000 });

    expect((await extrato()).linhas[0]?.comissaoCents).toBe(5_000);
  });

  it('mudar a regra depois não reescreve o que já foi vendido', async () => {
    /**
     * A razão de a regra ser **copiada** para dentro do lançamento.
     *
     * Sem isso, subir a alíquota em outubro aumentaria retroativamente o que o
     * barbeiro tinha a receber de setembro — e o relatório que o dono imprimiu
     * na sexta não bateria com o da segunda.
     */
    await regraGeral(4000);
    await vender({ precoCents: 10_000 });

    await regraGeral(9000);

    expect((await extrato()).linhas[0]?.comissaoCents).toBe(4_000);
  });

  it('item sem profissional não gera comissão de ninguém', async () => {
    await regraGeral(4000);
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 0, ...operador });
    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      tipo: 'product', descricao: 'Pomada', quantidade: 1, precoUnitarioCents: 5_000,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: 5_000 }], hojeNaUnidade: HOJE, ...operador,
    });

    const conta = await extrato();
    expect(conta.linhas).toEqual([]);
    expect(conta.semRegra).toEqual([]);
  });

  // -- desconto e gorjeta -----------------------------------------------------

  it('o desconto da comanda é rateado entre os barbeiros, não cobrado de um', async () => {
    /**
     * Corte de 40 do Ruan e barba de 60 do Gleidson, com 10 de desconto.
     *
     * O desconto é da comanda e a comissão é por item: sem ratear, quem cortou
     * o cabelo pagaria sozinho o desconto que o dono deu na conta inteira.
     */
    await regraGeral(5000);
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 0, ...operador });

    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id, tipo: 'service',
      serviceId: CABELO, descricao: 'Corte', quantidade: 1,
      precoUnitarioCents: 4_000, professionalId: RUAN,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id, tipo: 'service',
      serviceId: BARBA, descricao: 'Barba', quantidade: 1,
      precoUnitarioCents: 6_000, professionalId: GLEIDSON,
    });
    await ajustarComanda({
      locationId: LOCATION,
      tenantId: TENANT, orderId: aberta.id,
      desconto: { tipo: 'amount', valor: 1_000, motivo: 'Cliente antigo' }, ...operador,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: 9_000 }], hojeNaUnidade: HOJE, ...operador,
    });

    const conta = await extrato();
    const ruan = conta.linhas.find((l) => l.professionalName === 'Ruan');
    const gleidson = conta.linhas.find((l) => l.professionalName === 'Gleidson');

    expect(ruan?.baseCents).toBe(3_600);
    expect(gleidson?.baseCents).toBe(5_400);
    expect(ruan?.comissaoCents).toBe(1_800);
    expect(gleidson?.comissaoCents).toBe(2_700);
  });

  it('com "desconto é custo da casa" a base do barbeiro não cai', async () => {
    await salvarConfiguracaoDeComissao({
      tenantId: TENANT,
      base: 'liquido',
      tratamentoDoDesconto: 'custo_da_casa',
      tratamentoDaTaxa: 'absorvida',
      ...operador,
    });
    await regraGeral(5000);
    await vender({ precoCents: 10_000, descontoCents: 2_000 });

    expect((await extrato()).linhas[0]?.baseCents).toBe(10_000);
  });

  /**
   * A taxa do adquirente (bloco 36) — a lacuna declarada desde o 19.
   *
   * A comissão já escolhia entre líquido e bruto e já tratava o desconto; a
   * terceira escolha da SPEC §3.4 faltava porque **a alíquota do adquirente não
   * existia em lugar nenhum do produto**.
   */
  it('sem alíquota cadastrada, a taxa é zero e nada muda', async () => {
    // Toda barbearia que já usa o sistema continua exatamente como estava.
    await regraGeral(4000);
    await vender({ precoCents: 10_000, forma: 'credit' });

    expect((await extrato()).linhas[0]?.baseCents).toBe(10_000);
  });

  it('com a taxa absorvida, a base do barbeiro não cai', async () => {
    // Padrão, e é o que o produto sempre fez por omissão: a casa paga a
    // maquininha inteira.
    await salvarAliquotaDoAdquirente({ tenantId: TENANT, forma: 'credit', bps: 319, ...operador });
    await regraGeral(4000);
    await vender({ precoCents: 10_000, forma: 'credit' });

    expect((await extrato()).linhas[0]?.baseCents).toBe(10_000);
  });

  it('com a taxa rateada, ela desce da base', async () => {
    await salvarConfiguracaoDeComissao({
      tenantId: TENANT,
      base: 'liquido',
      tratamentoDoDesconto: 'reduz_base',
      tratamentoDaTaxa: 'rateada',
      ...operador,
    });
    await salvarAliquotaDoAdquirente({ tenantId: TENANT, forma: 'credit', bps: 319, ...operador });
    await regraGeral(4000);
    await vender({ precoCents: 10_000, forma: 'credit' });

    // 10.000 − 319 = 9.681, e 40% disso.
    expect((await extrato()).linhas[0]?.baseCents).toBe(9_681);
    expect((await extrato()).linhas[0]?.comissaoCents).toBe(3_872);
  });

  it('cada meio de pagamento paga a própria alíquota', async () => {
    // Crédito custa múltiplas vezes o que custa Pix. Uma alíquota média daria
    // um número que não bate com nenhum extrato.
    await salvarConfiguracaoDeComissao({
      tenantId: TENANT,
      base: 'liquido',
      tratamentoDoDesconto: 'reduz_base',
      tratamentoDaTaxa: 'rateada',
      ...operador,
    });
    await salvarAliquotaDoAdquirente({ tenantId: TENANT, forma: 'credit', bps: 319, ...operador });
    await salvarAliquotaDoAdquirente({ tenantId: TENANT, forma: 'pix', bps: 99, ...operador });
    await regraGeral(4000);
    await vender({ precoCents: 10_000, forma: 'pix' });

    expect((await extrato()).linhas[0]?.baseCents).toBe(10_000 - 99);
  });

  it('a alíquota é congelada na venda: mudar depois não mexe no que já foi', async () => {
    /**
     * Mesma decisão do preço do serviço (bloco 18) e da regra copiada no
     * lançamento (bloco 19): renegociar a maquininha em maio não pode mudar a
     * comissão que já foi paga em abril.
     */
    await salvarConfiguracaoDeComissao({
      tenantId: TENANT,
      base: 'liquido',
      tratamentoDoDesconto: 'reduz_base',
      tratamentoDaTaxa: 'rateada',
      ...operador,
    });
    await salvarAliquotaDoAdquirente({ tenantId: TENANT, forma: 'credit', bps: 319, ...operador });
    await regraGeral(4000);
    await vender({ precoCents: 10_000, forma: 'credit' });

    await salvarAliquotaDoAdquirente({ tenantId: TENANT, forma: 'credit', bps: 1000, ...operador });

    expect((await extrato()).linhas[0]?.baseCents).toBe(9_681);
  });

  it('alíquota fora da faixa é recusada', async () => {
    // 3,19 virando 319 é o erro de digitação plausível, e o estrago seria a
    // comissão do mês inteiro de todo mundo.
    await expect(
      salvarAliquotaDoAdquirente({ tenantId: TENANT, forma: 'credit', bps: 31_900, ...operador }),
    ).rejects.toMatchObject({ code: 'aliquota_invalida' });
  });

  it('a taxa da gorjeta não desce da base do barbeiro', async () => {
    /**
     * Achado da revisão do bloco 36. O aparelho cobra sobre tudo que passa nele,
     * gorjeta inclusive — mas a taxa é rateada só sobre os itens. Ratear o valor
     * cheio fazia o barbeiro pagar tarifa sobre a própria gorjeta, que a decisão
     * nº 2 de `core` diz que "nunca entra na base".
     */
    await salvarConfiguracaoDeComissao({
      tenantId: TENANT,
      base: 'liquido',
      tratamentoDoDesconto: 'reduz_base',
      tratamentoDaTaxa: 'rateada',
      ...operador,
    });
    await salvarAliquotaDoAdquirente({ tenantId: TENANT, forma: 'credit', bps: 319, ...operador });
    await regraGeral(4000);
    await vender({ precoCents: 10_000, gorjetaCents: 2_000, forma: 'credit' });

    // A taxa cheia sobre R$ 120 é 383; o que desce da base é a parte dos R$ 100
    // vendidos, que é 319.
    expect((await extrato()).linhas[0]?.baseCents).toBe(10_000 - 319);
  });

  it('fiado não recebe alíquota — não é meio de pagamento', async () => {
    /**
     * É dívida. Cobrar taxa de adquirente sobre um fiado seria cobrar a
     * maquininha de um dinheiro que não passou por ela, e o barbeiro pagaria
     * por uma transação que não existiu.
     */
    await expect(
      salvarAliquotaDoAdquirente({ tenantId: TENANT, forma: 'fiado', bps: 319, ...operador }),
    ).rejects.toMatchObject({ code: 'aliquota_invalida' });
  });

  it('zero apaga a linha em vez de guardar zero', async () => {
    // Guardar zero explícito e ausência como coisas diferentes criaria duas
    // maneiras de dizer a mesma coisa.
    await salvarAliquotaDoAdquirente({ tenantId: TENANT, forma: 'credit', bps: 319, ...operador });
    await salvarAliquotaDoAdquirente({ tenantId: TENANT, forma: 'credit', bps: 0, ...operador });

    expect(await aliquotasDoAdquirente(TENANT)).toEqual([]);
  });

  it('a gorjeta nunca entra na base', async () => {
    // Ela já é 100% do profissional; comissioná-la faria a casa cobrar taxa
    // sobre dinheiro que nunca foi dela.
    await regraGeral(4000);
    await vender({ precoCents: 10_000, gorjetaCents: 3_000 });

    expect((await extrato()).linhas[0]?.baseCents).toBe(10_000);
  });

  // -- fechamento -------------------------------------------------------------

  it('fechar congela o valor e tira os lançamentos do período aberto', async () => {
    await regraGeral(4000);
    await vender({ precoCents: 10_000 });

    const fechado = await fecharPeriodoDeComissao({
      tenantId: TENANT, de: '2026-09-01', ate: '2026-09-30', ...operador,
    });
    expect(fechado.linhas[0]?.comissaoCents).toBe(4_000);

    // O período aberto ficou vazio: o mesmo corte não pode ser pago duas vezes.
    expect((await extrato()).linhas).toEqual([]);
  });

  it('o valor fechado não muda quando a regra muda', async () => {
    await regraGeral(4000);
    await vender({ precoCents: 10_000 });
    await fecharPeriodoDeComissao({
      tenantId: TENANT, de: '2026-09-01', ate: '2026-09-30', ...operador,
    });

    await regraGeral(9000);

    const historico = await fechamentosDeComissao({ tenantId: TENANT });
    expect(historico[0]?.linhas[0]?.comissaoCents).toBe(4_000);
  });

  it('não se fecha o mesmo período duas vezes', async () => {
    await regraGeral(4000);
    await vender({ precoCents: 10_000 });
    const periodo = { tenantId: TENANT, de: '2026-09-01', ate: '2026-09-30', ...operador };

    await fecharPeriodoDeComissao(periodo);
    await expect(fecharPeriodoDeComissao(periodo)).rejects.toMatchObject({
      code: 'periodo_ja_fechado',
    });
  });

  it('período sem lançamento não vira fechamento vazio', async () => {
    await expect(
      fecharPeriodoDeComissao({
        tenantId: TENANT, de: '2026-09-01', ate: '2026-09-30', ...operador,
      }),
    ).rejects.toMatchObject({ code: 'nada_a_fechar' });
  });

  it('período invertido é recusado', async () => {
    await expect(
      fecharPeriodoDeComissao({
        tenantId: TENANT, de: '2026-09-30', ate: '2026-09-01', ...operador,
      }),
    ).rejects.toMatchObject({ code: 'periodo_invalido' });
  });

  it('venda de outro mês não entra no fechamento deste', async () => {
    await regraGeral(4000);
    await vender({ precoCents: 10_000, dia: HOJE });
    await vender({ precoCents: 20_000, dia: OUTRO_MES });

    const fechado = await fecharPeriodoDeComissao({
      tenantId: TENANT, de: '2026-09-01', ate: '2026-09-30', ...operador,
    });
    expect(fechado.linhas[0]?.baseCents).toBe(10_000);

    // O de outubro continua aberto.
    const outubro = await extrato('2026-10-01', '2026-10-31');
    expect(outubro.linhas[0]?.baseCents).toBe(20_000);
  });

  // -- faixas -----------------------------------------------------------------

  it('a faixa olha o acumulado do período, não a venda', async () => {
    // Dois cortes de 3.000 somam 6.000: os primeiros 5.000 a 40% e os 1.000
    // seguintes a 45%. Calculado venda a venda, cada um cairia na primeira
    // faixa e o barbeiro perderia a diferença.
    await salvarRegraDeComissao({
      tenantId: TENANT, modo: 'tiers', valor: 0,
      faixas: [
        { ateCents: 500_000, pontosBase: 4000 },
        { ateCents: null, pontosBase: 4500 },
      ],
      ...operador,
    });

    await vender({ precoCents: 300_000 });
    await vender({ precoCents: 300_000 });

    expect((await extrato()).linhas[0]?.comissaoCents).toBe(200_000 + 45_000);
  });

  // -- a parede entre barbearias ---------------------------------------------

  it('regra de comissão não aponta para profissional de outra barbearia', async () => {
    // A chave estrangeira do Postgres ignora RLS: sem conferir antes, o id do
    // vizinho entraria como se fosse daqui.
    await expect(
      salvarRegraDeComissao({
        tenantId: RIVAL, professionalId: RUAN, modo: 'percent', valor: 4000, ...operador,
      }),
    ).rejects.toMatchObject({ code: 'regra_invalida' });
  });

  it('a comissão de uma barbearia não existe para a outra', async () => {
    await regraGeral(4000);
    await vender({ precoCents: 10_000 });

    const daRival = await extratoDeComissao({
      tenantId: RIVAL, de: '2026-09-01', ate: '2026-09-30',
    });
    expect(daRival.linhas).toEqual([]);
    expect(await fechamentosDeComissao({ tenantId: RIVAL })).toEqual([]);
  });

  it('o barbeiro só vê a própria comissão', async () => {
    // `commission.view_own` ≠ `commission.view_all`: barbeiro que vê a comissão
    // do colega é o motivo nº 1 de briga interna em barbearia.
    await regraGeral(4000);
    await vender({ precoCents: 10_000, professionalId: RUAN });
    await vender({ precoCents: 50_000, professionalId: GLEIDSON });

    const dele = await extratoDeComissao({
      tenantId: TENANT, de: '2026-09-01', ate: '2026-09-30', somenteProfessionalId: RUAN,
    });

    expect(dele.linhas).toHaveLength(1);
    expect(dele.linhas[0]?.professionalName).toBe('Ruan');
    expect(dele.totalComissaoCents).toBe(4_000);
  });

  // -- regras -----------------------------------------------------------------

  it('a mesma combinação é atualizada, não duplicada', async () => {
    await regraGeral(4000);
    await regraGeral(5000);

    const { regras } = await regrasDeComissao(TENANT);
    expect(regras).toHaveLength(1);
    expect(regras[0]?.valor).toBe(5000);
  });

  it('alíquota acima de 100% é recusada antes de chegar ao banco', async () => {
    await expect(regraGeral(20_000)).rejects.toMatchObject({ code: 'regra_invalida' });
  });

  it('remover regra que não existe é erro, não silêncio', async () => {
    await expect(
      removerRegraDeComissao({
        tenantId: TENANT, id: '00000000-0000-0000-0000-000000000000', ...operador,
      }),
    ).rejects.toMatchObject({ code: 'regra_nao_encontrada' });
  });

  it('fechar comissão fica na trilha', async () => {
    await regraGeral(4000);
    await vender({ precoCents: 10_000 });
    await fecharPeriodoDeComissao({
      tenantId: TENANT, de: '2026-09-01', ate: '2026-09-30', ...operador,
    });

    const trilha = await admin.$queryRawUnsafe<{ action: string }[]>(
      `SELECT action FROM audit_log WHERE tenant_id = '${TENANT}'`,
    );
    expect(trilha.map((l) => l.action)).toContain('commission.closed');
  });

  it('dois fechamentos simultâneos não pagam o mesmo lançamento duas vezes', async () => {
    /**
     * O que segura aqui não é o índice único do período — ele só pega o
     * duplicado exato. Dois períodos **sobrepostos** fechados ao mesmo tempo
     * leriam os mesmos lançamentos ainda sem carimbo e os dois pagariam.
     *
     * Quem impede é a trigger: o segundo `UPDATE` espera a trava do primeiro,
     * relê a linha já carimbada e recusa — derrubando a transação inteira, com
     * o fechamento e as linhas que ela tinha acabado de inserir.
     */
    await regraGeral(4000);
    await vender({ precoCents: 10_000 });

    const resultados = await Promise.allSettled([
      fecharPeriodoDeComissao({ tenantId: TENANT, de: '2026-09-01', ate: '2026-09-30', ...operador }),
      fecharPeriodoDeComissao({ tenantId: TENANT, de: '2026-09-05', ate: '2026-10-05', ...operador }),
    ]);

    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const fechamentos = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM commission_closures WHERE tenant_id = '${TENANT}'`,
    );
    expect(Number(fechamentos[0]?.n)).toBe(1);

    // E o barbeiro foi pago uma vez só.
    const linhas = await admin.$queryRawUnsafe<{ n: bigint; total: bigint }[]>(
      `SELECT count(*) AS n, COALESCE(sum(amount_cents),0) AS total
         FROM commission_closure_lines WHERE tenant_id = '${TENANT}'`,
    );
    expect(Number(linhas[0]?.n)).toBe(1);
    expect(Number(linhas[0]?.total)).toBe(4_000);
  });

  it('período sobreposto fechado depois não repaga o que já foi carimbado', async () => {
    /**
     * Sequencial, não concorrente: aqui quem impede é o filtro de carimbo.
     *
     * A venda cai **dentro da sobreposição** de propósito (dia 20, com os
     * períodos 01–30 e 15–15/10). A primeira versão deste teste usava o dia 10,
     * fora da segunda janela — então o filtro de data já bastava e o teste
     * passava mesmo com o carimbo ignorado. Verifiquei quebrando.
     */
    await regraGeral(4000);
    await vender({ precoCents: 10_000, dia: '2026-09-20' });
    await vender({ precoCents: 20_000, dia: OUTRO_MES });

    await fecharPeriodoDeComissao({
      tenantId: TENANT, de: '2026-09-01', ate: '2026-09-30', ...operador,
    });
    const segundo = await fecharPeriodoDeComissao({
      tenantId: TENANT, de: '2026-09-15', ate: '2026-10-15', ...operador,
    });

    // Só a venda de outubro: a de setembro já tinha carimbo.
    expect(segundo.linhas[0]?.baseCents).toBe(20_000);
  });
});
