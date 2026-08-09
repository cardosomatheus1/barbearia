import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agendarApuracaoDeTodas,
  apuracaoPendente,
  apurarDiaDaBarbearia,
} from './metricas.js';
// A retenção mora em arquivo próprio e é medida aqui porque a armadilha é a
// mesma: o índice de idempotência de `jobs` é global.
import { agendarRetencaoDeTodas, retencaoPendente } from './retencao.js';

/**
 * A apuração diária contra Postgres real.
 *
 * O que precisa ser provado aqui é que os números **estão certos**, e isso não
 * se prova com mock: metade da conta é do banco (o dia de cada agendamento sai
 * do fuso da unidade, a ocupação vem de um JOIN com a jornada) e a outra metade
 * é a RLS deixando cada barbearia ver só a si mesma.
 *
 * Por isso as fixtures são propositalmente desiguais: se os números de duas
 * barbearias fossem parecidos, uma consulta que somasse as duas passaria.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const DOMARI = '25252525-1111-1111-1111-111111111111';
const RIVAL = '25252525-2222-2222-2222-222222222222';
const LOCAL = 'a5252525-0000-0000-0000-000000000001';
const LOCAL_RIVAL = 'a5252525-0000-0000-0000-000000000002';
const RUAN = 'b5252525-0000-0000-0000-000000000001';
const GLEIDSON = 'b5252525-0000-0000-0000-000000000002';
const RUAN_RIVAL = 'b5252525-0000-0000-0000-000000000003';

/** Sábado. Escolhido porque é dia de movimento em barbearia. */
const DIA = '2026-09-12';

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const lido = async (tenantId: string, dia = DIA) => {
  const linhas = await admin.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM tenant_metrics_daily WHERE tenant_id = '${tenantId}' AND business_day = '${dia}'`,
  );
  return linhas[0] ?? null;
};

describeIfDb('apuração diária da barbearia', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE jobs');
    await admin.$executeRawUnsafe('TRUNCATE tenant_metrics_daily');

    await exec(`
      INSERT INTO tenants (id, name) VALUES ('${DOMARI}', 'Domari'), ('${RIVAL}', 'Rival');

      INSERT INTO locations (id, tenant_id, name, timezone) VALUES
        ('${LOCAL}', '${DOMARI}', 'Pituba', 'America/Bahia'),
        ('${LOCAL_RIVAL}', '${RIVAL}', 'Centro', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
        ('${RUAN}', '${DOMARI}', '${LOCAL}', 'Ruan', 'professional'),
        ('${GLEIDSON}', '${DOMARI}', '${LOCAL}', 'Gleidson', 'professional'),
        ('${RUAN_RIVAL}', '${RIVAL}', '${LOCAL_RIVAL}', 'Outro', 'professional');

      -- Sábado é 6. Duas cadeiras de 9h às 13h = 480 minutos de jornada.
      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute) VALUES
        ('${DOMARI}', '${RUAN}', 6, 540, 780),
        ('${DOMARI}', '${GLEIDSON}', 6, 540, 780),
        ('${RIVAL}', '${RUAN_RIVAL}', 6, 540, 1020);
    `);
  });

  /** Um agendamento de 30 min começando às `hora` local de Salvador (UTC-3). */
  const marcar = (
    tenantId: string,
    locationId: string,
    professionalId: string,
    horaLocal: number,
    status: string,
    source: string,
  ) => {
    const inicio = `${DIA}T${String(horaLocal + 3).padStart(2, '0')}:00:00Z`;
    const fim = `${DIA}T${String(horaLocal + 3).padStart(2, '0')}:30:00Z`;
    return exec(`
      INSERT INTO appointments
        (tenant_id, location_id, professional_id, starts_at, ends_at,
         service_starts_at, service_ends_at, status, source, price_cents)
      VALUES ('${tenantId}', '${locationId}', '${professionalId}',
              '${inicio}', '${fim}', '${inicio}', '${fim}',
              '${status}', '${source}', 5000)
    `);
  };

  it('conta agendamento, falta, cancelamento e o que foi concluído', async () => {
    await marcar(DOMARI, LOCAL, RUAN, 9, 'completed', 'website');
    await marcar(DOMARI, LOCAL, RUAN, 10, 'completed', 'reception');
    await marcar(DOMARI, LOCAL, RUAN, 11, 'no_show', 'website');
    await marcar(DOMARI, LOCAL, GLEIDSON, 9, 'cancelled_customer', 'app');

    const apurado = await apurarDiaDaBarbearia(DOMARI, DIA);

    expect(apurado.agendamentos).toBe(4);
    expect(apurado.concluidos).toBe(2);
    expect(apurado.faltas).toBe(1);
    expect(apurado.cancelamentos).toBe(1);
  });

  it('adoção é o canal do cliente, e a recepção não conta como online', async () => {
    // Sem isto a métrica de adoção mediria "usa o sistema", que toda barbearia
    // com recepção usa. O que ela precisa medir é "o cliente marca sozinho".
    await marcar(DOMARI, LOCAL, RUAN, 9, 'completed', 'website');
    await marcar(DOMARI, LOCAL, RUAN, 10, 'completed', 'app');
    await marcar(DOMARI, LOCAL, RUAN, 11, 'completed', 'reception');
    await marcar(DOMARI, LOCAL, GLEIDSON, 9, 'completed', 'professional');

    const apurado = await apurarDiaDaBarbearia(DOMARI, DIA);

    expect(apurado.agendamentos).toBe(4);
    expect(apurado.online).toBe(2);
  });

  it('cancelado e falta não ocupam a cadeira, e por isso não entram na ocupação', async () => {
    await marcar(DOMARI, LOCAL, RUAN, 9, 'completed', 'website');
    await marcar(DOMARI, LOCAL, RUAN, 10, 'no_show', 'website');
    await marcar(DOMARI, LOCAL, GLEIDSON, 9, 'cancelled_business', 'website');

    const apurado = await apurarDiaDaBarbearia(DOMARI, DIA);

    // Um atendimento de 30 min sobre duas cadeiras de 4 horas.
    expect(apurado.minutosVendidos).toBe(30);
    expect(apurado.minutosDisponiveis).toBe(480);
  });

  it('o dia é o da unidade, não o do servidor', async () => {
    // 23h30 de Salvador é 02h30 do dia seguinte em UTC. Apurar por UTC jogaria
    // o último corte da noite de sábado para dentro do domingo — e o sábado da
    // barbearia perderia justamente o horário mais disputado.
    await exec(`
      INSERT INTO appointments
        (tenant_id, location_id, professional_id, starts_at, ends_at,
         service_starts_at, service_ends_at, status, source, price_cents)
      VALUES ('${DOMARI}', '${LOCAL}', '${RUAN}',
              '2026-09-13T02:30:00Z', '2026-09-13T03:00:00Z',
              '2026-09-13T02:30:00Z', '2026-09-13T03:00:00Z',
              'completed', 'website', 5000)
    `);

    expect((await apurarDiaDaBarbearia(DOMARI, DIA)).agendamentos).toBe(1);
    expect((await apurarDiaDaBarbearia(DOMARI, '2026-09-13')).agendamentos).toBe(0);
  });

  it('a apuração de uma barbearia não enxerga a agenda da outra', async () => {
    await marcar(DOMARI, LOCAL, RUAN, 9, 'completed', 'website');
    await marcar(RIVAL, LOCAL_RIVAL, RUAN_RIVAL, 9, 'completed', 'website');
    await marcar(RIVAL, LOCAL_RIVAL, RUAN_RIVAL, 10, 'completed', 'website');

    expect((await apurarDiaDaBarbearia(DOMARI, DIA)).agendamentos).toBe(1);
    expect((await apurarDiaDaBarbearia(RIVAL, DIA)).agendamentos).toBe(2);

    // E a jornada também: 480 minutos contra 480 seria coincidência boa demais.
    expect((await apurarDiaDaBarbearia(DOMARI, DIA)).minutosDisponiveis).toBe(480);
    expect((await apurarDiaDaBarbearia(RIVAL, DIA)).minutosDisponiveis).toBe(480);
  });

  it('grava o agregado, e reapurar o mesmo dia corrige em vez de somar', async () => {
    await marcar(DOMARI, LOCAL, RUAN, 9, 'completed', 'website');
    await apurarDiaDaBarbearia(DOMARI, DIA);
    expect(await lido(DOMARI)).toMatchObject({ appointments_total: 1 });

    await marcar(DOMARI, LOCAL, RUAN, 10, 'completed', 'website');
    await apurarDiaDaBarbearia(DOMARI, DIA);

    const linha = await lido(DOMARI);
    expect(linha).toMatchObject({ appointments_total: 2 });

    const total = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM tenant_metrics_daily WHERE tenant_id = '${DOMARI}'`,
    );
    expect(Number(total[0]?.n)).toBe(1);
  });

  it('soma a comanda paga pelo dia da unidade, não pelo instante do fechamento', async () => {
    await exec(`
      INSERT INTO orders (tenant_id, location_id, status, total_cents, business_day, closed_at)
      VALUES ('${DOMARI}', '${LOCAL}', 'paid', 9900, '${DIA}', '2026-09-13T02:00:00Z'),
             ('${DOMARI}', '${LOCAL}', 'paid', 5000, '${DIA}', '2026-09-12T20:00:00Z'),
             ('${DOMARI}', '${LOCAL}', 'open', 7000, '${DIA}', NULL)
    `);

    const apurado = await apurarDiaDaBarbearia(DOMARI, DIA);

    // A comanda aberta não é receita, e a fechada de madrugada é do sábado.
    expect(apurado.receitaCents).toBe(14900);
    expect(apurado.comandasPagas).toBe(2);
  });

  it('barbearia sem nada apura zeros, e zero é resposta', async () => {
    // Sem a linha, a plataforma não distingue "não teve movimento" de "o worker
    // está parado" — e as duas coisas pedem providências opostas.
    const apurado = await apurarDiaDaBarbearia(DOMARI, DIA);

    expect(apurado.agendamentos).toBe(0);
    expect(apurado.receitaCents).toBe(0);
    expect(await lido(DOMARI)).not.toBeNull();
  });

  // -- o enfileiramento em massa ---------------------------------------------

  it('enfileira uma tarefa por barbearia, e a chave carrega o tenant', async () => {
    // O índice de idempotência de `jobs` é global. Uma chave só com o dia
    // deixaria exatamente uma barbearia ser apurada — e o ON CONFLICT engoliria
    // as outras sem erro nenhum.
    await agendarApuracaoDeTodas({ dia: DIA });

    const linhas = await admin.$queryRawUnsafe<{ tenant_id: string; idempotency_key: string }[]>(
      `SELECT tenant_id, idempotency_key FROM jobs WHERE kind = 'metricas.dia' ORDER BY tenant_id`,
    );
    expect(linhas).toHaveLength(2);
    expect(new Set(linhas.map((l) => l.idempotency_key)).size).toBe(2);
  });

  it('enfileirar duas vezes o mesmo dia não duplica tarefa', async () => {
    await agendarApuracaoDeTodas({ dia: DIA });
    await agendarApuracaoDeTodas({ dia: DIA });

    const linhas = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM jobs WHERE kind = 'metricas.dia'`,
    );
    expect(Number(linhas[0]?.n)).toBe(2);
  });

  it('a retenção também sai uma por barbearia, com a chave carregando o tenant', async () => {
    /**
     * Mesmo índice global de idempotência, mesma armadilha: uma chave só com o
     * dia deixaria uma barbearia ser varrida e as outras seriam engolidas pelo
     * `ON CONFLICT` sem erro nenhum — e ninguém notaria, porque o resultado
     * esperado da varredura é "nada a fazer" na maioria dos dias.
     */
    await agendarRetencaoDeTodas({ dia: DIA });
    await agendarRetencaoDeTodas({ dia: DIA });

    const linhas = await admin.$queryRawUnsafe<{ tenant_id: string; idempotency_key: string }[]>(
      `SELECT tenant_id, idempotency_key FROM jobs WHERE kind = 'lgpd.retencao' ORDER BY tenant_id`,
    );
    expect(linhas).toHaveLength(2);
    expect(new Set(linhas.map((l) => l.idempotency_key)).size).toBe(2);
  });

  it('barbearia bloqueada não varre retenção — ela não pode nem ler o aviso', async () => {
    // Anonimizar cadastro de quem está fora do ar seria apagar dado pelas
    // costas de alguém sem chance de reagir ao aviso prévio.
    await exec(`
      UPDATE tenant_platform SET blocked_at = now(), blocked_reason = 'inadimplente'
       WHERE tenant_id = '${RIVAL}'
    `);

    await agendarRetencaoDeTodas({ dia: DIA });

    const linhas = await admin.$queryRawUnsafe<{ tenant_id: string }[]>(
      `SELECT tenant_id FROM jobs WHERE kind = 'lgpd.retencao'`,
    );
    expect(linhas.map((l) => l.tenant_id)).toEqual([DOMARI]);
  });

  it('barbearia bloqueada não é apurada', async () => {
    await exec(`
      UPDATE tenant_platform SET blocked_at = now(), blocked_reason = 'inadimplente'
       WHERE tenant_id = '${RIVAL}'
    `);

    await agendarApuracaoDeTodas({ dia: DIA });

    const linhas = await admin.$queryRawUnsafe<{ tenant_id: string }[]>(
      `SELECT tenant_id FROM jobs WHERE kind = 'metricas.dia'`,
    );
    expect(linhas.map((l) => l.tenant_id)).toEqual([DOMARI]);
  });
});

describe('quando varrer a retenção', () => {
  it('roda de madrugada, com o Brasil inteiro fechado', () => {
    // A varredura **escreve**, e escrever no meio do expediente disputa conexão
    // com o balcão. 5h UTC são 2h em Salvador e meia-noite em Rio Branco.
    const { dia, quando } = retencaoPendente(new Date('2026-09-13T14:00:00Z'));
    expect(dia).toBe('2026-09-13');
    expect(quando.toISOString()).toBe('2026-09-13T05:00:00.000Z');
  });

  it('o dia é o mesmo durante as vinte e quatro horas', () => {
    // A variável do worker compara o dia para não reenfileirar a cada volta do
    // laço. Um dia que mudasse no meio da tarde faria a varredura sair duas
    // vezes — inofensivo pelo índice, e ruidoso à toa.
    expect(retencaoPendente(new Date('2026-09-13T00:01:00Z')).dia).toBe('2026-09-13');
    expect(retencaoPendente(new Date('2026-09-13T23:59:00Z')).dia).toBe('2026-09-13');
  });
});

describe('quando apurar', () => {
  it('apura o dia anterior, e só depois de ele ter acabado no Brasil inteiro', () => {
    // 00:05 UTC ainda são 21:05 do mesmo dia em Salvador. Apurar ali cortaria
    // fora o movimento da noite, que é quando a barbearia enche.
    const { dia, quando } = apuracaoPendente(new Date('2026-09-13T00:05:00Z'));

    expect(dia).toBe('2026-09-12');
    expect(quando.toISOString()).toBe('2026-09-13T09:00:00.000Z');
  });

  it('e não fica esperando quando o worker sobe depois da hora', () => {
    const { dia, quando } = apuracaoPendente(new Date('2026-09-13T14:00:00Z'));

    expect(dia).toBe('2026-09-12');
    // No passado: o worker toma a tarefa na primeira rodada.
    expect(quando.getTime()).toBeLessThan(new Date('2026-09-13T14:00:00Z').getTime());
  });

  it('atravessa a virada do mês sem inventar dia 0', () => {
    expect(apuracaoPendente(new Date('2026-09-01T10:00:00Z')).dia).toBe('2026-08-31');
    expect(apuracaoPendente(new Date('2026-01-01T10:00:00Z')).dia).toBe('2025-12-31');
  });
});
