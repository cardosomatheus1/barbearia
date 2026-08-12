import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { atribuirReceita, campanhasDaCasa, criarCampanha, despacharCampanha } from './campanha.js';

/**
 * Campanhas contra Postgres real (bloco 57, SPEC §4.13).
 *
 * O que só o banco prova: que o público é **congelado** na criação, que a
 * campanha respeita as mesmas proteções da automação, e que a receita atribuída
 * — *"a única coluna que importa"* — só conta o que veio dentro da janela.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '57575757-1111-1111-1111-111111111111';
const LOCAL = 'a7575757-0000-0000-0000-000000000001';
const CARLOS = 'c7575757-0000-0000-0000-000000000001';
const BRUNO = 'c7575757-0000-0000-0000-000000000002';
const SUMIDO = 'c7575757-0000-0000-0000-000000000003';
const DONO = 'd7575757-0000-0000-0000-000000000001';
const RUAN = 'e7575757-0000-0000-0000-000000000001';

const AGORA = new Date('2026-09-20T15:00:00Z');
const operador = { staffId: DONO, staffName: 'Matheus' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('campanhas', () => {
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

      INSERT INTO customers (id, tenant_id, name, phone_e164, accepts_marketing) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777', true),
        ('${BRUNO}', '${TENANT}', 'Bruno Lima', '+5571977776666', true),
        ('${SUMIDO}', '${TENANT}', 'João Sumido', '+5571966665555', true);

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCAL}', 'Ruan', 'professional');
    `);
  });

  const campanha = (extra: Record<string, unknown> = {}) =>
    criarCampanha({
      tenantId: TENANT,
      nome: 'Terça vazia',
      filtro: 'todos',
      valorDoFiltro: null,
      diaDaSemana: null,
      tipo: 'retorno',
      janelaDias: 7,
      agora: AGORA,
      ...operador,
      ...extra,
    });

  const atendimento = async (customerId: string, diasAtras: number, id: string) => {
    const inicio = new Date(AGORA.getTime() - diasAtras * 86_400_000);
    const fim = new Date(inicio.getTime() + 30 * 60_000);
    await exec(`
      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status,
         starts_at, ends_at, service_starts_at, service_ends_at)
      VALUES ('${id}', '${TENANT}', '${LOCAL}', '${RUAN}', '${customerId}', 'completed',
              '${inicio.toISOString()}', '${fim.toISOString()}',
              '${inicio.toISOString()}', '${fim.toISOString()}');
    `);
  };

  it('o público é congelado na criação', async () => {
    /**
     * Guardar o filtro faria "quantos receberam" mudar toda vez que alguém
     * fosse cadastrado — e a receita atribuída, que é lida contra esse
     * conjunto, mudaria junto.
     */
    const criada = await campanha();
    expect(criada.publico).toBe(3);

    await exec(`
      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('c7575757-0000-0000-0000-0000000000ff', '${TENANT}', 'Novo', '+5571900000001');
    `);

    const lista = await campanhasDaCasa(TENANT);
    expect(lista[0]?.publico).toBe(3);
  });

  it('quem foi anonimizado e quem não tem telefone ficam fora', async () => {
    // Eles entrariam no público para serem pulados no envio, inflando "quantos
    // receberam" com gente que nunca poderia receber.
    //
    // O telefone só pode ser nulo em quem foi anonimizado — há `CHECK` desde o
    // bloco 34 —, então o caminho do teste é o de verdade: anonimizar.
    await exec(`SELECT set_config('app.tenant_id', '${TENANT}', false)`);
    await admin.$executeRawUnsafe(
      `SELECT anonimizar_cliente('${BRUNO}'::uuid, 'pedido de exclusão do titular')`,
    );
    const criada = await campanha();
    expect(criada.publico).toBe(2);
  });

  it('o filtro de inativos só pega quem sumiu', async () => {
    await atendimento(CARLOS, 2, '17575757-0000-4000-8000-000000000001');
    await atendimento(BRUNO, 5, '17575757-0000-4000-8000-000000000002');

    const criada = await campanha({ filtro: 'inativos', valorDoFiltro: 30 });
    expect(criada.publico).toBe(1);
  });

  it('a célula fria pega quem costuma vir naquele horário', async () => {
    /**
     * O público certo é quem tem o **hábito** daquele horário, porque é quem
     * pode voltar a ele. Uma campanha para toda a base sobre uma terça às 14h é
     * ruído para quem só corta no sábado.
     */
    // 2026-09-15 é uma terça; 11h UTC é 8h em Salvador.
    await exec(`
      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status,
         starts_at, ends_at, service_starts_at, service_ends_at)
      VALUES ('17575757-0000-4000-8000-000000000003', '${TENANT}', '${LOCAL}', '${RUAN}',
              '${CARLOS}', 'completed',
              '2026-09-15T11:00:00Z', '2026-09-15T11:30:00Z',
              '2026-09-15T11:00:00Z', '2026-09-15T11:30:00Z');
    `);

    const criada = await campanha({ filtro: 'celula_fria', diaDaSemana: 2, valorDoFiltro: 8 });
    expect(criada.publico).toBe(1);

    // Outra hora do mesmo dia não pega ninguém.
    const outra = await campanha({
      nome: 'Outra hora',
      filtro: 'celula_fria',
      diaDaSemana: 2,
      valorDoFiltro: 17,
    });
    expect(outra.publico).toBe(0);
  });

  it('célula sem dia e hora é recusada', async () => {
    await expect(campanha({ filtro: 'celula_fria' })).rejects.toMatchObject({ code: 'invalida' });
  });

  it('o envio respeita o opt-out, e o motivo fica escrito', async () => {
    // Uma campanha que ignorasse as proteções porque "foi o dono que mandou"
    // seria a porta pela qual o número da barbearia queima.
    await exec(`UPDATE customers SET accepts_marketing = false`);
    const criada = await campanha();

    const resultado = await despacharCampanha({
      tenantId: TENANT,
      campanhaId: criada.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async () => {
        throw new Error('ninguém aceita promoção');
      },
    });
    expect(resultado).toMatchObject({ enviados: 0, pulados: 3 });

    const motivos = await admin.$queryRawUnsafe<{ skipped_reason: string }[]>(
      `SELECT DISTINCT skipped_reason FROM campaign_targets`,
    );
    expect(motivos[0]?.skipped_reason).toBe('optou_por_nao_receber');
  });

  it('quem já recebeu campanha hoje não recebe outra', async () => {
    const primeira = await campanha({ nome: 'A' });
    await despacharCampanha({
      tenantId: TENANT,
      campanhaId: primeira.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async () => {},
    });

    const segunda = await campanha({ nome: 'B' });
    const resultado = await despacharCampanha({
      tenantId: TENANT,
      campanhaId: segunda.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async () => {
        throw new Error('todo mundo já recebeu hoje');
      },
    });
    expect(resultado.enviados).toBe(0);
  });

  it('as seis colunas saem da mesma consulta', async () => {
    const criada = await campanha();
    await despacharCampanha({
      tenantId: TENANT,
      campanhaId: criada.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async () => {},
    });

    const lista = await campanhasDaCasa(TENANT);
    expect(lista[0]).toMatchObject({
      publico: 3,
      enviados: 3,
      entregues: 0,
      lidos: 0,
      cliques: 0,
      agendamentos: 0,
      receitaCents: 0,
      estado: 'enviada',
    });
  });

  it('a receita atribuída conta a venda dentro da janela, e congela o valor', async () => {
    /**
     * *"A última coluna é a única que importa."* Ela é congelada porque
     * recalcular na leitura faria o relatório de março mudar quando alguém
     * estornasse uma venda em maio.
     */
    const criada = await campanha({ janelaDias: 7 });
    await despacharCampanha({
      tenantId: TENANT,
      campanhaId: criada.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async () => {},
    });

    // O carimbo é o relógio injetado, então a janela é contada a partir dele.
    const depois = new Date(AGORA.getTime() + 2 * 86_400_000).toISOString();

    await exec(`
      INSERT INTO orders (id, tenant_id, location_id, customer_id, status,
                          business_day, closed_at, total_cents)
      VALUES ('27575757-0000-4000-8000-000000000001', '${TENANT}', '${LOCAL}', '${CARLOS}',
              'paid', current_date, '${depois}', 8900);
    `);

    expect(await atribuirReceita({ tenantId: TENANT, agora: AGORA })).toBe(1);

    const lista = await campanhasDaCasa(TENANT);
    expect(lista[0]).toMatchObject({ agendamentos: 1, receitaCents: 8900 });
  });

  it('a venda fora da janela não é creditada', async () => {
    const criada = await campanha({ janelaDias: 7 });
    await despacharCampanha({
      tenantId: TENANT,
      campanhaId: criada.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async () => {},
    });

    const tarde = new Date(AGORA.getTime() + 60 * 86_400_000).toISOString();

    await exec(`
      INSERT INTO orders (id, tenant_id, location_id, customer_id, status,
                          business_day, closed_at, total_cents)
      VALUES ('27575757-0000-4000-8000-000000000002', '${TENANT}', '${LOCAL}', '${CARLOS}',
              'paid', current_date, '${tarde}', 8900);
    `);

    expect(await atribuirReceita({ tenantId: TENANT, agora: AGORA })).toBe(0);
  });

  it('crédito exige mensagem enviada — o banco recusa o contrário', async () => {
    const criada = await campanha();
    void criada;
    await expect(
      admin.$executeRawUnsafe(`UPDATE campaign_targets SET goal_met_at = now()`),
    ).rejects.toThrow();
  });
});
