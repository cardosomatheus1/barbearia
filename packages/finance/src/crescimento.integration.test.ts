import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crescimentoDaCasa } from './crescimento.js';

/**
 * As métricas de série longa contra Postgres real (bloco 62).
 *
 * O que só o banco prova: que a linha do gráfico bate com `business_day` e não
 * com o instante do pagamento, que dia sem venda aparece na série, e que as
 * horas de agenda aberta saem da jornada de verdade — com a pausa descontada.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '62626262-2222-2222-2222-222222222222';
const LOCAL = 'a6262622-0000-0000-0000-000000000001';
const OUTRO_LOCAL = 'a6262622-0000-0000-0000-000000000002';
const RUAN = 'b6262622-0000-0000-0000-000000000001';

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const cliente = (n: number) => `c6262622-0000-0000-0000-${String(n).padStart(12, '0')}`;

async function venda(opcoes: {
  dia: string;
  cents: number;
  clienteN?: number;
  local?: string;
  fechadaEm?: string;
}): Promise<void> {
  const { dia, cents, clienteN, local = LOCAL, fechadaEm } = opcoes;
  await exec(`
    INSERT INTO orders (tenant_id, location_id, customer_id, status, business_day,
                        subtotal_cents, total_cents, closed_at)
    VALUES ('${TENANT}', '${local}',
            ${clienteN === undefined ? 'NULL' : `'${cliente(clienteN)}'`},
            'paid', '${dia}', ${cents}, ${cents},
            '${fechadaEm ?? `${dia}T20:00:00Z`}')
  `);
}

async function atendimento(clienteN: number, quando: string, local = LOCAL): Promise<void> {
  await exec(`
    INSERT INTO appointments
      (tenant_id, location_id, customer_id, professional_id, status,
       starts_at, ends_at, service_starts_at, service_ends_at)
    VALUES ('${TENANT}', '${local}', '${cliente(clienteN)}', '${RUAN}', 'completed',
            '${quando}', '${quando}'::timestamptz + interval '30 minutes',
            '${quando}', '${quando}'::timestamptz + interval '30 minutes')
  `);
}

describeIfDb('as métricas de série longa', () => {
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
      INSERT INTO locations (id, tenant_id, name, timezone) VALUES
        ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia'),
        ('${OUTRO_LOCAL}', '${TENANT}', 'Filial', 'America/Bahia');
      INSERT INTO professionals (id, tenant_id, location_id, name)
      VALUES ('${RUAN}', '${TENANT}', '${LOCAL}', 'Ruan');
    `);
    for (let n = 1; n <= 8; n += 1) {
      await exec(`
        INSERT INTO customers (id, tenant_id, name, phone_e164)
        VALUES ('${cliente(n)}', '${TENANT}', 'Cliente ${n}', '+55719${String(30000000 + n).slice(-8)}')
      `);
    }
  });

  const pedir = (extra: Record<string, unknown> = {}) =>
    crescimentoDaCasa({
      tenantId: TENANT,
      de: '2026-03-01',
      ate: '2026-03-07',
      perdidos: 0,
      comRitmo: 0,
      ...extra,
    });

  it('o dia sem venda aparece na série, com zero', async () => {
    /**
     * Uma linha que pula o dia vazio desenha a semana com menos pontos
     * igualmente espaçados, e o gráfico passa a mentir sobre o ritmo do
     * movimento.
     */
    await venda({ dia: '2026-03-02', cents: 50000 });
    await venda({ dia: '2026-03-05', cents: 30000 });

    const c = await pedir();
    expect(c.serie.pontos).toHaveLength(7);
    expect(c.serie.pontos.map((p) => p.valorCents)).toEqual([0, 50000, 0, 0, 30000, 0, 0]);
    expect(c.serie.totalCents).toBe(80000);
  });

  it('o recorte é o dia da barbearia, não o instante do pagamento', async () => {
    /**
     * A decisão do bloco 19. Uma venda fechada às 2h da manhã do dia 8 pertence
     * ao dia 7 se foi assim que o caixa fechou — e é o fechamento que o balcão
     * conferiu e assinou.
     */
    await venda({ dia: '2026-03-07', cents: 40000, fechadaEm: '2026-03-08T02:30:00Z' });

    const c = await pedir();
    expect(c.serie.pontos[6]?.valorCents).toBe(40000);
    expect(c.serie.totalCents).toBe(40000);
  });

  it('retenção é de quem já vinha antes, e não da base inteira', async () => {
    /**
     * "Já vinha antes" é o período imediatamente anterior, não *qualquer visita
     * anterior*. Sem esse recorte, quem veio uma vez há três anos e nunca mais
     * derrubaria a retenção — por gente que a barbearia já tinha perdido antes de
     * a janela começar.
     */
    // Dois vinham na janela anterior; só um voltou.
    await atendimento(1, '2026-02-20T14:00:00Z');
    await atendimento(2, '2026-02-21T14:00:00Z');
    await atendimento(1, '2026-03-03T14:00:00Z');
    // E um de muito antes, que não entra no denominador.
    await atendimento(3, '2023-01-10T14:00:00Z');

    const c = await pedir();
    expect(c.retencaoBps).toBe(5000);
  });

  it('sem quem comparar, a retenção é nula e não zero', async () => {
    // Zero diria "ninguém voltou"; nulo diz "não havia de quem perguntar". A
    // barbearia no primeiro mês é o caso, e é quando o dono abre o relatório.
    const c = await pedir();
    expect(c.retencaoBps).toBeNull();
    expect(c.valorPorClienteCents).toBeNull();
  });

  it('as horas abertas saem da jornada, com a pausa descontada', async () => {
    /**
     * Hora de almoço não é agenda aberta. Incluí-la faria o indicador dizer que
     * a casa rende menos por hora do que rende — e o dono decidir preço em cima
     * disso.
     */
    await exec(`
      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute, breaks)
      VALUES ('${TENANT}', '${RUAN}', 1, 540, 1080, '[{"start":720,"end":780}]'::jsonb)
    `);
    await venda({ dia: '2026-03-02', cents: 80000 });

    // 2026-03-02 é a única segunda-feira da janela: 9h às 18h menos 1h = 8h.
    const c = await pedir();
    expect(c.receitaPorHoraCents).toBe(10000);
  });

  it('sem jornada cadastrada, a receita por hora é nula', async () => {
    await venda({ dia: '2026-03-02', cents: 80000 });
    const c = await pedir();
    expect(c.receitaPorHoraCents).toBeNull();
  });

  it('o abandono chega de fora, e aparece', async () => {
    /**
     * "Perdido" é a definição do bloco 61 e depende da mediana dos intervalos de
     * cada pessoa — não cabe numa cláusula sobre uma linha. Recalculá-lo aqui
     * faria o painel do dono discordar da ficha do cliente sobre a mesma pessoa.
     */
    const c = await pedir({ perdidos: 8, comRitmo: 80 });
    expect(c.churnBps).toBe(1000);
  });

  it('a unidade recorta a série e as cadeiras', async () => {
    await venda({ dia: '2026-03-02', cents: 50000, local: LOCAL });
    await venda({ dia: '2026-03-03', cents: 90000, local: OUTRO_LOCAL });

    const matriz = await pedir({ locationId: LOCAL });
    expect(matriz.serie.totalCents).toBe(50000);
    // Uma cadeira na matriz: a receita por cadeira é a receita dela inteira.
    expect(matriz.receitaPorCadeiraCents).toBe(50000);

    const rede = await pedir();
    expect(rede.serie.totalCents).toBe(140000);
  });

  it('a barbearia vizinha não entra na conta', async () => {
    await venda({ dia: '2026-03-02', cents: 50000 });
    const daVizinha = await crescimentoDaCasa({
      tenantId: '62626262-9999-9999-9999-999999999999',
      de: '2026-03-01',
      ate: '2026-03-07',
      perdidos: 0,
      comRitmo: 0,
    });
    expect(daVizinha.serie.totalCents).toBe(0);
  });
});
