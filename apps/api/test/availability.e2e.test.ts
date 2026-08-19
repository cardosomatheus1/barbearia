import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { limparBanco } from './limpar.js';

/**
 * End-to-end de `GET /v1/b/:slug/availability`.
 *
 * `SEED_DATABASE_URL` é superusuário e serve só para semear. A aplicação sob
 * teste conecta por `DATABASE_URL` com o role restrito, então a RLS está ativa
 * em tudo que os testes exercitam.
 *
 * Sobe a aplicação de verdade contra Postgres real: a validação de entrada, a
 * resolução de slug, a RLS e o motor participam todos. Mock aqui não provaria
 * nada sobre o que interessa.
 */

const ADMIN_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOCATION_RIVAL = 'aaaaaaaa-0000-0000-0000-000000000002';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const CABELO = 'eeeeeeee-0000-0000-0000-000000000001';
const BARBA = 'eeeeeeee-0000-0000-0000-000000000002';

/**
 * A semana da grade, sempre no futuro.
 *
 * Era `'2026-08-11'` escrito à mão — uma terça futura no dia em que o teste foi
 * escrito. Hoje ela **é hoje**, e depois das nove da manhã a API para de
 * devolver os primeiros horários: a antecedência mínima os descarta, o teste
 * esperava `09:00` e recebia `13:00`. Amanhã a data vira passado e ele quebra
 * de outro jeito, com a grade inteira vazia.
 *
 * A data agora é derivada: a segunda-feira pelo menos catorze dias à frente. O
 * teste volta a ser sobre a **grade**, e não sobre que dia é hoje.
 *
 * Os instantes em UTC saem da mesma conta. `America/Bahia` é UTC−3 o ano
 * inteiro — não há horário de verão no Brasil desde 2019 —, então `09:00`
 * local é sempre `12:00Z`, e escrever isso à mão seria repetir a aritmética
 * que já falhou uma vez.
 */
function segundaDaqui(dias: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + dias);
  // 1 = segunda. Anda para a frente até cair nela.
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const SEGUNDA = segundaDaqui(14);
const diaSeguinte = (dia: string, n: number): string => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const TERCA = diaSeguinte(SEGUNDA, 1);
/** 09:00 em America/Bahia (UTC−3, sem horário de verão). */
const AS_NOVE_EM_UTC = `${TERCA}T12:00:00.000Z`;

let app: INestApplication;
let admin: PrismaClient;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(statement);
  }
}

const describeIfDb = ADMIN_URL && APP_URL ? describe : describe.skip;

describeIfDb('GET /v1/b/:slug/availability', () => {
  beforeAll(async () => {
    if (!ADMIN_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });

    await limparBanco(admin);
    await exec(admin, `
      INSERT INTO tenants (id, name) VALUES
        ('${TENANT}', 'Domari Barber Club'), ('${RIVAL}', 'Barbearia Rival');

      INSERT INTO tenant_slugs (slug, tenant_id, is_primary) VALUES
        ('domari', '${TENANT}', true),
        ('boxseisbarbearia', '${TENANT}', false),
        ('rival', '${RIVAL}', true);

      INSERT INTO locations (id, tenant_id, name, timezone, granularity_minutes, min_lead_minutes)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia', 15, 30),
             ('${LOCATION_RIVAL}', '${RIVAL}', 'Rival', 'America/Sao_Paulo', 15, 30);

      INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
        ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes) VALUES
        ('${CABELO}', '${TENANT}', 'Cabelo', 4900, 20),
        ('${BARBA}', '${TENANT}', 'Barba', 3500, 20);

      INSERT INTO professional_services (professional_id, service_id, tenant_id) VALUES
        ('${RUAN}', '${CABELO}', '${TENANT}'),
        ('${RUAN}', '${BARBA}', '${TENANT}');

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', '${RUAN}', d.weekday, 540, 1080
      FROM (VALUES (2), (3), (4), (5), (6)) AS d(weekday);
    `);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
  });

  const url = (slug: string, query: Record<string, string>): string =>
    `/v1/b/${slug}/availability?${new URLSearchParams(query).toString()}`;

  const ok = { locationId: LOCATION, serviceIds: CABELO, dateFrom: TERCA };

  // -- caminho feliz ---------------------------------------------------------

  it('devolve a grade do dia', async () => {
    const response = await request(app.getHttpServer()).get(url('domari', ok)).expect(200);

    expect(response.body.timezone).toBe('America/Bahia');
    expect(response.body.days).toHaveLength(1);
    expect(response.body.days[0].date).toBe(TERCA);
    expect(response.body.days[0].slots[0]).toMatchObject({
      start: '09:00',
      end: '09:20',
      startsAt: AS_NOVE_EM_UTC,
      professionalId: RUAN,
      priceCents: 4900,
    });
  });

  it('resolve o slug legado — o link da bio não pode quebrar', async () => {
    const response = await request(app.getHttpServer())
      .get(url('boxseisbarbearia', ok))
      .expect(200);
    expect(response.body.days[0].slots.length).toBeGreaterThan(0);
  });

  it('aceita intervalo de datas numa consulta só', async () => {
    const response = await request(app.getHttpServer())
      .get(url('domari', { ...ok, dateFrom: SEGUNDA, dateTo: diaSeguinte(SEGUNDA, 4) }))
      .expect(200);

    expect(response.body.days.map((d: { date: string }) => d.date)).toEqual([
      SEGUNDA, TERCA, diaSeguinte(SEGUNDA, 2), diaSeguinte(SEGUNDA, 3), diaSeguinte(SEGUNDA, 4),
    ]);
    // Segunda é folga; os demais têm grade.
    expect(response.body.days[0].unavailableReason).toBe('closed');
    expect(response.body.days[1].slots.length).toBeGreaterThan(0);
  });

  it('aceita múltiplos serviços e soma a duração', async () => {
    const response = await request(app.getHttpServer())
      .get(url('domari', { ...ok, serviceIds: `${CABELO},${BARBA}` }))
      .expect(200);
    expect(response.body.days[0].serviceDurationMinutes).toBe(40);
  });

  it('informa por que o dia está vazio', async () => {
    const response = await request(app.getHttpServer())
      .get(url('domari', { ...ok, dateFrom: SEGUNDA }))
      .expect(200);

    expect(response.body.days[0].slots).toEqual([]);
    expect(response.body.days[0].unavailableReason).toBe('closed');
    expect(response.body.days[0].waitlistAvailable).toBe(false);
  });

  // -- preço -----------------------------------------------------------------

  /**
   * O preço que a grade anuncia é o que o `POST` congela (bloco 105).
   *
   * ## O defeito que este teste prende
   *
   * O passo 4 do agendamento somava o preço do **catálogo** e mostrava o total
   * ao lado de "Confirmar agendamento". Com uma faixa de +20% cadastrada, a
   * tela dizia R$ 49,00 e o recibo da tela seguinte dizia R$ 58,80 — sobre o
   * mesmo agendamento, um clique depois.
   *
   * Nada ficava vermelho: `precoDoHorario` estava certo e testado, a API estava
   * certa, e cada uma das duas telas era coerente sozinha. É a §6 pergunta 6.
   *
   * ## Por que aqui, e não numa asserção sobre a tela
   *
   * A tela passou a **ler** `priceCents` do slot. O que precisa ficar preso é o
   * contrato de que aquele campo é a mesma verdade que a gravação usa: se um
   * dia a grade e o `resolveSlot` divergirem, a tela volta a mentir sem ter
   * mudado uma linha.
   *
   * A faixa fica no fim da tarde de propósito: os testes acima asseram sobre o
   * primeiro horário do dia, e uma faixa da manhã os quebraria por outro motivo
   * que não a regra sob teste.
   */
  it('o preço do horário na grade é o que a gravação congela', async () => {
    // 17:00–18:00 locais, +20%. `max_price_variation_bps` nasce em 1500 (15%),
    // e é ele que apara: 4900 + 15% = 5635.
    await exec(admin, `
      UPDATE locations SET dynamic_pricing_enabled = true WHERE id = '${LOCATION}';

      INSERT INTO pricing_rules (tenant_id, location_id, weekday, start_minute, end_minute, delta_bps)
      VALUES ('${TENANT}', '${LOCATION}', 2, 1020, 1080, 2000);
    `);

    try {
      const grade = await request(app.getHttpServer()).get(url('domari', ok)).expect(200);
      const slots: { start: string; priceCents: number | null }[] = grade.body.days[0].slots;

      const cedo = slots.find((s) => s.start === '09:00');
      const naFaixa = slots.find((s) => s.start === '17:00');
      expect(cedo?.priceCents).toBe(4900);
      // Aparado pelo teto da marca, não os 5880 que a faixa pediria.
      expect(naFaixa?.priceCents).toBe(5635);

      const criado = await request(app.getHttpServer())
        .post('/v1/b/domari/appointments')
        .send({
          name: 'Carlos Andrade',
          phone: '(71) 98888-7777',
          locationId: LOCATION,
          professionalId: RUAN,
          serviceIds: [CABELO],
          date: TERCA,
          start: '17:00',
        })
        .expect(201);

      expect(criado.body.priceCents).toBe(naFaixa?.priceCents);
    } finally {
      await exec(admin, `
        DELETE FROM pricing_rules WHERE location_id = '${LOCATION}';
        UPDATE locations SET dynamic_pricing_enabled = false WHERE id = '${LOCATION}';
      `);
    }
  });

  // -- isolamento ------------------------------------------------------------

  it('não expõe o tenant interno em lugar nenhum da resposta', async () => {
    const response = await request(app.getHttpServer()).get(url('domari', ok)).expect(200);
    expect(JSON.stringify(response.body)).not.toContain(TENANT);
  });

  it('unidade de outro tenant não é alcançável pelo slug', async () => {
    // A unidade existe, mas pertence ao rival: a RLS a torna invisível.
    const response = await request(app.getHttpServer())
      .get(url('domari', { ...ok, locationId: LOCATION_RIVAL }))
      .expect(200);
    expect(response.body.days[0].unavailableReason).toBe('unknown_location');
  });

  // -- caminho triste --------------------------------------------------------

  it('estabelecimento inexistente devolve 404 genérico', async () => {
    const response = await request(app.getHttpServer())
      .get(url('nao-existe', ok))
      .expect(404);
    expect(response.body.error.code).toBe('establishment_not_found');
  });

  it('rejeita slug com alfabeto hostil', async () => {
    for (const slug of ['../etc', "a'or'1", 'a%20b']) {
      const response = await request(app.getHttpServer())
        .get(`/v1/b/${encodeURIComponent(slug)}/availability?locationId=${LOCATION}&serviceIds=${CABELO}&dateFrom=${TERCA}`);
      expect([400, 404]).toContain(response.status);
    }
  });

  it('rejeita parâmetro faltando ou malformado', async () => {
    const casos: Record<string, string>[] = [
      { serviceIds: CABELO, dateFrom: TERCA },                        // sem locationId
      { locationId: LOCATION, dateFrom: TERCA },                      // sem serviceIds
      { locationId: LOCATION, serviceIds: CABELO },                   // sem dateFrom
      { locationId: 'nao-uuid', serviceIds: CABELO, dateFrom: TERCA },
      { locationId: LOCATION, serviceIds: 'nao-uuid', dateFrom: TERCA },
      { locationId: LOCATION, serviceIds: CABELO, dateFrom: '11/08/2026' },
    ];

    for (const caso of casos) {
      const response = await request(app.getHttpServer()).get(url('domari', caso)).expect(400);
      expect(response.body.error.code).toBe('invalid_request');
    }
  });

  it('rejeita injeção de SQL no parâmetro de serviço', async () => {
    const response = await request(app.getHttpServer())
      .get(url('domari', { ...ok, serviceIds: `${CABELO}' OR '1'='1` }))
      .expect(400);
    expect(response.body.error.code).toBe('invalid_request');
  });

  it('recusa intervalo maior que o teto', async () => {
    const response = await request(app.getHttpServer())
      .get(url('domari', { ...ok, dateFrom: '2026-08-01', dateTo: '2026-12-31' }))
      .expect(400);
    expect(response.body.error.code).toBe('invalid_range');
  });

  it('recusa intervalo invertido', async () => {
    const response = await request(app.getHttpServer())
      .get(url('domari', { ...ok, dateFrom: TERCA, dateTo: SEGUNDA }))
      .expect(400);
    expect(response.body.error.code).toBe('invalid_range');
  });

  it('recusa lista de serviços acima do teto', async () => {
    const muitos = Array.from({ length: 11 }, () => CABELO).join(',');
    await request(app.getHttpServer())
      .get(url('domari', { ...ok, serviceIds: muitos }))
      .expect(400);
  });

  it('nunca vaza detalhe interno numa mensagem de erro', async () => {
    const response = await request(app.getHttpServer())
      .get(url('domari', { ...ok, locationId: 'nao-uuid' }))
      .expect(400);

    const body = JSON.stringify(response.body).toLowerCase();
    for (const leak of ['select', 'from ', 'postgres', 'prisma', 'stack', 'at ']) {
      expect(body).not.toContain(leak);
    }
  });
});
