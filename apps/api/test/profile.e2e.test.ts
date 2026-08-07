import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookingController } from '../src/booking/booking.controller.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';

/** Perfil público — o que a página SSR consome antes de qualquer interação. */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const RECEPCAO = 'bbbbbbbb-0000-0000-0000-000000000003';
const CAT_CABELO = 'dddddddd-0000-0000-0000-00000000000a';
const CABELO = 'eeeeeeee-0000-0000-0000-000000000001';
const OCULTO = 'eeeeeeee-0000-0000-0000-000000000009';

let app: INestApplication;
let admin: PrismaClient;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const s of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(s);
  }
}

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

describeIfDb('GET /v1/b/:slug', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });

    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(admin, `
      INSERT INTO tenants (id, name, instagram) VALUES
        ('${TENANT}', 'Domari Barber Club', 'domaribarberclub');

      INSERT INTO tenant_slugs (slug, tenant_id, is_primary)
      VALUES ('domari', '${TENANT}', true), ('boxseisbarbearia', '${TENANT}', false);

      INSERT INTO locations (id, tenant_id, name, timezone, street, district, city, state,
                             latitude, longitude, phone_e164, amenities, about)
      VALUES ('${LOCATION}', '${TENANT}', 'Pituba', 'America/Bahia',
              'Rua Ceará, 120', 'Pituba', 'Salvador', 'BA',
              -12.995, -38.457, '+5571988887777', ARRAY['wifi','card','pix'],
              'Corte clássico e barba, sem pressa.');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind, bio) VALUES
        ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional', 'Degradê e navalha'),
        ('${RECEPCAO}', '${TENANT}', '${LOCATION}', 'Recepcao', 'counter', NULL);

      INSERT INTO service_categories (id, tenant_id, name, position)
      VALUES ('${CAT_CABELO}', '${TENANT}', 'Cabelo', 1);

      INSERT INTO services (id, tenant_id, category_id, name, description, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', '${CAT_CABELO}', 'Cabelo (Tesoura)',
              'Tesoura em cima, máquina nas laterais.', 4900, 25),
             ('${OCULTO}', '${TENANT}', '${CAT_CABELO}', 'Interno', NULL, 9900, 30);

      UPDATE services SET bookable_online = false WHERE id = '${OCULTO}';

      INSERT INTO professional_services (professional_id, service_id, tenant_id) VALUES
        ('${RUAN}', '${CABELO}', '${TENANT}'),
        ('${RECEPCAO}', '${CABELO}', '${TENANT}'),
        ('${RUAN}', '${OCULTO}', '${TENANT}');

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', '${RUAN}', d.weekday, 540, 1080
      FROM (VALUES (2), (3), (4), (5), (6)) AS d(weekday);

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      VALUES ('${TENANT}', '${RUAN}', 0, 540, 780);

      -- Agenda de balcão trabalha 08:00-23:00 todo dia: não pode virar o
      -- horário de funcionamento anunciado (defeito D12).
      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', '${RECEPCAO}', d.weekday, 480, 1380
      FROM (VALUES (0), (1), (2), (3), (4), (5), (6)) AS d(weekday);
    `);

    const moduleRef = await Test.createTestingModule({
      controllers: [BookingController],
      providers: [TenantService, { provide: APP_FILTER, useClass: HttpExceptionFilter }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
  });

  const get = (slug = 'domari') => request(app.getHttpServer()).get(`/v1/b/${slug}`);

  it('entrega identidade e endereço — resolve D8', async () => {
    const { body } = await get().expect(200);

    expect(body.name).toBe('Domari Barber Club');
    expect(body.instagram).toBe('domaribarberclub');
    expect(body.location).toMatchObject({
      street: 'Rua Ceará, 120',
      district: 'Pituba',
      city: 'Salvador',
      state: 'BA',
      latitude: -12.995,
      longitude: -38.457,
      phone: '+5571988887777',
    });
    expect(body.location.amenities).toEqual(['wifi', 'card', 'pix']);
  });

  it('entrega descrição de serviço — resolve D9', async () => {
    const { body } = await get().expect(200);
    const cabelo = body.categories[0].services[0];
    expect(cabelo.description).toBe('Tesoura em cima, máquina nas laterais.');
    expect(cabelo.durationMinutes).toBe(25);
    expect(cabelo.priceCents).toBe(4900);
  });

  it('agrupa serviços por categoria', async () => {
    const { body } = await get().expect(200);
    expect(body.categories).toHaveLength(1);
    expect(body.categories[0].name).toBe('Cabelo');
  });

  it('esconde serviço não agendável online', async () => {
    const { body } = await get().expect(200);
    const nomes = body.categories.flatMap((c: { services: { name: string }[] }) =>
      c.services.map((s) => s.name),
    );
    expect(nomes).toContain('Cabelo (Tesoura)');
    expect(nomes).not.toContain('Interno');
  });

  it('não anuncia a agenda de balcão como profissional', async () => {
    const { body } = await get().expect(200);
    expect(body.professionals.map((p: { name: string }) => p.name)).toEqual(['Ruan']);
  });

  it('horário de funcionamento vem da jornada real, não do balcão', async () => {
    const { body } = await get().expect(200);

    // Terça a sábado 09:00-18:00, domingo até 13:00, segunda fechado.
    expect(body.hours[2]).toMatchObject({ opensAt: '09:00', closesAt: '18:00' });
    expect(body.hours[0]).toMatchObject({ opensAt: '09:00', closesAt: '13:00' });
    expect(body.hours[1]).toMatchObject({ opensAt: null, closesAt: null });
    // O balcão trabalha 08:00-23:00 todo dia; se vazasse, segunda estaria aberta.
  });

  it('informa se está aberto agora, com o que fazer em seguida', async () => {
    const { body } = await get().expect(200);
    expect(typeof body.open.isOpen).toBe('boolean');
    expect(body.open.detail).toMatch(/fecha \d{2}:\d{2}|abre /);
  });

  it('calcula o preço a partir de', async () => {
    const { body } = await get().expect(200);
    expect(body.priceFromCents).toBe(4900);
  });

  it('resolve pelo slug legado', async () => {
    const { body } = await get('boxseisbarbearia').expect(200);
    expect(body.name).toBe('Domari Barber Club');
  });

  it('estabelecimento inexistente devolve 404', async () => {
    await get('nao-existe').expect(404);
  });

  it('não vaza o identificador interno do tenant', async () => {
    const { body } = await get().expect(200);
    expect(JSON.stringify(body)).not.toContain(TENANT);
  });
});
