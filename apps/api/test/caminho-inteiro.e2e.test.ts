import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConsoleMessagingProvider, FakeMessagingProvider, codigoDoPasso, passoAgora } from '@barbearia/identity';
import { StaffAuthController, OnboardingController } from '../src/admin/admin.controller.js';
import { BoardController } from '../src/admin/board.controller.js';
import { CaixaController } from '../src/admin/caixa.controller.js';
import { MfaController } from '../src/admin/mfa.controller.js';
import { ComissaoController } from '../src/admin/comissao.controller.js';
import { PainelController } from '../src/admin/painel.controller.js';
import { TeamController, MeController } from '../src/admin/team.controller.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { BookingController } from '../src/booking/booking.controller.js';
import {
  AppointmentsController,
  GuestAppointmentsController,
} from '../src/booking/appointments.controller.js';
import { AuthController, SessionController } from '../src/auth/auth.controller.js';
import { CustomerGuard } from '../src/auth/customer.guard.js';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';
import { limparBanco } from './limpar.js';

/**
 * O caminho inteiro, numa corrida só (bloco 23).
 *
 * Cada subsistema já tem a sua suíte, e todas passam. O que nenhuma delas cobre
 * é a **emenda entre elas**: cada uma começa de um estado que ela mesma montou,
 * do jeito que ela precisa. Um agendamento nascido pela página pública não é
 * exercitado pelo balcão; a comanda do balcão nasce vazia em vez de nascer de
 * um atendimento; o caixa fecha sobre uma venda que ninguém marcou.
 *
 * É por aí que passa o defeito que ninguém vê: o campo que um lado grava e o
 * outro não lê. Este teste percorre o dia inteiro de uma barbearia:
 *
 *   o dono abre a casa → o cliente marca pelo site → o balcão recebe
 *   → o barbeiro atende → a comanda cobra → o caixa fecha
 *
 * e confere que **o dinheiro do fim é o do serviço do começo**, sem ninguém
 * digitar o valor no meio do caminho.
 *
 * O critério de aceite do R1 é este percurso: uma barbearia de duas cadeiras
 * conseguir largar o sistema atual sem perder capacidade.
 *
 * ## A prova de que ele não é redundante
 *
 * Cortada a emenda — a comanda deixando de herdar o agendamento, uma linha —,
 * os **trinta testes do caixa e os dezesseis do balcão continuam verdes**. Cada
 * um monta o seu próprio estado, e nenhum deles pergunta de onde o estado veio.
 * Só este reprova.
 *
 * É o argumento inteiro para ele existir, e vale relembrar antes de "simplificar"
 * o percurso: um teste que começa do meio não cobre o começo.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const DONO = {
  name: 'Matheus Cardoso',
  email: 'dono@domari.com.br',
  password: 'senha-bem-comprida',
  phone: '(71) 98888-7777',
  businessName: 'Domari Barber Club',
};

const CLIENTE = '(71) 96666-5555';
const PRECO_DO_CORTE = 4900;
const ABERTURA = 20000;

/** Jornada de dia inteiro: o teste marca no primeiro horário livre de amanhã. */
const JORNADA = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 0,
  endMinute: 1439,
}));

let app: INestApplication;
let admin: PrismaClient;
let tenants: TenantService;
let mensagens: FakeMessagingProvider;

/**
 * Amanhã, não hoje.
 *
 * Marcar no primeiro horário de hoje encosta na antecedência mínima da unidade:
 * sob carga, os segundos entre consultar a grade e gravar viram vários, e o
 * horário que a grade ofereceu deixa de ser marcável. O e2e do balcão reprovava
 * uma vez em seis por isso depois que as suítes passaram a rodar juntas.
 */
function amanha(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describeIfDb('o dia inteiro de uma barbearia', () => {
  const DIA = amanha();

  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    process.env['MFA_SECRET_KEY'] = Buffer.alloc(32, 7).toString('base64');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
    mensagens = new FakeMessagingProvider();

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [
        // Os dois lados no mesmo módulo: é o que torna este teste diferente
        // dos outros. Público e admin conversando pelo banco, como em produção.
        BookingController,
        AuthController,
        SessionController,
        GuestAppointmentsController,
        AppointmentsController,
        StaffAuthController,
        OnboardingController,
        BoardController,
        CaixaController,
        MfaController,
        ComissaoController,
        PainelController,
        TeamController,
        MeController,
      ],
      providers: [
        TenantService,
        CustomerGuard,
        StaffGuard,
        PermissaoGuard,
        { provide: MESSAGING_PROVIDER, useValue: mensagens },
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
    mensagens.clear();
    await limparBanco(admin, ['tenants', 'staff_directory']);
    tenants.forget('domari-barber-club');
  });

  const http = () => request(app.getHttpServer());
  const com = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  it('do primeiro horário ao fechamento do caixa', async () => {
    // ---- 1. o dono abre a casa ---------------------------------------------
    await http().post('/v1/admin/signup').send(DONO).expect(202);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email: DONO.email, password: DONO.password })
      .expect(201);
    const gestor: string = entrou.body.token;

    await com(gestor)(
      http()
        .put('/v1/admin/business')
        .send({ name: DONO.businessName, city: 'Salvador', timezone: 'America/Bahia' }),
    ).expect(200);
    await com(gestor)(
      http().put('/v1/admin/services').send({
        services: [
          {
            key: 'cabelo',
            name: 'Corte de cabelo',
            category: 'Cabelo',
            durationMinutes: 30,
            bufferAfterMinutes: 0,
            priceCents: PRECO_DO_CORTE,
          },
        ],
      }),
    ).expect(200);
    await com(gestor)(
      http()
        .put('/v1/admin/professionals')
        .send({ professionals: [{ name: 'Ruan Nascimento', schedule: JORNADA }] }),
    ).expect(200);
    await com(gestor)(http().post('/v1/admin/publish')).expect(201);

    const slug = (await com(gestor)(http().get('/v1/admin/state')).expect(200)).body.slug;

    // ---- 2. o cliente entra pelo endereço público --------------------------
    // Nada de id vindo de dentro: o cliente só conhece o slug, e daqui para
    // baixo tudo sai do que a página pública devolve. É o que prova que a
    // barbearia recém-publicada está de fato agendável — e foi assim que o
    // onboarding ganhou a etapa de publicar.
    const perfil = await http().get(`/v1/b/${slug}`).expect(200);
    const locationId: string = perfil.body.location.id;
    const servico = perfil.body.categories.flatMap((c: { services: unknown[] }) => c.services)[0] as {
      id: string;
      priceCents: number;
    };
    const profissional = perfil.body.professionals[0] as { id: string };

    expect(servico.priceCents).toBe(PRECO_DO_CORTE);

    const grade = await http()
      .get(`/v1/b/${slug}/availability`)
      .query({ locationId, serviceIds: servico.id, dateFrom: DIA })
      .expect(200);
    const horario = grade.body.days[0].slots[0] as { start: string };
    expect(horario).toBeDefined();

    // ---- 3. o cliente marca, com código no WhatsApp ------------------------
    await http().post(`/v1/b/${slug}/auth/otp`).send({ phone: CLIENTE, name: 'Zé do Bairro' }).expect(201);
    const codigo = mensagens.sent.at(-1)?.code;
    if (!codigo) throw new Error('nenhum código enviado');
    const sessao = await http()
      .post(`/v1/b/${slug}/auth/verify`)
      .send({ phone: CLIENTE, code: codigo })
      .expect(201);
    const cliente: string = sessao.body.token;

    const marcado = await http()
      .post(`/v1/b/${slug}/appointments`)
      .set('Authorization', `Bearer ${cliente}`)
      .set('Idempotency-Key', 'caminho-inteiro-1')
      .send({
        locationId,
        professionalId: profissional.id,
        serviceIds: [servico.id],
        date: DIA,
        start: horario.start,
      })
      .expect(201);
    const agendamentoId: string = marcado.body.id;

    // ---- 4. o balcão vê quem o site marcou ---------------------------------
    const dia = await com(gestor)(http().get('/v1/admin/day').query({ date: DIA })).expect(200);
    const linha = dia.body.entries.find((e: { id: string }) => e.id === agendamentoId);

    expect(linha).toBeDefined();
    expect(linha.customerName).toBe('Zé do Bairro');
    // A emenda que este teste existe para provar: o agendamento nasceu na
    // página pública e chegou ao balcão com nome, serviço e horário.
    expect(linha.services).toContain('Corte de cabelo');

    // ---- 5. o atendimento acontece -----------------------------------------
    // A rota recebe a **ação**, não o estado de destino: é a máquina de estados
    // do domínio que decide para onde ela leva, e é por isso que "iniciar" não
    // vale sobre quem ainda não chegou.
    for (const acao of ['check_in', 'start', 'complete']) {
      await com(gestor)(
        http().post(`/v1/admin/appointments/${agendamentoId}/attendance`).send({ action: acao }),
      ).expect(201);
    }

    // ---- 6. o caixa abre (com o segundo fator provado) ---------------------
    const setup = await com(gestor)(http().post('/v1/admin/mfa/setup')).expect(201);
    const segredo: string = setup.body.segredoBase32;
    const passo = passoAgora(new Date());
    await com(gestor)(
      http().post('/v1/admin/mfa/confirm').send({ codigo: codigoDoPasso(segredo, passo) }),
    ).expect(201);
    await com(gestor)(
      http().post('/v1/admin/mfa/verify').send({ codigo: codigoDoPasso(segredo, passo + 1) }),
    ).expect(201);

    await com(gestor)(http().post('/v1/admin/cash/open').send({ openingCents: ABERTURA })).expect(201);

    // ---- 7. a comanda cobra o que foi atendido -----------------------------
    // Nasce **do agendamento**, e é aqui que o preço atravessa: ninguém digita
    // valor. Um serviço que mudasse de preço entre marcar e cobrar apareceria
    // exatamente neste ponto.
    const comanda = await com(gestor)(
      http().post('/v1/admin/orders').send({ appointmentId: agendamentoId }),
    ).expect(201);
    const comandaId: string = comanda.body.id;

    const aberta = await com(gestor)(http().get(`/v1/admin/orders/${comandaId}`)).expect(200);
    expect(aberta.body.totalCents).toBe(PRECO_DO_CORTE);

    await com(gestor)(
      http()
        .post(`/v1/admin/orders/${comandaId}/close`)
        .set('Idempotency-Key', 'caminho-inteiro-pagamento')
        .send({ pagamentos: [{ forma: 'cash', valorCents: PRECO_DO_CORTE }] }),
    ).expect(201);

    // ---- 8. o caixa fecha com o dinheiro certo -----------------------------
    const gaveta = await com(gestor)(http().get('/v1/admin/cash')).expect(200);

    // O número que fecha o dia é o preço que o cliente viu na página pública,
    // sete passos atrás, sem ninguém ter digitado nada no meio.
    expect(gaveta.body.aberto.esperadoAgoraCents).toBe(ABERTURA + PRECO_DO_CORTE);

    const fechado = await com(gestor)(
      http().post('/v1/admin/cash/close').send({ countedCents: ABERTURA + PRECO_DO_CORTE }),
    ).expect(201);
    expect(fechado.body.divergenciaCents).toBe(0);
  });
});
