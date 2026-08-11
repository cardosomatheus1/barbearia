import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { oferecerProximaVaga } from '@barbearia/scheduling';
import { FakeMessagingProvider } from '@barbearia/identity';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import {
  EsperaDoClienteController,
  EsperaPublicaController,
} from '../src/booking/espera.controller.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { CustomerGuard } from '../src/auth/customer.guard.js';
import { OfertaPublicaController } from '../src/booking/oferta.controller.js';
import { BoardController } from '../src/admin/board.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';
import { limparBanco } from './limpar.js';

/**
 * O convite de vaga pela HTTP (bloco 39).
 *
 * A borda que a revisão de segurança não pôde revisar quando o bloco foi
 * escrito, porque ela ainda não existia: o token é a credencial, viaja no
 * endereço e não tem sessão nenhuma atrás dele.
 *
 * Três perguntas: a tela do convite vaza nome ou telefone de alguém? Um token
 * de outra barbearia atravessa? E o mesmo link marca duas vezes?
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

let app: INestApplication;
let admin: PrismaClient;
let tenants: TenantService;
let mensagens: FakeMessagingProvider;

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const DONO = {
  name: 'Matheus Cardoso',
  email: 'dono@domari.com.br',
  password: 'senha-bem-comprida',
  phone: '(71) 98888-7777',
  businessName: 'Domari Barber Club',
};

const RIVAL = {
  name: 'Dono Rival',
  email: 'dono@rival.com.br',
  password: 'outra-senha-comprida',
  phone: '(71) 97777-6666',
  businessName: 'Rival Barbearia',
};

const JORNADA = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 0,
  endMinute: 1439,
}));

/**
 * Amanhã, às 9h da unidade. `America/Bahia` é UTC−3 o ano inteiro.
 *
 * Amanhã e não hoje: um horário encostado na antecedência mínima deixa de ser
 * marcável entre uma consulta e o POST seguinte quando a máquina está sob carga,
 * e o teste falha por um defeito que não existe.
 */
function amanha(): { readonly dia: string; readonly inicio: Date; readonly fim: Date } {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 1);
  const dia = base.toISOString().slice(0, 10);
  return {
    dia,
    inicio: new Date(`${dia}T12:00:00Z`),
    fim: new Date(`${dia}T12:30:00Z`),
  };
}

describeIfDb('convite de vaga pela HTTP', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
    mensagens = new FakeMessagingProvider();

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [
        StaffAuthController,
        OnboardingController,
        BoardController,
        EsperaPublicaController,
        EsperaDoClienteController,
        OfertaPublicaController,
        AuthController,
      ],
      providers: [
        TenantService,
        { provide: MESSAGING_PROVIDER, useValue: mensagens },
        CustomerGuard,
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
    for (const slug of ['domari-barber-club', 'rival-barbearia']) tenants.forget(slug);
    mensagens.clear();
  });

  const http = () => request(app.getHttpServer());
  const com = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  async function abrirBarbearia(conta = DONO) {
    await http().post('/v1/admin/signup').send(conta).expect(202);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email: conta.email, password: conta.password })
      .expect(201);
    const token: string = entrou.body.token;
    const tenantId: string = entrou.body.tenantId;
    const slug: string = entrou.body.slug;

    await com(token)(
      http()
        .put('/v1/admin/business')
        .send({ name: conta.businessName, city: 'Salvador', timezone: 'America/Bahia' }),
    ).expect(200);

    await com(token)(
      http()
        .put('/v1/admin/services')
        .send({
          services: [
            {
              key: 'cabelo',
              name: 'Corte de cabelo',
              category: 'Cabelo',
              durationMinutes: 30,
              bufferAfterMinutes: 0,
              priceCents: 4900,
            },
          ],
        }),
    ).expect(200);

    await com(token)(
      http()
        .put('/v1/admin/professionals')
        .send({ professionals: [{ name: 'Ruan Nascimento', schedule: JORNADA }] }),
    ).expect(200);

    await com(token)(http().post('/v1/admin/publish')).expect(201);

    // O convite cai junto com o recurso que o cria. Conta nova nasce sem ele,
    // então ligá-lo aqui é parte do cenário, não detalhe de arrumação.
    await admin.$executeRawUnsafe(
      `INSERT INTO tenant_features (tenant_id, flag_code, enabled)
       VALUES ('${tenantId}', 'avisos', true)
       ON CONFLICT (tenant_id, flag_code) DO UPDATE SET enabled = true`,
    );

    const catalogo = await com(token)(http().get('/v1/admin/catalog')).expect(200);
    const estado = await com(token)(http().get('/v1/admin/state')).expect(200);
    return {
      token,
      tenantId,
      slug,
      locationId: estado.body.locationId as string,
      serviceId: catalogo.body.services[0].id as string,
      professionalId: catalogo.body.professionals[0].id as string,
    };
  }

  /** Põe alguém na lista e oferece a vaga, como o worker faria. */
  async function convidar(casa: Awaited<ReturnType<typeof abrirBarbearia>>) {
    const quando = amanha();

    await http()
      .post(`/v1/b/${casa.slug}/waitlist`)
      .send({
        name: 'Carlos Souza',
        phone: '(71) 96666-5555',
        locationId: casa.locationId,
        serviceIds: [casa.serviceId],
        de: quando.dia,
        ate: quando.dia,
        inicio: '08:00',
        fim: '12:00',
      })
      .expect(201);

    const oferta = await oferecerProximaVaga({
      tenantId: casa.tenantId,
      locationId: casa.locationId,
      professionalId: casa.professionalId,
      inicio: quando.inicio,
      fim: quando.fim,
      agora: new Date(),
    });
    if (!oferta) throw new Error('a vaga não foi oferecida a ninguém');
    return { ...oferta, quando };
  }

  it('o link mostra a vaga e não conta nada de ninguém', async () => {
    const casa = await abrirBarbearia();
    const convite = await convidar(casa);

    const resposta = await http()
      .get(`/v1/b/${casa.slug}/offer/${convite.token}`)
      .expect(200);

    expect(resposta.body).toMatchObject({
      estado: 'aberta',
      hora: '09:00',
      profissionalNome: 'Ruan Nascimento',
      barbearia: 'Domari Barber Club',
    });
    // Nem o nome nem o telefone de quem foi convidada: o link acaba num grupo
    // de família em dois toques.
    const corpo = JSON.stringify(resposta.body);
    expect(corpo).not.toContain('Carlos');
    expect(corpo).not.toContain('6666');
  });

  it('token inventado responde igual a token de outra barbearia', async () => {
    // Diferenciar diria a quem varre links que aquele token existe em algum
    // lugar — e o "algum lugar" é o nome da barbearia no endereço.
    const casa = await abrirBarbearia();
    const convite = await convidar(casa);
    const rival = await abrirBarbearia(RIVAL);

    const inventado = await http()
      .get(`/v1/b/${casa.slug}/offer/${'x'.repeat(43)}`)
      .expect(404);
    const alheio = await http()
      .get(`/v1/b/${rival.slug}/offer/${convite.token}`)
      .expect(404);

    expect(alheio.body.error.code).toBe(inventado.body.error.code);
  });

  it('aceitar marca o horário, e o mesmo link não marca duas vezes', async () => {
    const casa = await abrirBarbearia();
    const convite = await convidar(casa);

    const marcou = await http()
      .post(`/v1/b/${casa.slug}/offer/${convite.token}/accept`)
      .expect(201);
    expect(marcou.body.agendamentoId).toBeTruthy();

    await http().post(`/v1/b/${casa.slug}/offer/${convite.token}/accept`).expect(409);

    const quantos = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM appointments WHERE tenant_id = '${casa.tenantId}'`,
    );
    expect(Number(quantos[0]?.n)).toBe(1);
  });

  it('o convite de outra barbearia não marca nada aqui', async () => {
    const casa = await abrirBarbearia();
    const convite = await convidar(casa);
    const rival = await abrirBarbearia(RIVAL);

    await http().post(`/v1/b/${rival.slug}/offer/${convite.token}/accept`).expect(404);

    const quantos = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM appointments`,
    );
    expect(Number(quantos[0]?.n)).toBe(0);
  });

  /** Uma sessão de cliente, pelo mesmo caminho que o site usa. */
  async function sessaoDe(slug: string, phone: string, name: string): Promise<string> {
    await http().post(`/v1/b/${slug}/auth/otp`).send({ phone, name }).expect(201);
    const codigo = mensagens.sent.at(-1)?.code;
    if (!codigo) throw new Error('nenhum código enviado');
    const sessao = await http()
      .post(`/v1/b/${slug}/auth/verify`)
      .send({ phone, code: codigo })
      .expect(201);
    return sessao.body.token as string;
  }

  it('quem tem sessão vê o convite e o aceita sem o link', async () => {
    /**
     * O convite chega por mensagem, e o token existe em claro uma vez só —
     * dentro dela. Enquanto o canal oficial não entra (bloco 55), o que sai é o
     * provedor de console: sem esta porta, o horário fica guardado para a pessoa
     * e ela não tem nenhum caminho até ele.
     */
    const casa = await abrirBarbearia();
    await convidar(casa);

    const cliente = await sessaoDe(casa.slug, '(71) 96666-5555', 'Carlos Souza');
    const lista = await http()
      .get(`/v1/b/${casa.slug}/waitlist`)
      .set('Authorization', `Bearer ${cliente}`)
      .expect(200);
    expect(lista.body.esperas[0].convite).toMatchObject({ hora: '09:00' });

    const marcou = await http()
      .post(`/v1/b/${casa.slug}/waitlist/${lista.body.esperas[0].id}/accept`)
      .set('Authorization', `Bearer ${cliente}`)
      .expect(201);
    expect(marcou.body.agendamentoId).toBeTruthy();
  });

  it('a sessão de outro cliente não aceita o convite alheio', async () => {
    // A RLS separa barbearias e **não** separa clientes dentro de uma: sem o
    // filtro por `customer_id`, bastaria o id da entrada — que viaja na tela de
    // quem espera — para marcar no horário conquistado por outra pessoa.
    const casa = await abrirBarbearia();
    await convidar(casa);

    const dono = await sessaoDe(casa.slug, '(71) 96666-5555', 'Carlos Souza');
    const lista = await http()
      .get(`/v1/b/${casa.slug}/waitlist`)
      .set('Authorization', `Bearer ${dono}`)
      .expect(200);
    const entryId = lista.body.esperas[0].id as string;

    const intruso = await sessaoDe(casa.slug, '(71) 95555-4444', 'Bruno Lima');
    await http()
      .post(`/v1/b/${casa.slug}/waitlist/${entryId}/accept`)
      .set('Authorization', `Bearer ${intruso}`)
      .expect(404);

    const quantos = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM appointments`,
    );
    expect(Number(quantos[0]?.n)).toBe(0);
  });

  it('com o aviso desligado, o link deixa de valer', async () => {
    // O convite cai junto com o interruptor que o criou. Sem isto, desligar
    // avisos deixaria no ar um caminho vivo para um recurso que a barbearia
    // desligou.
    const casa = await abrirBarbearia();
    const convite = await convidar(casa);

    await admin.$executeRawUnsafe(
      `UPDATE tenant_features SET enabled = false
        WHERE tenant_id = '${casa.tenantId}' AND flag_code = 'avisos'`,
    );

    await http().get(`/v1/b/${casa.slug}/offer/${convite.token}`).expect(404);
    await http().post(`/v1/b/${casa.slug}/offer/${convite.token}/accept`).expect(404);
  });
});
