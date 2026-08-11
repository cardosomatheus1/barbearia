import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeMessagingProvider } from '@barbearia/identity';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { RecadoPublicoController } from '../src/booking/recado.controller.js';
import { RecadoController } from '../src/admin/recado.controller.js';
import { TeamController, MeController } from '../src/admin/team.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';
import { limparBanco } from './limpar.js';

/**
 * O canal de recados pela HTTP (bloco 40).
 *
 * Quatro perguntas: dá para mandar sem conta? A resposta conta alguma coisa
 * sobre o cadastro de quem mandou? Um recado atravessa de uma barbearia para a
 * outra? E existe alguma rota capaz de apagar uma reclamação?
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

const RECLAMACAO = 'Esperei quarenta minutos e ninguém me avisou de nada.';

describeIfDb('recados do cliente pela HTTP', () => {
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
        RecadoPublicoController,
        RecadoController,
        TeamController,
        MeController,
      ],
      providers: [
        TenantService,
        { provide: MESSAGING_PROVIDER, useValue: mensagens },
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

    return { token, tenantId: entrou.body.tenantId as string, slug: entrou.body.slug as string };
  }

  const mandar = (slug: string, corpo: Record<string, unknown>) =>
    http().post(`/v1/b/${slug}/feedback`).send(corpo);

  // -- o canal do cliente ------------------------------------------------------

  it('dá para reclamar sem conta e sem deixar nome', async () => {
    /**
     * A decisão que faz o canal existir. A reclamação mais valiosa vem de quem
     * desistiu e foi embora, e essa pessoa não vai criar cadastro para reclamar.
     */
    const casa = await abrirBarbearia();
    const resposta = await mandar(casa.slug, {
      tipo: 'reclamacao',
      texto: RECLAMACAO,
    }).expect(201);

    expect(resposta.body).toEqual({ registrado: true });

    const fila = await com(casa.token)(http().get('/v1/admin/recados')).expect(200);
    expect(fila.body.recados).toHaveLength(1);
    expect(fila.body.recados[0]).toMatchObject({ clienteNome: null, temContato: false });
  });

  it('quem deixa contato vira cliente, e a resposta não conta isso', async () => {
    /**
     * `resolveGuestCustomer` reencontra o cliente existente pelo telefone.
     * Devolver qualquer coisa diferente — o id, "você já mandou três" — viraria
     * oráculo: com uma lista de números se descobre quem é cliente de quem.
     */
    const casa = await abrirBarbearia();
    const primeira = await mandar(casa.slug, {
      tipo: 'sugestao',
      texto: 'Vocês deviam abrir aos domingos de manhã.',
      nome: 'Carlos Souza',
      telefone: '(71) 96666-5555',
    }).expect(201);

    const segunda = await mandar(casa.slug, {
      tipo: 'elogio',
      texto: 'O Ruan cortou muito bem, obrigado!',
      nome: 'Carlos Souza',
      telefone: '(71) 96666-5555',
    }).expect(201);

    // Idênticas: a segunda vem de quem já é cliente, e nada denuncia isso.
    expect(segunda.body).toEqual(primeira.body);

    const fila = await com(casa.token)(http().get('/v1/admin/recados')).expect(200);
    expect(fila.body.recados).toHaveLength(2);
    expect(fila.body.recados.every((r: { temContato: boolean }) => r.temContato)).toBe(true);
  });

  it('com código exigido para agendar, o recado entra anônimo em vez de criar cadastro', async () => {
    /**
     * Achado da revisão de segurança deste bloco. Sem a política, esta rota
     * seria a porta lateral para criar cadastro com telefone alheio — a mesma
     * que a lista de espera fechou no bloco 38.
     *
     * A saída é diferente da espera, e é decisão escrita: ali a recusa é certa,
     * porque entrar numa lista pressupõe que a barbearia saiba chamar a pessoa.
     * Aqui recusar transformaria o interruptor de segurança do agendamento num
     * silenciador de reclamação.
     */
    const casa = await abrirBarbearia();
    // Não há rota de admin para este interruptor ainda; ele é coluna da
    // unidade desde o bloco 6, e o que se prova aqui é o efeito dele.
    await admin.$executeRawUnsafe(
      `UPDATE locations SET require_otp_for_booking = true WHERE tenant_id = '${casa.tenantId}'`,
    );

    await mandar(casa.slug, {
      tipo: 'reclamacao',
      texto: RECLAMACAO,
      nome: 'Carlos Souza',
      telefone: '(71) 96666-5555',
    }).expect(201);

    // O recado chegou, e nenhum cadastro nasceu do telefone informado.
    const fila = await com(casa.token)(http().get('/v1/admin/recados')).expect(200);
    expect(fila.body.recados).toHaveLength(1);
    expect(fila.body.recados[0]).toMatchObject({ clienteNome: null, temContato: false });

    const clientes = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM customers WHERE tenant_id = '${casa.tenantId}'`,
    );
    expect(Number(clientes[0]?.n)).toBe(0);
  });

  it('texto curto é recusado, e a recusa fala do formulário', async () => {
    // Recusa de formulário sai: ela fala do que a pessoa acabou de digitar, e
    // não do cadastro de ninguém.
    const casa = await abrirBarbearia();
    const resposta = await mandar(casa.slug, { tipo: 'reclamacao', texto: 'ruim' }).expect(400);
    expect(resposta.body.error.code).toBe('invalid_request');
  });

  // -- a fila do balcão --------------------------------------------------------

  it('a fila põe a reclamação na frente do elogio mais antigo', async () => {
    const casa = await abrirBarbearia();
    await mandar(casa.slug, { tipo: 'elogio', texto: 'Atendimento nota mil, sempre.' }).expect(201);
    await mandar(casa.slug, { tipo: 'reclamacao', texto: RECLAMACAO }).expect(201);

    const fila = await com(casa.token)(http().get('/v1/admin/recados')).expect(200);
    expect(fila.body.recados.map((r: { tipo: string }) => r.tipo)).toEqual([
      'reclamacao',
      'elogio',
    ]);
  });

  it('a barbearia vizinha não enxerga o recado desta', async () => {
    const casa = await abrirBarbearia();
    await mandar(casa.slug, { tipo: 'reclamacao', texto: RECLAMACAO }).expect(201);

    const rival = await abrirBarbearia(RIVAL);
    const fila = await com(rival.token)(http().get('/v1/admin/recados')).expect(200);
    expect(fila.body.recados).toHaveLength(0);
  });

  it('o recado anônimo não pode ser dado como respondido', async () => {
    // Gravar "respondido" sobre quem não deixou contato seria o pior tipo de
    // indicador: o que diz que a casa respondeu quando ninguém foi respondido.
    const casa = await abrirBarbearia();
    await mandar(casa.slug, { tipo: 'reclamacao', texto: RECLAMACAO }).expect(201);

    const fila = await com(casa.token)(http().get('/v1/admin/recados')).expect(200);
    const id = fila.body.recados[0].id as string;

    const recusa = await com(casa.token)(
      http().post(`/v1/admin/recados/${id}/responder`).send({ resposta: 'Obrigado pelo aviso.' }),
    ).expect(409);
    expect(recusa.body.error.code).toBe('sem_contato');
  });

  it('assumir, responder e encerrar percorrem o recado inteiro', async () => {
    const casa = await abrirBarbearia();
    await mandar(casa.slug, {
      tipo: 'reclamacao',
      texto: RECLAMACAO,
      nome: 'Carlos Souza',
      telefone: '(71) 96666-5555',
    }).expect(201);

    const fila = await com(casa.token)(http().get('/v1/admin/recados')).expect(200);
    const id = fila.body.recados[0].id as string;

    await com(casa.token)(http().post(`/v1/admin/recados/${id}/assumir`)).expect(201);
    await com(casa.token)(
      http()
        .post(`/v1/admin/recados/${id}/responder`)
        .send({ resposta: 'Desculpe pela espera. Reforçamos a escala de sábado.' }),
    ).expect(201);
    await com(casa.token)(http().post(`/v1/admin/recados/${id}/encerrar`)).expect(201);

    const encerrados = await com(casa.token)(
      http().get('/v1/admin/recados?incluirEncerrados=1'),
    ).expect(200);
    expect(encerrados.body.recados[0]).toMatchObject({
      estado: 'encerrado',
      responsavelNome: 'Matheus Cardoso',
    });
    // Encerrar não é apagar: o texto continua contando para a leitura da casa.
    expect(encerrados.body.recados[0].texto).toBe(RECLAMACAO);
  });

  it('assumir marca quem assumiu, e não quem o corpo mandar', async () => {
    /**
     * A rota não aceita responsável no corpo. Sem isso o gesto teria dois
     * significados — "assumo" e "penduro no colega" — e a tela mandaria vazio,
     * que foi como a primeira versão devolveu o recado à triagem clicando em
     * "Assumir".
     */
    const casa = await abrirBarbearia();
    await mandar(casa.slug, { tipo: 'sugestao', texto: 'Abram aos domingos, por favor.' }).expect(
      201,
    );

    const fila = await com(casa.token)(http().get('/v1/admin/recados')).expect(200);
    const id = fila.body.recados[0].id as string;

    await com(casa.token)(
      http()
        .post(`/v1/admin/recados/${id}/assumir`)
        .send({ responsavelId: '00000000-0000-0000-0000-000000000001' }),
    ).expect(201);

    const depois = await com(casa.token)(http().get('/v1/admin/recados')).expect(200);
    expect(depois.body.recados[0].responsavelNome).toBe('Matheus Cardoso');
  });

  it('devolver à fila é a saída de "assumi por engano"', async () => {
    const casa = await abrirBarbearia();
    await mandar(casa.slug, { tipo: 'sugestao', texto: 'Coloquem revista na espera.' }).expect(201);

    const fila = await com(casa.token)(http().get('/v1/admin/recados')).expect(200);
    const id = fila.body.recados[0].id as string;

    await com(casa.token)(http().post(`/v1/admin/recados/${id}/assumir`)).expect(201);
    await com(casa.token)(http().post(`/v1/admin/recados/${id}/devolver`)).expect(201);

    const depois = await com(casa.token)(http().get('/v1/admin/recados')).expect(200);
    expect(depois.body.recados[0].responsavelId).toBeNull();
  });

  it('não existe rota capaz de apagar um recado', async () => {
    /**
     * O limite ético da SPEC §4.10 na borda. Mesmo que alguém escrevesse a
     * chamada, o role da aplicação não tem `DELETE` na tabela — mas a superfície
     * também não oferece o caminho.
     */
    const casa = await abrirBarbearia();
    await mandar(casa.slug, { tipo: 'reclamacao', texto: RECLAMACAO }).expect(201);

    const fila = await com(casa.token)(http().get('/v1/admin/recados')).expect(200);
    const id = fila.body.recados[0].id as string;

    await com(casa.token)(http().delete(`/v1/admin/recados/${id}`)).expect(404);
    await com(casa.token)(http().post(`/v1/admin/recados/${id}/apagar`)).expect(404);

    expect(
      (await com(casa.token)(http().get('/v1/admin/recados')).expect(200)).body.recados,
    ).toHaveLength(1);
  });

  it('sem permissão de recado, a fila não abre', async () => {
    /**
     * O barbeiro não recebe `feedback.view` por padrão, e é decisão: reclamação
     * costuma ser sobre uma pessoa, e escrita por quem não sabe que alguém do
     * salão vai ler.
     */
    const casa = await abrirBarbearia();
    const criada = await com(casa.token)(
      http()
        .post('/v1/admin/team')
        .send({ name: 'Ruan Nascimento', email: 'ruan@domari.com.br', role: 'professional' }),
    ).expect(201);

    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email: 'ruan@domari.com.br', password: criada.body.senhaInicial })
      .expect(201);

    // A senha de primeiro acesso tranca **tudo** com `must_change_password`, e
    // um 403 por esse motivo provaria outra coisa. Troca primeiro; o 403 que
    // interessa é o da permissão.
    await com(entrou.body.token)(
      http().put('/v1/admin/me/password').send({
        currentPassword: criada.body.senhaInicial,
        newPassword: 'a-senha-que-ele-escolheu',
      }),
    ).expect(200);

    const dele = await http()
      .post('/v1/admin/login')
      .send({ email: 'ruan@domari.com.br', password: 'a-senha-que-ele-escolheu' })
      .expect(201);

    const recusa = await com(dele.body.token)(http().get('/v1/admin/recados')).expect(403);
    expect(recusa.body.error.code).toBe('forbidden');
  });
});
