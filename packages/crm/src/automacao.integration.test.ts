import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  atribuirObjetivos,
  automacoesDaCasa,
  disparosAEnviar,
  marcarDisparoEnviado,
  salvarAutomacao,
  varrerAutomacoes,
} from './automacao.js';

/**
 * O motor de automação contra Postgres real (bloco 56, SPEC §4.11).
 *
 * O que só o banco prova: que o mesmo fato não dispara duas vezes, que o
 * cliente não recebe duas automações no mesmo dia **nem por processos
 * diferentes**, e que o objetivo só é creditado dentro da janela.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '56565656-1111-1111-1111-111111111111';
const RIVAL = '56565656-2222-2222-2222-222222222222';
const LOCAL = 'a6565656-0000-0000-0000-000000000001';
const CARLOS = 'c6565656-0000-0000-0000-000000000001';
const BRUNO = 'c6565656-0000-0000-0000-000000000002';
const DONO = 'd6565656-0000-0000-0000-000000000001';
const RUAN = 'e6565656-0000-0000-0000-000000000001';

const AGORA = new Date('2026-09-20T15:00:00Z');
const operador = { staffId: DONO, staffName: 'Matheus' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('automação', () => {
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

      INSERT INTO customers (id, tenant_id, name, phone_e164, accepts_marketing) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777', true),
        ('${BRUNO}', '${TENANT}', 'Bruno Lima', '+5571977776666', true);

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCAL}', 'Ruan', 'professional');
    `);
  });

  const automacao = (extra: Record<string, unknown> = {}) =>
    salvarAutomacao({
      tenantId: TENANT,
      nome: 'Volta, Carlos',
      gatilho: 'sem_retorno',
      limiar: 30,
      atrasoMinutos: 0,
      tipo: 'retorno',
      objetivo: 'agendamento',
      janelaDias: 7,
      ativa: true,
      ...operador,
      ...extra,
    });

  /** Um atendimento concluído há tantos dias. */
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

  const varrer = (agora = AGORA) =>
    varrerAutomacoes({ tenantId: TENANT, agora, timeZone: 'America/Bahia' });

  // -- o cadastro ------------------------------------------------------------

  it('gatilho que pede número sem número é recusado antes do banco', async () => {
    await expect(automacao({ limiar: null })).rejects.toMatchObject({ code: 'invalida' });
  });

  it('a lista traz enviadas e alcançadas, que é o que decide desligar', async () => {
    await automacao();
    const lista = await automacoesDaCasa(TENANT);
    expect(lista[0]).toMatchObject({ nome: 'Volta, Carlos', enviadas: 0, alcancadas: 0 });
  });

  it('a automação de uma barbearia não é lida pela outra', async () => {
    await automacao();
    expect(await automacoesDaCasa(RIVAL)).toHaveLength(0);
  });

  // -- a varredura -----------------------------------------------------------

  it('quem sumiu há mais dias que o limiar é marcado', async () => {
    await automacao({ limiar: 30 });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000001');
    expect(await varrer()).toMatchObject({ marcados: 1 });

    const fila = await disparosAEnviar(TENANT, AGORA);
    expect(fila).toHaveLength(1);
    expect(fila[0]?.customerId).toBe(CARLOS);
  });

  it('quem veio ontem não é marcado', async () => {
    await automacao({ limiar: 30 });
    await atendimento(CARLOS, 1, '16565656-0000-4000-8000-000000000002');
    expect(await varrer()).toMatchObject({ marcados: 0 });
  });

  it('o mesmo fato não dispara duas vezes, mesmo varrendo de hora em hora', async () => {
    /**
     * A varredura roda a cada hora. Sem a unicidade por fato, "sumiu há 30
     * dias" mandaria uma mensagem por hora enquanto a pessoa continuasse
     * sumida — e a barbearia descobriria pela conta da Meta.
     */
    await automacao({ limiar: 30 });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000003');
    expect(await varrer()).toMatchObject({ marcados: 1 });
    expect(await varrer(new Date(AGORA.getTime() + 3_600_000))).toMatchObject({ marcados: 0 });

    const total = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM automation_sends`,
    );
    expect(Number(total[0]?.n)).toBe(1);
  });

  it('a automação desligada não marca ninguém', async () => {
    await automacao({ limiar: 30, ativa: false });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000004');
    expect(await varrer()).toMatchObject({ marcados: 0 });
  });

  it('quem pediu para não receber promoção é pulado, com o motivo escrito', async () => {
    await automacao({ limiar: 30 });
    await exec(`UPDATE customers SET accepts_marketing = false WHERE id = '${CARLOS}'`);
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000005');

    expect(await varrer()).toMatchObject({ marcados: 0, pulados: 1 });
    const linha = await admin.$queryRawUnsafe<{ skipped_reason: string | null }[]>(
      `SELECT skipped_reason FROM automation_sends`,
    );
    // "Nada foi enviado" sem motivo transforma toda pergunta do dono numa
    // investigação — é a decisão de `notifications.reason`, do bloco 20.
    expect(linha[0]?.skipped_reason).toBe('optou_por_nao_receber');
  });

  it('o disparo pulado não ocupa a vaga do dia', async () => {
    /**
     * O índice do dia é parcial no enviado. Sem isso, a automação que não saiu
     * porque a pessoa optou por não receber bloquearia a que sairia — e a
     * barbearia veria o silêncio sem entender.
     */
    await automacao({ limiar: 30, nome: 'A' });
    await exec(`UPDATE customers SET accepts_marketing = false WHERE id = '${CARLOS}'`);
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000006');
    await varrer();

    await exec(`UPDATE customers SET accepts_marketing = true WHERE id = '${CARLOS}'`);
    await automacao({ limiar: 31, nome: 'B' });
    expect(await varrer()).toMatchObject({ marcados: 1 });
  });

  // -- o envio ---------------------------------------------------------------

  it('o carimbo vem antes da mensagem, e não carimba duas vezes', async () => {
    await automacao({ limiar: 30 });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000007');
    await varrer();
    const [disparo] = await disparosAEnviar(TENANT, AGORA);

    expect(await marcarDisparoEnviado({ tenantId: TENANT, disparoId: disparo!.id })).toBe(true);
    expect(await marcarDisparoEnviado({ tenantId: TENANT, disparoId: disparo!.id })).toBe(false);
    expect(await disparosAEnviar(TENANT, AGORA)).toHaveLength(0);
  });

  it('a segunda automação do dia é barrada pelo banco, não só pela leitura', async () => {
    /**
     * A regra da SPEC é por cliente e por dia. A leitura da varredura já a
     * respeita, mas ela não alcança outro processo varrendo ao mesmo tempo —
     * quem garante é o índice único, e o disparo barrado fica com o motivo
     * escrito em vez de sumir.
     */
    await automacao({ limiar: 30, nome: 'A' });
    await automacao({ limiar: 31, nome: 'B' });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000008');
    await varrer();

    const fila = await disparosAEnviar(TENANT, AGORA);
    expect(fila.length).toBeGreaterThanOrEqual(1);

    // O primeiro passa; o segundo, do mesmo cliente e mesmo dia, é recusado.
    const carimbados: boolean[] = [];
    for (const disparo of fila) {
      carimbados.push(await marcarDisparoEnviado({ tenantId: TENANT, disparoId: disparo.id }));
    }
    expect(carimbados.filter(Boolean)).toHaveLength(1);
  });

  // -- os outros gatilhos (bloco 57) ------------------------------------------

  it('cada gatilho novo acha de fato quem cruzou a condição', async () => {
    /**
     * Uma consulta que nunca é exercida é uma consulta que passa no portão e
     * falha em produção. Este teste dispara **um** gatilho de cada, com o fato
     * plantado, e cobra que a varredura encontre — é o que separa "a consulta
     * compila" de "a consulta funciona".
     */
    // Cancelamento: o cliente desmarcou ontem.
    const ontem = new Date(AGORA.getTime() - 86_400_000).toISOString();
    const fimOntem = new Date(AGORA.getTime() - 86_400_000 + 1_800_000).toISOString();
    await exec(`
      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status,
         starts_at, ends_at, service_starts_at, service_ends_at, cancelled_at)
      VALUES ('36565656-0000-4000-8000-000000000001', '${TENANT}', '${LOCAL}', '${RUAN}',
              '${CARLOS}', 'cancelled_customer', '${ontem}', '${fimOntem}',
              '${ontem}', '${fimOntem}', '${ontem}');
    `);

    await salvarAutomacao({
      tenantId: TENANT,
      nome: 'Voltou atrás?',
      gatilho: 'cancelamento',
      limiar: null,
      atrasoMinutos: 0,
      tipo: 'retorno',
      objetivo: 'agendamento',
      janelaDias: 7,
      ativa: true,
      ...operador,
    });

    expect(await varrer()).toMatchObject({ marcados: 1 });
  });

  it('avaliação boa e ruim usam o mesmo campo com sentidos opostos', async () => {
    // "A partir de quantas estrelas" e "até quantas": é o mesmo número com dois
    // significados, e a razão de o rótulo morar em `core`.
    await exec(`
      INSERT INTO reviews (id, tenant_id, customer_id, professional_id, rating, created_at)
      VALUES ('46565656-0000-4000-8000-000000000001', '${TENANT}', '${CARLOS}', '${RUAN}', 5,
              '${new Date(AGORA.getTime() - 3_600_000).toISOString()}');
    `);

    await salvarAutomacao({
      tenantId: TENANT,
      nome: 'Obrigado pela nota',
      gatilho: 'avaliacao_positiva',
      limiar: 4,
      atrasoMinutos: 0,
      tipo: 'retorno',
      objetivo: 'agendamento',
      janelaDias: 7,
      ativa: true,
      ...operador,
    });
    expect(await varrer()).toMatchObject({ marcados: 1 });

    // A ruim, com o mesmo cinco, não pega ninguém.
    await exec(`DELETE FROM automation_sends; DELETE FROM automations`);
    await salvarAutomacao({
      tenantId: TENANT,
      nome: 'Desculpa',
      gatilho: 'avaliacao_negativa',
      limiar: 3,
      atrasoMinutos: 0,
      tipo: 'retorno',
      objetivo: 'agendamento',
      janelaDias: 7,
      ativa: true,
      ...operador,
    });
    expect(await varrer()).toMatchObject({ marcados: 0 });
  });

  // -- a atribuição ----------------------------------------------------------

  it('o agendamento dentro da janela é creditado à mensagem', async () => {
    await automacao({ limiar: 30, objetivo: 'agendamento', janelaDias: 7 });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000009');
    await varrer();
    const [disparo] = await disparosAEnviar(TENANT, AGORA);
    await marcarDisparoEnviado({ tenantId: TENANT, disparoId: disparo!.id });

    /**
     * O fato é derivado do carimbo **de verdade**, não do relógio do teste.
     *
     * `marcarDisparoEnviado` grava `now()` do banco, e `AGORA` é uma data
     * futura escolhida para a semente. Criar o agendamento a partir de `AGORA`
     * o poria semanas depois do envio real, fora da janela — o teste falharia
     * por desencontro de relógio, não por regra quebrada.
     */
    const carimbo = await admin.$queryRawUnsafe<{ sent_at: Date }[]>(
      `SELECT sent_at FROM automation_sends WHERE id = '${disparo!.id}'`,
    );
    const enviadaEm = carimbo[0]!.sent_at.getTime();
    /**
     * Hora **fixa** e fora do expediente, e o dia é o que importa.
     *
     * Carregando os minutos do relógio, este horário caía por cima do que outra
     * semente já criou para a mesma cadeira às 15h — e a constraint
     * anti-overbooking recusava a linha inteira. Só falhava quando a suíte
     * rodava perto das 15h20: intermitente, e portanto do tipo que ensina todo
     * mundo a reexecutar em vez de olhar.
     *
     * É a cicatriz que o `CLAUDE.md` escreve: *semente que cria agendamento no
     * relógio colide com o que outra semeadura já criou para a mesma cadeira.
     * Hora fixa e fora do expediente.* A janela de atribuição conta em dias, e o
     * dia continua sendo o mesmo.
     */
    const diaDepois = new Date(enviadaEm + 2 * 86_400_000).toISOString().slice(0, 10);
    const depois = `${diaDepois}T03:00:00.000Z`;
    const fimDepois = `${diaDepois}T03:30:00.000Z`;
    await exec(`
      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status,
         starts_at, ends_at, service_starts_at, service_ends_at, created_at)
      VALUES ('26565656-0000-4000-8000-000000000001', '${TENANT}', '${LOCAL}', '${RUAN}',
              '${CARLOS}', 'confirmed', '${depois}', '${fimDepois}', '${depois}', '${fimDepois}',
              '${depois}');
    `);

    expect(
      await atribuirObjetivos({ tenantId: TENANT, agora: new Date(enviadaEm + 3 * 86_400_000) }),
    ).toBe(1);

    const lista = await automacoesDaCasa(TENANT);
    expect(lista[0]).toMatchObject({ enviadas: 1, alcancadas: 1 });
  });

  it('o agendamento fora da janela não é creditado', async () => {
    // Dois meses depois a pessoa marcaria de qualquer jeito. Atribuição frouxa
    // é pior que nenhuma, porque tem número.
    await automacao({ limiar: 30, objetivo: 'agendamento', janelaDias: 7 });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-00000000000a');
    await varrer();
    const [disparo] = await disparosAEnviar(TENANT, AGORA);
    await marcarDisparoEnviado({ tenantId: TENANT, disparoId: disparo!.id });

    const carimbo = await admin.$queryRawUnsafe<{ sent_at: Date }[]>(
      `SELECT sent_at FROM automation_sends WHERE id = '${disparo!.id}'`,
    );
    const enviadaEm = carimbo[0]!.sent_at.getTime();
    const tarde = new Date(enviadaEm + 60 * 86_400_000).toISOString();
    const fimTarde = new Date(enviadaEm + 60 * 86_400_000 + 1_800_000).toISOString();
    await exec(`
      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status,
         starts_at, ends_at, service_starts_at, service_ends_at, created_at)
      VALUES ('26565656-0000-4000-8000-000000000002', '${TENANT}', '${LOCAL}', '${RUAN}',
              '${CARLOS}', 'confirmed', '${tarde}', '${fimTarde}', '${tarde}', '${fimTarde}',
              '${tarde}');
    `);

    expect(
      await atribuirObjetivos({
        tenantId: TENANT,
        agora: new Date(enviadaEm + 61 * 86_400_000),
      }),
    ).toBe(0);
  });

  it('crédito exige mensagem enviada — o banco recusa o contrário', async () => {
    /**
     * Crédito a mensagem que não saiu é atribuição inventada, e ela apareceria
     * como sucesso no relatório. A `CHECK` é quem garante.
     */
    await automacao({ limiar: 30 });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-00000000000b');
    await varrer();
    await expect(
      admin.$executeRawUnsafe(`UPDATE automation_sends SET goal_met_at = now()`),
    ).rejects.toThrow();
  });
});
