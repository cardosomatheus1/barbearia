import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookingController } from '../src/booking/booking.controller.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';

/**
 * O limite de requisições é uma defesa, então precisa de teste próprio.
 *
 * Módulo separado com teto apertado: exercitar o limite de propósito é melhor
 * do que esbarrar nele por acidente no meio de outra suíte.
 */
describe('limite de requisições', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: 'short', ttl: 60_000, limit: 3 }])],
      controllers: [BookingController],
      providers: [
        TenantService,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('responde 429 depois do teto e não vaza detalhe', async () => {
    const path = '/v1/b/qualquer/availability';
    const statuses: number[] = [];

    for (let i = 0; i < 5; i++) {
      const response = await request(app.getHttpServer()).get(path);
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.body.error.code).toBe('rate_limited');
      }
    }

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });
});
