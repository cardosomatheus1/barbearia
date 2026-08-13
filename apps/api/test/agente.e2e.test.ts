import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConsoleMessagingProvider } from '@barbearia/identity';
import { AgenteController } from '../src/booking/agente.controller.js';
import { BookingController } from '../src/booking/booking.controller.js';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';
import { limparBanco } from './limpar.js';

/**
 * O agente de agendamento pela HTTP (bloco 65, SPEC §4.16).
 *
 * O que só se prova aqui: que o agente **chama o motor**. Um teste de unidade
 * sobre o intérprete prova que ele entende a frase; ele não prova que os horários
 * oferecidos são os mesmos que a página pública mostraria — e essa é a regra que
 * a SPEC escreve em letras.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

let app: INestApplication;
let admin: PrismaClient;
let tenants: TenantService;

const DONO = {
  name: 'Matheus Cardoso',
  email: 'dono@domari.com.br',
  password: 'senha-bem-comprida',
  phone: '(71) 98888-7777',
  businessName: 'Domari Barber Club',
};

const SLUG = 'domari-barber-club';

const JORNADA = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 480,
  endMinute: 1320,
}));

describeIfDb('o agente de agendamento pela HTTP', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    process.env['MFA_SECRET_KEY'] = Buffer.alloc(32, 9).toString('base64');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [StaffAuthController, OnboardingController, BookingController, AgenteController],
      providers: [
        TenantService,
        { provide: MESSAGING_PROVIDER, useClass: ConsoleMessagingProvider },
        StaffGuard,
        PermissaoGuard,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
      ],
    }).compile();

    tenants = moduleRef.get(TenantService);
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await limparBanco(admin, ['tenants', 'staff_directory']);
    tenants.forget(SLUG);
  });

  const http = () => request(app.getHttpServer());
  const com = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  /** Uma barbearia publicada, com um serviço e uma cadeira com jornada aberta. */
  async function abrirBarbearia(): Promise<void> {
    await http().post('/v1/admin/signup').send(DONO).expect(202);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email: DONO.email, password: DONO.password })
      .expect(201);
    const token: string = entrou.body.token;

    await com(token)(
      http()
        .put('/v1/admin/business')
        .send({ name: DONO.businessName, city: 'Salvador', timezone: 'America/Bahia' }),
    ).expect(200);

    await com(token)(
      http()
        .put('/v1/admin/services')
        .send({
          services: [
            {
              key: 'corte',
              name: 'Corte',
              category: 'Cabelo',
              durationMinutes: 30,
              bufferAfterMinutes: 0,
              priceCents: 5000,
            },
            {
              key: 'corte-barba',
              name: 'Corte e barba',
              category: 'Cabelo',
              durationMinutes: 60,
              bufferAfterMinutes: 0,
              priceCents: 9000,
            },
          ],
        }),
    ).expect(200);

    await com(token)(
      http()
        .put('/v1/admin/professionals')
        .send({ professionals: [{ name: 'João', schedule: JORNADA }] }),
    ).expect(200);

    await com(token)(http().post('/v1/admin/publish').send({})).expect(201);
  }

  const falar = (texto: string) => http().post(`/v1/b/${SLUG}/agente`).send({ texto });

  it('os horários que o agente oferece são os do motor, não os dele', async () => {
    /**
     * *"O agente **nunca** calcula disponibilidade sozinho — sempre chama o
     * motor. Uma única fonte de verdade."*
     *
     * A prova: o que ele oferece tem que estar na grade que a página pública
     * devolve para o mesmo dia e o mesmo serviço. Uma segunda noção de "horário
     * livre" seria a agenda vendida duas vezes.
     */
    await abrirBarbearia();
    const r = await falar('quero cortar amanhã depois das 18h').expect(201);

    expect(r.body.entendi).toBe(true);
    expect(r.body.horarios.length).toBeGreaterThan(0);

    const perfil = await http().get(`/v1/b/${SLUG}`).expect(200);
    const servico = perfil.body.categories.flatMap((c: { services: { id: string; name: string }[] }) =>
      c.services,
    ).find((s: { name: string }) => s.name === 'Corte');

    const grade = await http()
      .get(
        `/v1/b/${SLUG}/availability?locationId=${perfil.body.location.id}` +
          `&serviceIds=${servico.id}&dateFrom=${r.body.data}&anyProfessional=true`,
      )
      .expect(200);

    const doMotor = new Set(
      grade.body.days[0].slots.map((s: { startsAt: string }) => s.startsAt),
    );
    for (const h of r.body.horarios) {
      expect(doMotor, `${h.comecaEm} não está na grade do motor`).toContain(h.comecaEm);
    }
  });

  it('a faixa pedida é respeitada, e ela recorta o que o motor devolveu', async () => {
    await abrirBarbearia();
    const r = await falar('quero cortar amanhã depois das 18h').expect(201);
    for (const h of r.body.horarios) {
      const hora = Number(
        new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Bahia',
          hour: '2-digit',
          hour12: false,
        }).format(new Date(h.comecaEm)),
      );
      expect(hora, h.comecaEm).toBeGreaterThanOrEqual(18);
    }
  });

  it('no máximo três horários, porque conversa não é planilha', async () => {
    // *"18:20 · 19:00 · 20:10"* é o exemplo da SPEC, e ele tem três. Uma lista de
    // vinte horários numa conversa não é escolha.
    await abrirBarbearia();
    const r = await falar('quero cortar amanhã').expect(201);
    expect(r.body.horarios.length).toBeLessThanOrEqual(3);
  });

  it('serviço que a barbearia não tem faz o agente perguntar, não inventar', async () => {
    await abrirBarbearia();
    const r = await falar('quero marcar uma progressiva amanhã').expect(201);
    expect(r.body.pergunta).toBeTruthy();
    expect(r.body.horarios).toBeUndefined();
  });

  it('pedir para falar com gente escala, e não vira "não entendi"', async () => {
    await abrirBarbearia();
    const r = await falar('quero falar com um atendente').expect(201);
    expect(r.body.escalar).toBe(true);
  });

  it('cancelar não vira grade de horários', async () => {
    /**
     * Responder com horários a quem disse "não vou poder ir" seria o agente
     * oferecendo o oposto do que a pessoa pediu. E ele **não** cancela por aqui:
     * cancelar exige saber qual agendamento, e isso exige sessão.
     */
    await abrirBarbearia();
    const r = await falar('não vou poder ir hoje').expect(201);
    expect(r.body.intencao).toBe('cancelar');
    expect(r.body.precisaEntrar).toBe(true);
    expect(r.body.horarios).toBeUndefined();
  });

  it('o agente não grava nada — a agenda continua vazia depois da conversa', async () => {
    /**
     * *"Confirmação explícita antes de gravar."* O que sai da rota é uma
     * proposta; gravar continua sendo o `POST` de agendamento, com
     * `Idempotency-Key`, sinal e score.
     */
    await abrirBarbearia();
    await falar('quero cortar amanhã depois das 18h').expect(201);

    const marcados = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM appointments`,
    );
    expect(Number(marcados[0]?.n ?? 0)).toBe(0);
  });

  it('barbearia que não existe responde 404, não erro de banco', async () => {
    await abrirBarbearia();
    await http().post('/v1/b/nao-existe/agente').send({ texto: 'quero cortar amanhã' }).expect(404);
  });

  it('texto vazio é recusado na borda', async () => {
    await abrirBarbearia();
    await http().post(`/v1/b/${SLUG}/agente`).send({ texto: '' }).expect(400);
  });
});
