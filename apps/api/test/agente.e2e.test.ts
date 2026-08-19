import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeMessagingProvider } from '@barbearia/identity';
import {
  AgenteController,
  AgenteDoClienteController,
} from '../src/booking/agente.controller.js';
import {
  AppointmentsController,
  GuestAppointmentsController,
} from '../src/booking/appointments.controller.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { CustomerGuard } from '../src/auth/customer.guard.js';
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
let mensagens: FakeMessagingProvider;

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
    mensagens = new FakeMessagingProvider();

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [
        StaffAuthController,
        OnboardingController,
        BookingController,
        AgenteController,
        AgenteDoClienteController,
        AuthController,
        GuestAppointmentsController,
        AppointmentsController,
      ],
      providers: [
        TenantService,
        { provide: MESSAGING_PROVIDER, useValue: mensagens },
        StaffGuard,
        CustomerGuard,
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
    mensagens.clear();
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
    /**
     * A proposta carrega o **serviço**, e sem ele ela não leva a lugar nenhum.
     *
     * O passo do agendamento é marcado na URL e exige `s=`: um link com só o dia
     * e a hora cai no passo 1, e a pessoa recomeça escolhendo serviço — a
     * conversa inteira jogada fora exatamente no clique que deveria aproveitá-la.
     * A rota tinha o dado na mão e não o devolvia, e a tela do bloco 106 é a
     * primeira a precisar dele.
     */
    expect(typeof r.body.servicoId).toBe('string');
    const servico = perfil.body.categories.flatMap((c: { services: { id: string; name: string }[] }) =>
      c.services,
    ).find((s: { name: string }) => s.name === 'Corte');
    // E é o **mesmo** serviço que a grade conferida abaixo usa: um `servicoId`
    // de outro serviço levaria o cliente ao passo 4 com a duração e o preço de
    // outra coisa.
    expect(r.body.servicoId).toBe(servico.id);

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

  it('a recepção responde o preço a partir do que a casa cadastrou', async () => {
    /**
     * *"Respostas vêm **exclusivamente** dos dados configurados pela
     * barbearia."* O R$ 50,00 aqui é o mesmo que a página pública mostra — não há
     * uma segunda fonte.
     */
    await abrirBarbearia();
    const r = await falar('quanto custa o corte?').expect(201);
    expect(r.body.resposta).toContain('50,00');
  });

  it('"João trabalha sexta?" é respondida com a jornada cadastrada', async () => {
    // A pergunta é uma das quatro da SPEC §4.17, e o dado sempre esteve em
    // `work_schedules` — o que faltava era o perfil público expô-lo.
    await abrirBarbearia();
    const r = await falar('João trabalha sexta?').expect(201);
    expect(r.body.resposta).toContain('João atende sexta');
  });

  it('pergunta sem resposta cadastrada escala e vira lacuna registrada', async () => {
    /**
     * *"Essa lista de lacunas é, sozinha, um produto útil."* Uma barbearia que vê
     * "dezoito pessoas perguntaram se você aceita Pix" tem uma tarefa clara; um
     * chatbot que só diz "não sei" tem um problema.
     */
    await abrirBarbearia();
    const r = await falar('vocês aceitam pix?').expect(201);
    expect(r.body.escalar).toBe(true);

    const lacunas = await admin.$queryRawUnsafe<{ pergunta_texto: string; vezes: number }[]>(
      `SELECT pergunta_texto, vezes FROM reception_gaps`,
    );
    expect(lacunas).toHaveLength(1);
    expect(lacunas[0]?.pergunta_texto).toContain('pix');
  });

  it('a mesma pergunta duas vezes vira uma lacuna com contador dois', async () => {
    await abrirBarbearia();
    await falar('vocês aceitam pix?').expect(201);
    await falar('aceitam pix');

    const lacunas = await admin.$queryRawUnsafe<{ vezes: number }[]>(
      `SELECT vezes FROM reception_gaps`,
    );
    expect(lacunas).toHaveLength(1);
    expect(lacunas[0]?.vezes).toBe(2);
  });

  it('barbearia que não existe responde 404, não erro de banco', async () => {
    await abrirBarbearia();
    await http().post('/v1/b/nao-existe/agente').send({ texto: 'quero cortar amanhã' }).expect(404);
  });

  it('texto vazio é recusado na borda', async () => {
    await abrirBarbearia();
    await http().post(`/v1/b/${SLUG}/agente`).send({ texto: '' }).expect(400);
  });

  // -- Remarcação pela conversa (bloco 66, SPEC §4.17) ------------------------

  const CLIENTE = '+5571999990000';

  /** Uma sessão de cliente, pelo mesmo caminho de OTP que a página usa. */
  async function entrarComoCliente(): Promise<string> {
    await http()
      .post(`/v1/b/${SLUG}/auth/otp`)
      .send({ phone: CLIENTE, name: 'Zé do Bairro' })
      .expect(201);
    const codigo = mensagens.sent.at(-1)?.code;
    if (!codigo) throw new Error('nenhum código enviado');
    const sessao = await http()
      .post(`/v1/b/${SLUG}/auth/verify`)
      .send({ phone: CLIENTE, code: codigo })
      .expect(201);
    return sessao.body.token as string;
  }

  /** Marca um horário de amanhã e devolve o id e o instante — base da remarcação. */
  async function marcarAmanha(
    token: string,
    chave: string,
  ): Promise<{ id: string; comecaEm: string; local: string; servico: string; profissional: string; dia: string }> {
    const perfil = await http().get(`/v1/b/${SLUG}`).expect(200);
    const local = perfil.body.location.id as string;
    const servico = perfil.body.categories[0].services[0].id as string;
    const profissional = perfil.body.professionals[0].id as string;
    /**
     * "Amanhã" é amanhã **na barbearia**, não em UTC.
     *
     * A conta era `Date.now() + 24h` cortado no ISO, e ela discorda do domínio
     * entre a meia-noite de Londres e a de Salvador: às 00h30 UTC já é dia 14
     * ali e ainda é 13 aqui, então a semente marcava para o 15 e o agente
     * oferecia o 14. O teste passava vinte e uma horas por dia — que é a pior
     * forma de um teste falhar.
     */
    const fuso = perfil.body.location.timezone as string;
    const hoje = new Intl.DateTimeFormat('en-CA', {
      timeZone: fuso,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const [ano, mes, dia] = hoje.split('-').map(Number) as [number, number, number];
    const amanha = new Date(Date.UTC(ano, mes - 1, dia + 1)).toISOString().slice(0, 10);

    const grade = await http()
      .get(`/v1/b/${SLUG}/availability`)
      .query({ locationId: local, serviceIds: servico, dateFrom: amanha, professionalId: profissional })
      .expect(200);
    const horario = grade.body.days[0].slots[0] as { start: string; startsAt: string };

    const marcado = await http()
      .post(`/v1/b/${SLUG}/appointments`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', chave)
      .send({
        locationId: local,
        professionalId: profissional,
        serviceIds: [servico],
        date: amanha,
        start: horario.start,
      })
      .expect(201);
    return {
      id: marcado.body.id as string,
      comecaEm: horario.startsAt,
      local,
      servico,
      profissional,
      dia: amanha,
    };
  }

  const meu = (token: string, texto: string) =>
    http().post(`/v1/b/${SLUG}/agente/meu`).set('Authorization', `Bearer ${token}`).send({ texto });

  it('"não consigo ir" vira oferta de remarcação, não só um cancelamento', async () => {
    /**
     * É o diálogo da SPEC §4.17 — *"— Não consigo ir hoje. — Sem problemas.
     * Quer remarcar com João?"* — e a inversão é o valor do bloco: quem só
     * cancela deixa a cadeira vazia, quem remarca continua sendo atendido.
     */
    await abrirBarbearia();
    const cliente = await entrarComoCliente();
    const { id: agendamento } = await marcarAmanha(cliente, 'agente-remarcar-1');

    const r = await meu(cliente, 'não consigo ir amanhã').expect(201);
    expect(r.body.escalar).toBe(false);
    expect(r.body.agendamento.id).toBe(agendamento);
    expect(r.body.horarios.length).toBeGreaterThan(0);
  });

  it('a grade oferecida ignora o próprio horário do cliente', async () => {
    /**
     * Sem `ignoreAppointmentId` o motor conta a própria reserva como ocupação e
     * esconde justamente a faixa em que a pessoa já cabe.
     *
     * A asserção é sobre **o instante reservado**, e não sobre "algum horário
     * diferente do público": a primeira versão comparava com a grade colapsada
     * da equipe e passava verde com o parâmetro removido — provando que as duas
     * consultas são diferentes, que não é a regra.
     */
    await abrirBarbearia();
    const cliente = await entrarComoCliente();
    const marcado = await marcarAmanha(cliente, 'agente-remarcar-2');

    const publico = await http()
      .get(`/v1/b/${SLUG}/availability`)
      .query({
        locationId: marcado.local,
        serviceIds: marcado.servico,
        professionalId: marcado.profissional,
        dateFrom: marcado.dia,
      })
      .expect(200);
    const publicos: string[] = publico.body.days[0].slots.map(
      (s: { startsAt: string }) => s.startsAt,
    );
    expect(publicos).not.toContain(marcado.comecaEm);

    const r = await meu(cliente, 'quero remarcar para amanhã').expect(201);
    const oferecidos: string[] = r.body.horarios.map((h: { comecaEm: string }) => h.comecaEm);
    expect(oferecidos).toContain(marcado.comecaEm);
  });

  it('quem não tem horário marcado recebe resposta, não escalada', async () => {
    // Escalar aqui mandaria ao balcão alguém que só precisa saber que não tem
    // nada marcado — pergunta que a tela responde sozinha.
    await abrirBarbearia();
    const cliente = await entrarComoCliente();

    const r = await meu(cliente, 'quero remarcar').expect(201);
    expect(r.body.escalar).toBe(false);
    expect(r.body.semAgendamento).toBe(true);
  });

  it('a conversa de remarcação não grava nada', async () => {
    /**
     * O que sai daqui é proposta. Gravar continua sendo `POST
     * /appointments/:id/reschedule`, que é onde moram a janela mínima, o teto de
     * remarcações, o sinal e o disparo da fila de espera.
     */
    await abrirBarbearia();
    const cliente = await entrarComoCliente();
    const { id: agendamento } = await marcarAmanha(cliente, 'agente-remarcar-3');

    const antes = await admin.$queryRawUnsafe<{ service_starts_at: Date }[]>(
      `SELECT service_starts_at FROM appointments WHERE id = '${agendamento}'`,
    );
    await meu(cliente, 'quero remarcar para amanhã de tarde').expect(201);
    const depois = await admin.$queryRawUnsafe<{ service_starts_at: Date }[]>(
      `SELECT service_starts_at FROM appointments WHERE id = '${agendamento}'`,
    );
    expect(depois[0]?.service_starts_at).toEqual(antes[0]?.service_starts_at);
  });

  it('sem sessão a rota de remarcação recusa', async () => {
    // Remarcar exige saber **qual** agendamento, e um id sem sessão seria o
    // caminho para mexer no horário alheio.
    await abrirBarbearia();
    await http().post(`/v1/b/${SLUG}/agente/meu`).send({ texto: 'quero remarcar' }).expect(401);
  });

  it('a conversa autenticada não vira a segunda porta de marcar', async () => {
    /**
     * Marcar tem a rota pública. Duplicá-la sob a guarda daria duas respostas
     * possíveis para a mesma frase conforme o cookie — que é como duas telas
     * passam a discordar sobre o mesmo fato.
     */
    await abrirBarbearia();
    const cliente = await entrarComoCliente();
    const r = await meu(cliente, 'quero cortar amanhã às 10h').expect(201);
    expect(r.body.escalar).toBe(true);
    expect(r.body.horarios).toBeUndefined();
  });
});
