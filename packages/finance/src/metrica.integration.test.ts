import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { medir } from './metrica.js';

/**
 * O executor do schema semântico contra Postgres real (bloco 63).
 *
 * O que só o banco prova: que cada métrica sai da consulta que diz sair, que a
 * dimensão agrupa pelo que promete, e que o ticket médio é a soma sobre a
 * contagem — nunca a média das médias.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '63636363-1111-1111-1111-111111111111';
const LOCAL = 'a6363636-0000-0000-0000-000000000001';
const JOAO = 'b6363636-0000-0000-0000-000000000001';
const RUAN = 'b6363636-0000-0000-0000-000000000002';
const CLIENTE = 'c6363636-0000-0000-0000-000000000001';

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

let sequencia = 0;

/** Um atendimento e, quando pago, a comanda dele. */
async function atender(opcoes: {
  profissional: string;
  dia: string;
  cents: number;
  status?: 'completed' | 'no_show';
  pago?: boolean;
  minutos?: number;
}): Promise<void> {
  const { profissional, dia, cents, status = 'completed', pago = true, minutos = 30 } = opcoes;
  sequencia += 1;
  const inicio = `${dia}T${String(8 + (sequencia % 8)).padStart(2, '0')}:${String(
    (sequencia * 7) % 60,
  ).padStart(2, '0')}:00Z`;
  const id = `d6363636-0000-0000-0000-${String(sequencia).padStart(12, '0')}`;
  await exec(`
    INSERT INTO appointments
      (id, tenant_id, location_id, customer_id, professional_id, price_cents, status,
       starts_at, ends_at, service_starts_at, service_ends_at)
    VALUES ('${id}', '${TENANT}', '${LOCAL}', '${CLIENTE}', '${profissional}', ${cents}, '${status}',
            '${inicio}', '${inicio}'::timestamptz + interval '${minutos} minutes',
            '${inicio}', '${inicio}'::timestamptz + interval '${minutos} minutes')
  `);
  if (pago && status === 'completed') {
    await exec(`
      INSERT INTO orders (tenant_id, location_id, customer_id, appointment_id, status,
                          business_day, subtotal_cents, total_cents, closed_at)
      VALUES ('${TENANT}', '${LOCAL}', '${CLIENTE}', '${id}', 'paid',
              '${dia}', ${cents}, ${cents}, '${inicio}')
    `);
  }
}

const pedir = (metrica: string, dimensao = 'nenhuma') =>
  medir({
    tenantId: TENANT,
    metrica: metrica as never,
    dimensao: dimensao as never,
    de: '2026-03-02',
    ate: '2026-03-08',
  });

describeIfDb('o executor do schema semântico', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    sequencia = 0;
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari');
      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia');
      INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
        ('${JOAO}', '${TENANT}', '${LOCAL}', 'João'),
        ('${RUAN}', '${TENANT}', '${LOCAL}', 'Ruan');
      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CLIENTE}', '${TENANT}', 'Carlos', '+5571988880000');
    `);
  });

  it('o faturamento soma as comandas pagas do período', async () => {
    await atender({ profissional: JOAO, dia: '2026-03-03', cents: 5000 });
    await atender({ profissional: RUAN, dia: '2026-03-04', cents: 7000 });
    // Fora da janela: não entra.
    await atender({ profissional: JOAO, dia: '2026-02-20', cents: 9900 });

    const r = await pedir('faturamento');
    expect(r.total).toBe(12000);
    expect(r.fatias).toEqual([]);
  });

  it('a dimensão por profissional agrupa por quem atendeu', async () => {
    await atender({ profissional: JOAO, dia: '2026-03-03', cents: 5000 });
    await atender({ profissional: JOAO, dia: '2026-03-04', cents: 3000 });
    await atender({ profissional: RUAN, dia: '2026-03-04', cents: 7000 });

    const r = await pedir('faturamento', 'profissional');
    expect(r.total).toBe(15000);
    expect(r.fatias).toEqual([
      { rotulo: 'João', valor: 8000 },
      { rotulo: 'Ruan', valor: 7000 },
    ]);
  });

  it('o ticket médio é a soma sobre a contagem, não a média das médias', async () => {
    /**
     * João faz duas comandas de R$ 30 e Ruan uma de R$ 120. A média das médias
     * daria R$ 75; o ticket da casa é R$ 60. A primeira dá peso igual a quem fez
     * duas comandas e a quem fez uma.
     */
    await atender({ profissional: JOAO, dia: '2026-03-03', cents: 3000 });
    await atender({ profissional: JOAO, dia: '2026-03-04', cents: 3000 });
    await atender({ profissional: RUAN, dia: '2026-03-04', cents: 12000 });

    /**
     * O total é pedido **com** a dimensão, e é isso que torna o teste capaz de
     * falhar.
     *
     * Sem dimensão o agrupamento devolve uma linha só, e a média de um elemento
     * é igual à soma sobre a contagem — o teste passava com e sem o conserto.
     * Com a dimensão são dois grupos, e aí os dois cálculos discordam: R$ 75
     * contra R$ 60.
     */
    const porBarbeiro = await pedir('ticket_medio', 'profissional');
    expect(porBarbeiro.total).toBe(6000);
    expect(porBarbeiro.fatias).toEqual([
      { rotulo: 'Ruan', valor: 12000 },
      { rotulo: 'João', valor: 3000 },
    ]);

    // E sem dimensão o número é o mesmo: é a mesma conta, não outra.
    expect((await pedir('ticket_medio')).total).toBe(6000);
  });

  it('faltas conta linhas, e a perda soma o preço delas', async () => {
    await atender({ profissional: JOAO, dia: '2026-03-03', cents: 5000, status: 'no_show' });
    await atender({ profissional: RUAN, dia: '2026-03-04', cents: 8000, status: 'no_show' });
    await atender({ profissional: JOAO, dia: '2026-03-05', cents: 4000 });

    expect((await pedir('faltas')).total).toBe(2);
    expect((await pedir('perda_por_falta')).total).toBe(13000);
    expect((await pedir('atendimentos')).total).toBe(1);
  });

  it('a ocupação sai da jornada, com a pausa descontada', async () => {
    /**
     * Duas horas vendidas numa segunda de oito horas úteis. "Horas × cadeiras ×
     * dias" daria outro número em toda barbearia que fecha um dia da semana — e
     * todas fecham.
     */
    await exec(`
      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute, breaks)
      VALUES ('${TENANT}', '${JOAO}', 1, 540, 1080, '[{"start":720,"end":780}]'::jsonb)
    `);
    // 2026-03-02 é a única segunda da janela: 9h–18h menos 1h = 480 min.
    await atender({ profissional: JOAO, dia: '2026-03-02', cents: 5000, minutos: 120 });

    const r = await pedir('ocupacao');
    expect(r.total).toBe(2500);
  });

  it('sem jornada cadastrada a ocupação é nula, não zero', async () => {
    // Zero diria "a agenda ficou vazia"; nulo diz "não há agenda cadastrada".
    await atender({ profissional: JOAO, dia: '2026-03-03', cents: 5000 });
    expect((await pedir('ocupacao')).total).toBeNull();
  });

  it('a ocupação total é sobre as somas, nunca a média das fatias', async () => {
    /**
     * João trabalha um dia e vende tudo; Ruan trabalha um dia e não vende nada.
     * A média das porcentagens daria 50%; a ocupação da casa é o que foi vendido
     * sobre o que foi aberto — e ela depende de quanto cada um abre.
     */
    await exec(`
      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      VALUES ('${TENANT}', '${JOAO}', 1, 540, 600),
             ('${TENANT}', '${RUAN}', 1, 540, 1080)
    `);
    await atender({ profissional: JOAO, dia: '2026-03-02', cents: 5000, minutos: 60 });

    /**
     * Pedido **por profissional**, pela mesma razão do ticket: sem dimensão o
     * agrupamento tem uma linha só e os dois cálculos coincidem.
     *
     * João vende 100% de uma hora; Ruan vende 0% de nove. A média das
     * porcentagens daria 50%, e a ocupação da casa é 10% — 60 minutos vendidos
     * sobre 600 abertos.
     */
    const r = await pedir('ocupacao', 'profissional');
    expect(r.total).toBe(1000);
    expect(r.fatias).toEqual([
      { rotulo: 'João', valor: 10000 },
      { rotulo: 'Ruan', valor: 0 },
    ]);
  });

  it('métrica que mora em outro pacote devolve vazio, e não um número inventado', async () => {
    /**
     * `clientes_em_risco` é `packages/crm` e `margem_por_servico` é `dre.ts`.
     * Reescrever qualquer uma aqui faria o assistente discordar da tela sobre o
     * mesmo número — quem as compõe é a borda.
     */
    await atender({ profissional: JOAO, dia: '2026-03-03', cents: 5000 });
    expect((await pedir('clientes_em_risco')).total).toBeNull();
    expect((await pedir('margem_por_servico', 'servico')).total).toBeNull();
  });

  it('a barbearia vizinha não entra em nenhuma métrica', async () => {
    await atender({ profissional: JOAO, dia: '2026-03-03', cents: 5000 });
    const daVizinha = await medir({
      tenantId: '63636363-9999-9999-9999-999999999999',
      metrica: 'faturamento',
      dimensao: 'nenhuma',
      de: '2026-03-02',
      ate: '2026-03-08',
    });
    expect(daVizinha.total).toBe(0);
  });
});
