import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { diagnosticarCatalogo } from './validador.js';

/**
 * O validador contra Postgres real — SPEC §5.7, que resolve D4 e D5.
 *
 * A regra tem teste puro em `core`. O que só aparece aqui: que a duração real
 * medida é a **mediana de atendimentos de um serviço só**, que "faz tudo" conta
 * como habilitado, e que o diagnóstico de uma barbearia não enxerga a outra.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOCAL_RIVAL = 'aaaaaaaa-0000-0000-0000-000000000002';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const CORTE = 'eeeeeeee-0000-0000-0000-000000000001';
const BARBA = 'eeeeeeee-0000-0000-0000-000000000002';
const CARLOS = 'cccccccc-0000-0000-0000-000000000001';

let admin: PrismaClient;
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const AGORA = new Date('2026-09-10T14:00:00Z');

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(parte);
  }
}

describeIfDb('validador de catálogo', () => {
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

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', '${RUAN}', d.weekday, 540, 1080
      FROM (VALUES (1), (2), (3), (4), (5)) AS d(weekday);

      INSERT INTO service_categories (id, tenant_id, name) VALUES
        ('caca0000-0000-0000-0000-000000000001', '${TENANT}', 'Cabelo'),
        ('caca0000-0000-0000-0000-000000000002', '${TENANT}', 'Barba');

      INSERT INTO services
        (id, tenant_id, category_id, name, description, photo_url, price_cents, duration_minutes)
      VALUES
        ('${CORTE}', '${TENANT}', 'caca0000-0000-0000-0000-000000000001', 'Corte',
         'Corte na máquina e tesoura', 'https://exemplo.com/c.jpg', 5000, 30),
        ('${BARBA}', '${TENANT}', 'caca0000-0000-0000-0000-000000000002', 'Barba',
         'Barba com toalha quente', 'https://exemplo.com/b.jpg', 4000, 30);

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');
    `);
  });

  const diagnostico = (tenantId = TENANT, locationId = LOCATION) =>
    diagnosticarCatalogo({ tenantId, locationId, agora: AGORA });

  /** Um atendimento concluído com duração real medida. */
  async function atendeu(params: {
    readonly id: string;
    readonly minutos: number;
    readonly servicos?: readonly string[];
    readonly quando?: string;
  }): Promise<void> {
    /**
     * Cada um no seu horário.
     *
     * `appointments_no_overlap` recusa dois atendimentos sobrepostos no mesmo
     * profissional — é a garantia anti-overbooking do bloco 1, e ela vale
     * também para a semente. A primeira versão deste fixture empilhava vinte
     * atendimentos às 14h e o banco recusou, com razão.
     */
    const base = params.quando ?? '2026-09-01T09:00:00Z';
    const deslocamento = Number(params.id.slice(-4)) * 6 * 60 * 60_000;
    const inicio = new Date(new Date(base).getTime() + deslocamento).toISOString();
    const fim = new Date(new Date(inicio).getTime() + params.minutos * 60_000).toISOString();
    const servicos = params.servicos ?? [CORTE];

    await exec(admin, `
      INSERT INTO appointments
        (id, tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at,
         price_cents, status, started_at, completed_at)
      VALUES ('${params.id}', '${TENANT}', '${LOCATION}', '${CARLOS}', '${RUAN}',
              '${inicio}', '${fim}', '${inicio}', '${fim}', 5000, 'completed',
              '${inicio}', '${fim}')
    `);

    for (const [posicao, servicoId] of servicos.entries()) {
      await admin.$executeRawUnsafe(`
        INSERT INTO appointment_services
          (appointment_id, service_id, tenant_id, position, price_cents, duration_minutes)
        VALUES ('${params.id}', '${servicoId}', '${TENANT}', ${posicao}, 5000, 30)
      `);
    }
  }

  const uuid = (n: number) => `f0000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

  it('catálogo bem cadastrado não gera achado', async () => {
    // O caso mais importante: alerta sem defeito é como a barbearia aprende a
    // ignorar todos.
    const { achados, examinados } = await diagnostico();
    expect(achados).toEqual([]);
    expect(examinados).toBe(2);
  });

  it('"faz tudo" conta como habilitado (V5)', async () => {
    /**
     * A convenção do cadastro desde o bloco 13: profissional sem vínculo
     * explícito executa tudo. Contar só o vínculo acusaria de órfão todo
     * serviço numa barbearia que nunca restringiu ninguém.
     */
    const { achados } = await diagnostico();
    expect(achados.map((a) => a.regra)).not.toContain('V5');
  });

  it('serviço fora da lista de quem restringiu vira achado (V5)', async () => {
    await admin.$executeRawUnsafe(`
      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      VALUES ('${RUAN}', '${CORTE}', '${TENANT}')
    `);

    const { achados } = await diagnostico();
    const v5 = achados.filter((a) => a.regra === 'V5');
    expect(v5).toHaveLength(1);
    expect(v5[0]?.alvoNome).toBe('Barba');
  });

  it('a duração real é a mediana, não a média (V7)', async () => {
    /**
     * Um atendimento que parou pelo telefone puxa a média e não move a mediana.
     * A SPEC pede mediana, e é ela que decide se o alerta aparece.
     */
    for (let i = 0; i < 20; i += 1) {
      // Dezenove de 45 min e um de 300: a média passaria de 57, a mediana fica
      // em 45. Nos dois casos há achado, mas o número sugerido é diferente.
      await atendeu({ id: uuid(i), minutos: i === 0 ? 300 : 45 });
    }

    const { achados } = await diagnostico();
    const v7 = achados.find((a) => a.regra === 'V7');
    expect(v7?.titulo).toContain('45 min');
    expect(v7?.conserto).toContain('45 min');
  });

  it('atendimento com dois serviços não entra na medição (V7)', async () => {
    /**
     * Com dois serviços no mesmo atendimento, o tempo medido é o dos dois
     * juntos — e a mediana do corte viraria a do corte com barba, que é o
     * próprio defeito D4 ao contrário.
     */
    for (let i = 0; i < 25; i += 1) {
      await atendeu({ id: uuid(i), minutos: 80, servicos: [CORTE, BARBA] });
    }

    const { achados } = await diagnostico();
    expect(achados.map((a) => a.regra)).not.toContain('V7');
  });

  it('atendimento velho não conta na medição (V7)', async () => {
    // Noventa dias: o barbeiro que ficou mais rápido este ano não é julgado
    // pelo ano passado.
    for (let i = 0; i < 25; i += 1) {
      await atendeu({ id: uuid(i), minutos: 50, quando: '2026-01-10T14:00:00Z' });
    }

    const { achados } = await diagnostico();
    expect(achados.map((a) => a.regra)).not.toContain('V7');
  });

  it('o combo curto é acusado com a tolerância da casa (V1)', async () => {
    // O defeito D4 exato: combo com 30 min e as partes somando 60.
    await exec(admin, `
      INSERT INTO services (id, tenant_id, name, description, photo_url, price_cents, duration_minutes)
      VALUES ('eeeeeeee-0000-0000-0000-000000000003', '${TENANT}', 'Cabelo + Barba',
              'Os dois na sequência', 'https://exemplo.com/cb.jpg', 8000, 30);

      INSERT INTO service_combos (id, tenant_id, name, declared_duration_minutes, tolerance_minutes)
      VALUES ('c0000000-0000-0000-0000-000000000001', '${TENANT}', 'Cabelo + Barba', 30, 10);

      INSERT INTO service_combo_components (combo_id, service_id, tenant_id) VALUES
        ('c0000000-0000-0000-0000-000000000001', '${CORTE}', '${TENANT}'),
        ('c0000000-0000-0000-0000-000000000001', '${BARBA}', '${TENANT}')
    `);

    const { achados } = await diagnostico();
    const v1 = achados.find((a) => a.regra === 'V1');
    expect(v1?.severidade).toBe('bloqueia');
    expect(v1?.titulo).toContain('60 min');
    // 60 de soma menos 10 de tolerância: o conserto sugere 50.
    expect(v1?.conserto).toContain('50 min');
  });

  it('a jornada de balcão é acusada (V9/D12)', async () => {
    await exec(admin, `
      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('bbbbbbbb-0000-0000-0000-000000000009', '${TENANT}', '${LOCATION}', 'Cadeira 2', 'professional');

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', 'bbbbbbbb-0000-0000-0000-000000000009', d.weekday, 480, 1380
      FROM (VALUES (0), (1), (2), (3), (4), (5), (6)) AS d(weekday)
    `);

    const { achados } = await diagnostico();
    const v9 = achados.find((a) => a.regra === 'V9');
    expect(v9?.alvoNome).toBe('Cadeira 2');
  });

  it('o diagnóstico de uma barbearia não enxerga a outra', async () => {
    // A rival tem unidade e nenhum serviço: se a RLS falhasse, ela veria os
    // dois serviços da casa.
    const { achados, examinados } = await diagnostico(RIVAL, LOCAL_RIVAL);
    expect(examinados).toBe(0);
    expect(achados).toEqual([]);
  });

  it('a unidade errada não vaza serviço de outra barbearia', async () => {
    // Id de unidade é entrada externa. Com o tenant da casa e a unidade da
    // rival, o que sai é o catálogo da casa sem profissional nenhum — nunca o
    // dado da rival.
    const { achados } = await diagnostico(TENANT, LOCAL_RIVAL);
    expect(achados.filter((a) => a.regra === 'V5')).toHaveLength(2);
    expect(JSON.stringify(achados)).not.toContain('Rival');
  });
});
