import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { abrirCaixa } from './caixa.js';
import { abrirComanda, adicionarItem, fecharComanda } from './comanda.js';
import { painelDeDinheiro, painelOperacional } from './painel.js';

/**
 * O painel do proprietário contra Postgres real — SPEC §5.9.
 *
 * O que se prova aqui: que a comparação é com o **mesmo dia da semana** (sábado
 * com sábado, não sábado com sexta), que ocupação é tempo e não contagem, e que
 * o painel de uma barbearia não enxerga a outra.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOCAL_RIVAL = 'aaaaaaaa-0000-0000-0000-000000000002';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const CABELO = 'eeeeeeee-0000-0000-0000-000000000001';
const CARLOS = 'cccccccc-0000-0000-0000-000000000001';
const JOAO = 'cccccccc-0000-0000-0000-000000000002';
const STAFF = 'ffffffff-0000-0000-0000-000000000001';

let admin: PrismaClient;
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const operador = { staffId: STAFF, staffName: 'Matheus Dono' };
/** Sábado. O anterior, 2026-09-05, também é sábado. */
const SABADO = '2026-09-12';
const SABADO_ANTES = '2026-09-05';

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(parte);
  }
}

describeIfDb('painel do proprietário', () => {
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

      INSERT INTO locations (id, tenant_id, name, timezone) VALUES
        ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia'),
        ('${LOCAL_RIVAL}', '${RIVAL}', 'Rival', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional');

      -- Sábado (6) com 8 horas de jornada: 480 minutos de capacidade.
      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      VALUES ('${TENANT}', '${RUAN}', 6, 540, 1020);

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', 'Corte', 5000, 30);

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777'),
        ('${JOAO}', '${TENANT}', 'Joao Lima', '+5571977776666');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');
    `);
  });

  /** Um atendimento no dia, com duração e status. */
  async function agendou(params: {
    readonly id: string;
    readonly dia: string;
    readonly hora: number;
    readonly minutos?: number;
    readonly status?: string;
    readonly customerId?: string;
  }): Promise<void> {
    const minutos = params.minutos ?? 30;
    const inicio = `${params.dia}T${String(params.hora).padStart(2, '0')}:00:00Z`;
    const fim = new Date(new Date(inicio).getTime() + minutos * 60_000).toISOString();
    await exec(admin, `
      INSERT INTO appointments
        (id, tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, price_cents, status)
      VALUES ('${params.id}', '${TENANT}', '${LOCATION}',
              '${params.customerId ?? CARLOS}', '${RUAN}',
              '${inicio}', '${fim}', '${inicio}', '${fim}', 5000,
              '${params.status ?? 'completed'}')
    `);
  }

  async function vendeu(precoCents: number, dia: string): Promise<void> {
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 0, ...operador })
      .catch(() => undefined);
    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      tipo: 'service', serviceId: CABELO, descricao: 'Corte',
      quantidade: 1, precoUnitarioCents: precoCents, professionalId: RUAN,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: precoCents }],
      hojeNaUnidade: dia, ...operador,
    });
  }

  const operacao = (dia = SABADO) =>
    painelOperacional({ tenantId: TENANT, locationId: LOCATION, dia });
  const dinheiro = (dia = SABADO) =>
    painelDeDinheiro({ tenantId: TENANT, locationId: LOCATION, dia });

  const uuid = (n: number) => `f0000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

  it('compara com o mesmo dia da semana, não com ontem', async () => {
    /**
     * Barbearia tem semana com forma: sábado é o dobro de terça. Comparar
     * sábado com sexta produziria alta toda semana e queda toda segunda — ruído
     * que ninguém consegue usar.
     */
    const painel = await operacao();
    expect(painel.comparadoCom).toBe(SABADO_ANTES);
  });

  it('conta agendamentos do dia e compara com o sábado anterior', async () => {
    await agendou({ id: uuid(1), dia: SABADO, hora: 12 });
    await agendou({ id: uuid(2), dia: SABADO, hora: 13 });
    await agendou({ id: uuid(3), dia: SABADO_ANTES, hora: 12 });

    const painel = await operacao();
    expect(painel.agendamentos.valor).toBe(2);
    expect(painel.agendamentos.anterior).toBe(1);
    expect(painel.agendamentos.variacao).toBe(100);
  });

  it('ocupação é tempo, não contagem', async () => {
    /**
     * Um corte de 30 e uma coloração de 120 não ocupam a casa do mesmo jeito.
     * Contar cabeças esconderia isso — e ocupação é a métrica que decide se
     * vale contratar.
     */
    await agendou({ id: uuid(1), dia: SABADO, hora: 12, minutos: 120 });
    await agendou({ id: uuid(2), dia: SABADO, hora: 15, minutos: 120 });

    // 240 minutos vendidos sobre 480 de jornada.
    expect((await operacao()).ocupacao.valor).toBe(50);
  });

  it('sem jornada no dia, a ocupação é zero e não infinito', async () => {
    // Domingo: a casa não abre, e dividir por zero não pode virar a métrica.
    const domingo = await painelOperacional({
      tenantId: TENANT, locationId: LOCATION, dia: '2026-09-13',
    });
    expect(domingo.ocupacao.valor).toBe(0);
    expect(Number.isFinite(domingo.ocupacao.valor)).toBe(true);
  });

  it('a falta entra na taxa, não some da conta', async () => {
    await agendou({ id: uuid(1), dia: SABADO, hora: 12 });
    await agendou({ id: uuid(2), dia: SABADO, hora: 13, status: 'no_show' });
    await agendou({ id: uuid(3), dia: SABADO, hora: 14, status: 'no_show' });

    // Duas faltas em três esperados.
    expect((await operacao()).noShow.valor).toBe(67);
  });

  it('cliente novo é o que apareceu pela primeira vez, não o cadastro do dia', async () => {
    /**
     * Contar cadastro criado hoje contaria também quem a recepção digitou de
     * novo por engano — e o número que interessa é quantas pessoas novas
     * sentaram na cadeira.
     */
    await agendou({ id: uuid(1), dia: SABADO_ANTES, hora: 12, customerId: CARLOS });
    await agendou({ id: uuid(2), dia: SABADO, hora: 12, customerId: CARLOS });
    await agendou({ id: uuid(3), dia: SABADO, hora: 13, customerId: JOAO });

    const painel = await operacao();
    // Carlos já tinha vindo; só o João é novo hoje.
    expect(painel.novosClientes.valor).toBe(1);
    expect(painel.novosClientes.anterior).toBe(1);
  });

  it('o remarcado não conta duas vezes', async () => {
    // `rescheduled` aponta para o novo agendamento; contar os dois inflaria o
    // dia com um atendimento que não existe.
    await agendou({ id: uuid(1), dia: SABADO, hora: 12, status: 'rescheduled' });
    await agendou({ id: uuid(2), dia: SABADO, hora: 13 });

    expect((await operacao()).agendamentos.valor).toBe(1);
  });

  it('o faturamento sai da comanda fechada, no dia da unidade', async () => {
    await vendeu(12000, SABADO);
    await vendeu(8000, SABADO_ANTES);

    const painel = await dinheiro();
    expect(painel.faturamentoCents.valor).toBe(12000);
    expect(painel.faturamentoCents.anterior).toBe(8000);
    expect(painel.faturamentoCents.variacao).toBe(50);
  });

  it('o ticket médio divide pelo número de comandas', async () => {
    await vendeu(10000, SABADO);
    await vendeu(6000, SABADO);

    expect((await dinheiro()).ticketMedioCents.valor).toBe(8000);
  });

  it('dia sem venda não devolve NaN', async () => {
    const painel = await dinheiro();
    expect(painel.faturamentoCents.valor).toBe(0);
    expect(painel.ticketMedioCents.valor).toBe(0);
    // Sem base anterior não há comparação: "primeiro dia" não é "caiu 100%".
    expect(painel.faturamentoCents.variacao).toBeNull();
  });

  it('o painel de uma barbearia não enxerga a outra', async () => {
    await agendou({ id: uuid(1), dia: SABADO, hora: 12 });
    await vendeu(12000, SABADO);

    const daRival = await painelOperacional({
      tenantId: RIVAL, locationId: LOCAL_RIVAL, dia: SABADO,
    });
    const dinheiroDaRival = await painelDeDinheiro({
      tenantId: RIVAL, locationId: LOCAL_RIVAL, dia: SABADO,
    });

    expect(daRival.agendamentos.valor).toBe(0);
    expect(dinheiroDaRival.faturamentoCents.valor).toBe(0);
  });

  it('id de unidade alheia não vaza o dado da casa', async () => {
    // Id de unidade é entrada externa. Com o tenant da rival e a unidade da
    // casa, a RLS devolve zero — o filtro por unidade não substitui a política.
    await agendou({ id: uuid(1), dia: SABADO, hora: 12 });

    const cruzado = await painelOperacional({
      tenantId: RIVAL, locationId: LOCATION, dia: SABADO,
    });
    expect(cruzado.agendamentos.valor).toBe(0);
  });
});
