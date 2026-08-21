import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { abrirCaixa } from './caixa.js';
import { abrirComanda, adicionarItem, ajustarComanda, fecharComanda } from './comanda.js';
import { desempenhoDoProfissional, metasDoMes, salvarMeta } from './desempenho.js';

/**
 * Os números do barbeiro contra Postgres real.
 *
 * A regra é toda de `core` e tem teste puro. O que só aparece aqui: que o
 * faturamento sai da venda e não do preço combinado, que o `rebooking rate` olha
 * o instante do atendimento e não o de agora, e que a meta de uma barbearia não
 * existe para a outra.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const GLEIDSON = 'bbbbbbbb-0000-0000-0000-000000000002';
const CABELO = 'eeeeeeee-0000-0000-0000-000000000001';
const CARLOS = 'cccccccc-0000-0000-0000-000000000001';
const JOAO = 'cccccccc-0000-0000-0000-000000000002';
const STAFF = 'ffffffff-0000-0000-0000-000000000001';

let admin: PrismaClient;
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const operador = { staffId: STAFF, staffName: 'Matheus Dono' };
/** Dia 10 de um mês de 30 dias: um terço do mês passou. */
const HOJE = '2026-09-10';

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(parte);
  }
}

describeIfDb('os números do barbeiro', () => {
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

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', 'Corte', 4000, 30);

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777'),
        ('${JOAO}', '${TENANT}', 'Joao Lima', '+5571977776666');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');
    `);
  });

  /** Vende e fecha a comanda, no dia da unidade informado. */
  async function vender(params: {
    readonly precoCents: number;
    readonly professionalId?: string;
    readonly dia?: string;
    readonly tipo?: 'service' | 'product';
    readonly quantidade?: number;
  }): Promise<void> {
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 0, ...operador })
      .catch(() => undefined);

    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
    });

    const quantidade = params.quantidade ?? 1;
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      tipo: params.tipo ?? 'service',
      ...(params.tipo === 'product' ? {} : { serviceId: CABELO }),
      descricao: params.tipo === 'product' ? 'Pomada' : 'Corte',
      quantidade,
      precoUnitarioCents: params.precoCents,
      professionalId: params.professionalId ?? RUAN,
    });

    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: params.precoCents * quantidade }],
      hojeNaUnidade: params.dia ?? HOJE,
      ...operador,
    });
  }

  /** Um atendimento concluído, com serviço e cliente. */
  async function atendeu(params: {
    readonly id: string;
    readonly quando: string;
    readonly customerId?: string;
    readonly professionalId?: string;
    readonly status?: string;
  }): Promise<void> {
    const fim = new Date(new Date(params.quando).getTime() + 30 * 60_000).toISOString();
    await exec(admin, `
      INSERT INTO appointments
        (id, tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, price_cents, status)
      VALUES ('${params.id}', '${TENANT}', '${LOCATION}',
              '${params.customerId ?? CARLOS}', '${params.professionalId ?? RUAN}',
              '${params.quando}', '${fim}', '${params.quando}', '${fim}',
              4000, '${params.status ?? 'completed'}')
    `);
  }

  const numeros = (professionalId = RUAN, hoje = HOJE) =>
    desempenhoDoProfissional({ tenantId: TENANT, professionalId, hoje });

  // -- faturamento --------------------------------------------------------------

  it('o faturamento sai da venda, não do preço combinado na marcação', async () => {
    /**
     * `appointments.price_cents` é o que foi combinado ao marcar;
     * `order_items` é o que foi vendido de fato, com o que a recepção
     * acrescentou no balcão. Ter duas contas de faturamento seria ter duas
     * verdades.
     */
    await atendeu({ id: 'f0000000-0000-0000-0000-000000000001', quando: '2026-09-05T14:00:00Z' });
    await vender({ precoCents: 9000, dia: '2026-09-05' });

    const meu = await numeros();
    expect(meu.mesAtual.faturamentoCents).toBe(9000);
    expect(meu.mesAtual.atendimentos).toBe(1);
    expect(meu.mesAtual.ticketMedioCents).toBe(9000);
  });

  it('a venda do colega não entra na minha conta', async () => {
    await vender({ precoCents: 5000, professionalId: RUAN });
    await vender({ precoCents: 20000, professionalId: GLEIDSON });

    expect((await numeros(RUAN)).mesAtual.faturamentoCents).toBe(5000);
    expect((await numeros(GLEIDSON)).mesAtual.faturamentoCents).toBe(20000);
  });

  it('o dia da venda é o da unidade, não o instante em UTC', async () => {
    // Comanda fechada às 23h50 de sábado pertence ao sábado, mesmo que em UTC
    // já seja domingo. É `business_day`, a mesma decisão do bloco 19.
    await vender({ precoCents: 7000, dia: '2026-08-31' });
    await vender({ precoCents: 3000, dia: '2026-09-01' });

    const meu = await numeros();
    // A regra é a fronteira: o dia 31 é de agosto e o dia 1º é de setembro.
    expect(meu.mesAtual.faturamentoCents).toBe(3000);

    /**
     * O dia 31 fica **fora** da comparação, e é a mudança do bloco 114.
     *
     * A janela anterior agora vai até o mesmo dia do mês — 01 a 10 de agosto —,
     * então uma venda do dia 31 não entra. Antes ela entrava, e era isso que
     * fazia a tela comparar dez dias de movimento contra trinta e um.
     */
    expect(meu.mesAnterior.faturamentoCents).toBe(0);
  });

  it('produto vendido é contado à parte do serviço', async () => {
    await vender({ precoCents: 5000 });
    await vender({ precoCents: 4500, tipo: 'product', quantidade: 2 });

    const meu = await numeros();
    expect(meu.mesAtual.produtosVendidos).toBe(2);
    expect(meu.mesAtual.faturamentoCents).toBe(5000 + 9000);
  });

  it('o de hoje é um recorte do mês, não outra conta', async () => {
    await vender({ precoCents: 5000, dia: '2026-09-03' });
    await vender({ precoCents: 6000, dia: HOJE });

    const meu = await numeros();
    expect(meu.hoje.faturamentoCents).toBe(6000);
    expect(meu.mesAtual.faturamentoCents).toBe(11000);
  });

  // -- rebooking rate -----------------------------------------------------------

  it('quem saiu com o próximo horário marcado conta na taxa de retorno', async () => {
    /**
     * A SPEC §4.21 chama de a métrica mais preditiva de retenção, e observa que
     * quase ninguém mede.
     */
    await atendeu({ id: 'f0000000-0000-0000-0000-000000000011', quando: '2026-09-05T14:00:00Z' });
    // O próximo, marcado no mesmo dia do atendimento.
    await atendeu({
      id: 'f0000000-0000-0000-0000-000000000012',
      quando: '2026-10-05T14:00:00Z',
      status: 'confirmed',
    });
    // E um segundo cliente que foi embora sem remarcar.
    await atendeu({
      id: 'f0000000-0000-0000-0000-000000000013',
      quando: '2026-09-06T14:00:00Z',
      customerId: JOAO,
    });

    const meu = await numeros();
    expect(meu.mesAtual.atendimentos).toBe(2);
    expect(meu.mesAtual.taxaDeRetorno).toBe(50);
  });

  it('quem marcou meses depois não conta como saiu com horário', async () => {
    /**
     * Perguntar "tem agendamento futuro hoje?" contaria quem voltou por outro
     * motivo em novembro — e a taxa de setembro mudaria toda vez que alguém
     * abrisse a tela. A janela é o instante do atendimento.
     */
    await atendeu({ id: 'f0000000-0000-0000-0000-000000000021', quando: '2026-09-05T14:00:00Z' });
    const tardio = 'f0000000-0000-0000-0000-000000000022';
    await atendeu({ id: tardio, quando: '2026-11-05T14:00:00Z', status: 'confirmed' });
    await admin.$executeRawUnsafe(
      `UPDATE appointments SET created_at = '2026-10-30T10:00:00Z' WHERE id = '${tardio}'`,
    );

    expect((await numeros()).mesAtual.taxaDeRetorno).toBe(0);
  });

  it('o próximo horário cancelado não conta', async () => {
    await atendeu({ id: 'f0000000-0000-0000-0000-000000000031', quando: '2026-09-05T14:00:00Z' });
    await atendeu({
      id: 'f0000000-0000-0000-0000-000000000032',
      quando: '2026-10-05T14:00:00Z',
      status: 'cancelled_customer',
    });

    expect((await numeros()).mesAtual.taxaDeRetorno).toBe(0);
  });

  it('atendimento sem cliente cadastrado não estraga a taxa', async () => {
    /**
     * Walk-in sem cadastro entra no total de atendimentos e nunca no de
     * retornos — o que é correto: ele não tem como ter "próximo horário".
     *
     * Quem garante isso é o SQL, não a cláusula que parece garantir: com
     * `customer_id` nulo, `proximo.customer_id = a.customer_id` já é falso.
     * Quebrar o `IS NOT NULL` de propósito não deixou este teste vermelho, e o
     * comentário na consulta registra isso.
     */
    await atendeu({ id: 'f0000000-0000-0000-0000-000000000041', quando: '2026-09-05T14:00:00Z' });
    await atendeu({
      id: 'f0000000-0000-0000-0000-000000000042',
      quando: '2026-10-05T14:00:00Z',
      status: 'confirmed',
    });
    const semCadastro = 'f0000000-0000-0000-0000-000000000043';
    await atendeu({ id: semCadastro, quando: '2026-09-06T14:00:00Z' });
    await admin.$executeRawUnsafe(
      `UPDATE appointments SET customer_id = NULL WHERE id = '${semCadastro}'`,
    );

    const meu = await numeros();
    expect(meu.mesAtual.atendimentos).toBe(2);
    // Um de dois saiu com horário: o sem cadastro entra no total mas não pode
    // ser contado como retorno, e a taxa fica em 50 e não em 100.
    expect(meu.mesAtual.taxaDeRetorno).toBe(50);
  });

  // -- meta ---------------------------------------------------------------------

  it('sem meta, o progresso é zero e a tela não mostra 0% de R$ 0,00', async () => {
    const meu = await numeros();
    expect(meu.meta.metaCents).toBe(0);
    expect(meu.meta.percentual).toBe(0);
  });

  it('a meta do mês compara com o realizado e com o ritmo', async () => {
    await salvarMeta({
      tenantId: TENANT, locationId: LOCATION, professionalId: RUAN, mes: HOJE,
      metaCents: 1_500_000, staffUserId: STAFF,
    });
    await vender({ precoCents: 600_000, dia: '2026-09-05' });

    const meu = await numeros();
    expect(meu.meta.metaCents).toBe(1_500_000);
    expect(meu.meta.realizadoCents).toBe(600_000);
    // Dia 10 de 30: o esperado é um terço.
    expect(meu.meta.esperadoAteHojeCents).toBe(500_000);
    expect(meu.meta.noRitmo).toBe(true);
  });

  it('a meta é do mês; a de agosto não vale para setembro', async () => {
    await salvarMeta({
      tenantId: TENANT, locationId: LOCATION, professionalId: RUAN, mes: '2026-08-01',
      metaCents: 900_000, staffUserId: STAFF,
    });

    expect((await numeros()).meta.metaCents).toBe(0);
  });

  it('salvar duas vezes atualiza a meta, não duplica', async () => {
    const salvar = (cents: number) =>
      salvarMeta({
        tenantId: TENANT, locationId: LOCATION, professionalId: RUAN, mes: HOJE,
        metaCents: cents, staffUserId: STAFF,
      });

    await salvar(1_000_000);
    await salvar(1_200_000);

    expect((await numeros()).meta.metaCents).toBe(1_200_000);
  });

  it('meta nula apaga a linha — é o único jeito de dizer "sem meta"', async () => {
    await salvarMeta({
      tenantId: TENANT, locationId: LOCATION, professionalId: RUAN, mes: HOJE,
      metaCents: 1_000_000, staffUserId: STAFF,
    });
    await salvarMeta({
      tenantId: TENANT, locationId: LOCATION, professionalId: RUAN, mes: HOJE,
      metaCents: null, staffUserId: STAFF,
    });

    const linhas = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM professional_goals`,
    );
    expect(Number(linhas[0]?.n)).toBe(0);
    expect((await numeros()).meta.metaCents).toBe(0);
  });

  it('a lista de metas sugere a do mês anterior sem decidir por ninguém', async () => {
    // Meta que se renova sozinha vira número que ninguém escolheu e que todo
    // mundo ignora. Sugerir é diferente de decidir.
    await salvarMeta({
      tenantId: TENANT, locationId: LOCATION, professionalId: RUAN, mes: '2026-08-01',
      metaCents: 900_000, staffUserId: STAFF,
    });

    const lista = await metasDoMes({ tenantId: TENANT, locationId: LOCATION, mes: HOJE });
    const ruan = lista.find((m) => m.professionalId === RUAN);
    expect(ruan?.metaCents).toBeNull();
    expect(ruan?.anteriorCents).toBe(900_000);
  });

  it('a comparação é até o mesmo dia dos dois lados, não mês cheio contra mês pela metade', async () => {
    /**
     * O mês corrente ia até o último dia do calendário e o anterior era o mês
     * **inteiro**: no dia 10, dez dias de movimento contra trinta e um. A tela
     * dizia ao barbeiro "−40% que o mês passado" sobre uma queda real de −5% —
     * e o cabeçalho dela diz "agosto, **até hoje**", que é a própria tela
     * contando as duas versões.
     *
     * É a SPEC §4.21 do avesso: o indicador do barbeiro se compara com o
     * próprio passado, e comparar com um passado maior é o mesmo que comparar
     * com o colega mais movimentado.
     */
    // Setembro, até o dia 10 (HOJE): uma venda.
    await vender({ precoCents: 10_000, dia: '2026-09-05' });

    // Agosto: uma venda **antes** do dia 10 e outra **depois**. Só a primeira
    // entra na comparação honesta; com o mês inteiro, as duas entravam.
    await vender({ precoCents: 10_000, dia: '2026-08-05' });
    await vender({ precoCents: 90_000, dia: '2026-08-25' });

    const meu = await numeros(RUAN, HOJE);
    expect(meu.mesAtual.faturamentoCents).toBe(10_000);
    expect(meu.mesAnterior.faturamentoCents).toBe(10_000);
    // Mesmo movimento nos dois recortes: variação zero, e não −90%.
    expect(meu.variacaoDoFaturamento).toBe(0);
  });

  it('quem abre a tela no dia 31 compara contra o último dia de fevereiro', async () => {
    // O mesmo dia do mês anterior, aparado: 31 de março não tem par em
    // fevereiro, e comparar contra uma data que não existe devolveria zero.
    await vender({ precoCents: 7_000, dia: '2028-02-29' });
    const meu = await numeros(RUAN, '2028-03-31');
    expect(meu.mesAnterior.faturamentoCents).toBe(7_000);
  });

  it('a virada do ano acha o mês anterior', async () => {
    // Janeiro de 2027 tem dezembro de 2026 atrás dele, não o mês zero.
    await salvarMeta({
      tenantId: TENANT, locationId: LOCATION, professionalId: RUAN, mes: '2026-12-01',
      metaCents: 800_000, staffUserId: STAFF,
    });

    const lista = await metasDoMes({ tenantId: TENANT, locationId: LOCATION, mes: '2027-01-15' });
    expect(lista.find((m) => m.professionalId === RUAN)?.anteriorCents).toBe(800_000);
  });

  it('fevereiro bissexto tem 29 dias, e o ritmo usa o mês certo', async () => {
    await salvarMeta({
      tenantId: TENANT, locationId: LOCATION, professionalId: RUAN, mes: '2028-02-01',
      metaCents: 2_900_000, staffUserId: STAFF,
    });

    const meu = await numeros(RUAN, '2028-02-29');
    // Último dia: o esperado é a meta inteira.
    expect(meu.meta.esperadoAteHojeCents).toBe(2_900_000);
  });

  // -- a parede entre barbearias -------------------------------------------------

  it('a cadeira de outra barbearia não existe para quem pergunta', async () => {
    await expect(
      desempenhoDoProfissional({ tenantId: RIVAL, professionalId: RUAN, hoje: HOJE }),
    ).rejects.toMatchObject({ code: 'profissional_nao_encontrado' });
  });

  it('a rival não grava meta para um profissional da casa', async () => {
    /**
     * A chave estrangeira não protege: a checagem de integridade referencial do
     * Postgres ignora row security. O que recusa é o `SELECT` sob RLS antes de
     * gravar.
     */
    await expect(
      salvarMeta({
        // A unidade e a cadeira são as **do vizinho**, e é isso que o teste
        // manda: sob a RLS do rival, a consulta não acha nenhuma das duas.
        tenantId: RIVAL, locationId: LOCATION, professionalId: RUAN, mes: HOJE,
        metaCents: 1, staffUserId: STAFF,
      }),
    ).rejects.toMatchObject({ code: 'profissional_nao_encontrado' });

    const linhas = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM professional_goals`,
    );
    expect(Number(linhas[0]?.n)).toBe(0);
  });

  it('consulta sem filtro de tenant devolve zero metas para a rival', async () => {
    // Quem filtra é a política, não o `WHERE` do repositório.
    await salvarMeta({
      tenantId: TENANT, locationId: LOCATION, professionalId: RUAN, mes: HOJE,
      metaCents: 1_000_000, staffUserId: STAFF,
    });

    const daRival = await withTenant(RIVAL, async (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM professional_goals`,
    );
    expect(Number(daRival[0]?.n)).toBe(0);
  });

  describe('a gorjeta tem dono', () => {
    /**
     * SPEC §3.6: *"vinculada ao profissional que executou"*, *"nunca entra na
     * base de comissão nem no faturamento da casa (é repasse)"*, *"aparece
     * separada no DRE e no extrato do barbeiro"*.
     *
     * `orders.tip_cents` era gravada e sempre subtraída — do faturamento, do
     * painel, do DRE, da base de comissão — e **nunca atribuída**. Na base de
     * demonstração eram R$ 2.628,33 em 447 comandas: dinheiro de terceiro
     * entrando na conta da casa sem registro de quem é.
     */
    async function comandaComGorjeta(params: {
      readonly gorjetaCents: number;
      readonly dono?: string | null;
      readonly itens: readonly { readonly professionalId: string; readonly precoCents: number }[];
    }): Promise<void> {
      await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 0, ...operador })
        .catch(() => undefined);
      const aberta = await abrirComanda({
        tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
      });
      for (const item of params.itens) {
        await adicionarItem({
          tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
          tipo: 'service', serviceId: CABELO, descricao: 'Corte', quantidade: 1,
          precoUnitarioCents: item.precoCents, professionalId: item.professionalId,
        });
      }
      await ajustarComanda({
        tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
        desconto: null, gorjetaCents: params.gorjetaCents,
        ...(params.dono === undefined ? {} : { gorjetaProfessionalId: params.dono }),
        staffId: STAFF, staffName: 'Maria',
      });
      const total = params.itens.reduce((s, i) => s + i.precoCents, 0) + params.gorjetaCents;
      await fecharComanda({
        tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
        pagamentos: [{ forma: 'cash', valorCents: total }],
        hojeNaUnidade: HOJE, ...operador,
      });
    }

    const gorjetaDe = async (quem: string): Promise<number> =>
      (
        await desempenhoDoProfissional({
          tenantId: TENANT, professionalId: quem, hoje: HOJE,
        })
      ).mesAtual.gorjetaCents;

    it('sem dono declarado, segue o peso da receita de cada um', async () => {
      // Corte de R$ 60 com o Ruan e de R$ 40 com o João: R$ 10 saem 6 e 4.
      await comandaComGorjeta({
        gorjetaCents: 1000,
        itens: [
          { professionalId: RUAN, precoCents: 6000 },
          { professionalId: GLEIDSON, precoCents: 4000 },
        ],
      });

      expect(await gorjetaDe(RUAN)).toBe(600);
      expect(await gorjetaDe(GLEIDSON)).toBe(400);
    });

    it('o dono declarado leva tudo, e o colega fica sem', async () => {
      await comandaComGorjeta({
        gorjetaCents: 1000,
        dono: GLEIDSON,
        itens: [
          { professionalId: RUAN, precoCents: 6000 },
          { professionalId: GLEIDSON, precoCents: 4000 },
        ],
      });

      expect(await gorjetaDe(GLEIDSON)).toBe(1000);
      expect(await gorjetaDe(RUAN)).toBe(0);
    });

    it('a gorjeta não entra no faturamento nem na base de comissão', async () => {
      /**
       * É repasse: o dinheiro é do barbeiro e só passou pela conta da casa.
       * Contá-lo no faturamento faria a meta ser batida com dinheiro de outra
       * pessoa, e na base de comissão faria a casa pagar comissão sobre gorjeta.
       */
      await comandaComGorjeta({
        gorjetaCents: 5000,
        dono: RUAN,
        itens: [{ professionalId: RUAN, precoCents: 10_000 }],
      });

      const desempenho = await desempenhoDoProfissional({
        tenantId: TENANT, professionalId: RUAN, hoje: HOJE,
      });
      expect(desempenho.mesAtual.faturamentoCents).toBe(10_000);
      expect(desempenho.mesAtual.gorjetaCents).toBe(5000);
    });

    it('o profissional de outra barbearia não recebe a gorjeta', async () => {
      /**
       * A checagem de integridade referencial do Postgres ignora row security:
       * a chave estrangeira aceitaria o id da vizinha sem reclamar, e o repasse
       * ficaria pendurado em quem não trabalha aqui.
       */
      await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 0, ...operador })
        .catch(() => undefined);
      const aberta = await abrirComanda({
        tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
      });

      await expect(
        ajustarComanda({
          tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
          desconto: null, gorjetaCents: 1000,
          gorjetaProfessionalId: 'dddddddd-0000-0000-0000-000000000099',
          staffId: STAFF, staffName: 'Maria',
        }),
      ).rejects.toThrow();
    });
  });

});
