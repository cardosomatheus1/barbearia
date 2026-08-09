import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LgpdController } from '../src/admin/lgpd.controller.js';
import { MeController, TeamController } from '../src/admin/team.controller.js';
import { MfaController } from '../src/admin/mfa.controller.js';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { ConsoleMessagingProvider, codigoDoPasso, passoAgora } from '@barbearia/identity';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';
import { limparBanco } from './limpar.js';

/**
 * Os direitos do titular pela HTTP (bloco 31).
 *
 * O que estas provas seguram, em ordem de gravidade:
 *
 * 1. **Exportar não é ver.** `customers.view` abre a ficha; a cópia integral dos
 *    dados de uma pessoa é `customers.export`, que a recepção não tem. As duas
 *    rotas vivem no mesmo controller e a distinção só existe se for exercida.
 * 2. **A barbearia vizinha não é encontrada, e não é recusada.** Cliente de
 *    outro tenant responde 404 — 403 confirmaria que o id existe.
 * 3. **Consentir e revogar é histórico.** A revogação não apaga a concessão, e
 *    o espelho que a campanha lê acompanha a decisão mais recente.
 * 4. **Recusa de pedido exige motivo.** É a linha que se defende numa
 *    fiscalização, e sem ela a recusa não se sustenta.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

let app: INestApplication;
let admin: PrismaClient;
let tenants: TenantService;

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const DONO = {
  name: 'Matheus Cardoso',
  email: 'dono@domari.com.br',
  password: 'senha-bem-comprida',
  phone: '(71) 98888-7777',
  businessName: 'Domari Barber Club',
};

const VIZINHA = {
  name: 'Rita Alves',
  email: 'rita@vizinha.com.br',
  password: 'outra-senha-comprida',
  phone: '(71) 97777-6666',
  businessName: 'Barbearia Vizinha',
};

describeIfDb('direitos do titular pela HTTP', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [
        StaffAuthController,
        OnboardingController,
        TeamController,
        // A conta nova troca a senha de primeiro acesso antes de operar
        // qualquer coisa: sem este controller a recepcionista do teste nunca
        // chega a existir de verdade.
        MeController,
        // A exportação declara `finance.view` junto, e o segundo fator é derivado
        // da permissão: sem este controller o dono não consegue prová-lo.
        MfaController,
        LgpdController,
      ],
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
    for (const slug of ['domari-barber-club', 'barbearia-vizinha']) tenants.forget(slug);
  });

  const http = () => request(app.getHttpServer());
  const com = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  async function entrar(quem: typeof DONO): Promise<string> {
    await http().post('/v1/admin/signup').send(quem).expect(202);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email: quem.email, password: quem.password })
      .expect(201);
    return entrou.body.token;
  }

  async function recepcionista(dono: string) {
    const email = 'maria@domari.com.br';
    const criada = await com(dono)(
      http().post('/v1/admin/team').send({ name: 'Maria Recepção', email, role: 'receptionist' }),
    ).expect(201);

    const senhaInicial: string = criada.body.senhaInicial;
    const primeira = await http()
      .post('/v1/admin/login')
      .send({ email, password: senhaInicial })
      .expect(201);
    await com(primeira.body.token)(
      http()
        .put('/v1/admin/me/password')
        .send({ currentPassword: senhaInicial, newPassword: 'a-senha-dela-agora' }),
    ).expect(200);

    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email, password: 'a-senha-dela-agora' })
      .expect(201);
    return entrou.body.token as string;
  }

  /** Uma conta de papel qualquer, com a senha de primeiro acesso já trocada. */
  async function conta(dono: string, email: string, papel: string): Promise<string> {
    const criada = await com(dono)(
      http().post('/v1/admin/team').send({ name: 'Bruno Gerente', email, role: papel }),
    ).expect(201);

    const senhaInicial: string = criada.body.senhaInicial;
    const primeira = await http()
      .post('/v1/admin/login')
      .send({ email, password: senhaInicial })
      .expect(201);
    await com(primeira.body.token)(
      http()
        .put('/v1/admin/me/password')
        .send({ currentPassword: senhaInicial, newPassword: 'a-senha-dele-agora' }),
    ).expect(200);

    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email, password: 'a-senha-dele-agora' })
      .expect(201);
    return entrou.body.token as string;
  }

  /** Liga o segundo fator e o prova para esta sessão. */
  async function comSegundoFator(token: string): Promise<void> {
    const inicio = await com(token)(http().post('/v1/admin/mfa/setup')).expect(201);
    const segredo: string = inicio.body.segredoBase32;
    const passo = passoAgora(new Date());

    await com(token)(
      http().post('/v1/admin/mfa/confirm').send({ codigo: codigoDoPasso(segredo, passo) }),
    ).expect(201);
    // O passo da confirmação foi queimado; o do passo seguinte é o que serve, e
    // continua dentro da tolerância de ±1 se o relógio virar a janela aqui.
    await com(token)(
      http().post('/v1/admin/mfa/verify').send({ codigo: codigoDoPasso(segredo, passo + 1) }),
    ).expect(201);
  }

  async function cliente(token: string, nome = 'Carlos Souza'): Promise<string> {
    const estado = await com(token)(http().get('/v1/admin/state')).expect(200);
    const sufixo = String(Math.floor(Math.random() * 9000) + 1000);
    const linhas = await admin.$queryRawUnsafe<{ id: string }[]>(`
      INSERT INTO customers (tenant_id, name, phone_e164)
      VALUES ('${estado.body.tenantId}', '${nome}', '+5571988${sufixo}77')
      RETURNING id
    `);
    const id = linhas[0]?.id;
    if (!id) throw new Error('não deu para criar o cliente');
    return id;
  }

  // -- consentimento ---------------------------------------------------------

  it('consentir e revogar viram duas linhas, e o espelho segue a última', async () => {
    const dono = await entrar(DONO);
    const carlos = await cliente(dono);

    await com(dono)(
      http()
        .put(`/v1/admin/customers/${carlos}/consentimentos`)
        .send({ finalidade: 'marketing', concedido: true, versaoDoTexto: 'marketing-2026-08' }),
    ).expect(200);

    await com(dono)(
      http()
        .put(`/v1/admin/customers/${carlos}/consentimentos`)
        .send({ finalidade: 'marketing', concedido: false, versaoDoTexto: 'marketing-2026-08' }),
    ).expect(200);

    const lido = await com(dono)(
      http().get(`/v1/admin/customers/${carlos}/consentimentos`),
    ).expect(200);

    // A concessão continua no histórico. É o par de datas que responde a uma
    // contestação: "quando aceitou" e "quando revogou" são perguntas diferentes.
    expect(lido.body.historico).toHaveLength(2);
    expect(lido.body.atuais.marketing.concedido).toBe(false);
    expect(lido.body.historico[0].registradoPeloBalcao).toBe(true);

    const espelho = await admin.$queryRawUnsafe<{ accepts_marketing: boolean }[]>(
      `SELECT accepts_marketing FROM customers WHERE id = '${carlos}'`,
    );
    expect(espelho[0]?.accepts_marketing).toBe(false);
  });

  it('consentimento sem versão do texto é recusado na borda', async () => {
    // Sem a versão, "ele aceitou" não diz o que ele leu — e uma linha com cara
    // de prova que não prova nada é pior do que linha nenhuma.
    const dono = await entrar(DONO);
    const carlos = await cliente(dono);

    await com(dono)(
      http()
        .put(`/v1/admin/customers/${carlos}/consentimentos`)
        .send({ finalidade: 'marketing', concedido: true, versaoDoTexto: '  ' }),
    ).expect(400);

    await com(dono)(
      http()
        .put(`/v1/admin/customers/${carlos}/consentimentos`)
        .send({ finalidade: 'tudo', concedido: true, versaoDoTexto: 'v1' }),
    ).expect(400);
  });

  it('a recepção registra o consentimento, e não exporta a pessoa inteira', async () => {
    const dono = await entrar(DONO);
    const maria = await recepcionista(dono);
    const carlos = await cliente(dono);

    await com(maria)(http().get(`/v1/admin/customers/${carlos}/consentimentos`)).expect(200);
    await com(maria)(
      http()
        .put(`/v1/admin/customers/${carlos}/consentimentos`)
        .send({ finalidade: 'photos', concedido: true, versaoDoTexto: 'fotos-2026-08' }),
    ).expect(200);

    // Exportar a ficha de uma pessoa é o mesmo vetor da exportação da base
    // inteira, em escala menor — e por isso é outra permissão.
    const negado = await com(maria)(http().get(`/v1/admin/customers/${carlos}/dados`)).expect(403);
    expect(negado.body.error.code).toBe('forbidden');
  });

  it('exportar não é atalho para o dinheiro nem para a anotação privada', async () => {
    /**
     * O achado da `/security-review` deste bloco.
     *
     * O arquivo traz o saldo de fiado, os totais das comandas, o razão inteiro
     * **e** a anotação privada do cliente. Em qualquer outra rota esses dados
     * exigem `finance.view` (e, por derivação, o segundo fator) e
     * `customers.view_notes`. Com uma permissão só, a exportação virava o
     * caminho mais curto para os três — e desde o bloco 30 o dono pode conceder
     * `customers.export` sozinha pela tela, achando que está delegando só o
     * atendimento a pedido de LGPD.
     *
     * A recepção com `customers.export` é exatamente esse cenário: ela recebe a
     * permissão nova e continua sem `finance.view` e sem `customers.view_notes`.
     */
    const dono = await entrar(DONO);
    const maria = await recepcionista(dono);
    const carlos = await cliente(dono);

    await com(dono)(
      http()
        .put('/v1/admin/team/permissoes/receptionist')
        .send({
          permissoes: [
            'appointments.view',
            'customers.view',
            'customers.edit',
            'customers.export',
          ],
        }),
    ).expect(200);

    const negado = await com(maria)(http().get(`/v1/admin/customers/${carlos}/dados`)).expect(403);
    expect(negado.body.error.code).toBe('forbidden');

    // E a leitura que ela legitimamente tem continua funcionando: a recusa é da
    // exportação, não da conta.
    await com(maria)(http().get(`/v1/admin/customers/${carlos}/consentimentos`)).expect(200);
  });

  // -- exportação ------------------------------------------------------------

  it('exportar exige o segundo fator, porque o arquivo traz dinheiro', async () => {
    /**
     * A exigência não está escrita na rota: ela é **derivada** do
     * `finance.view` que a rota declara. É o mesmo mecanismo do caixa, e é o que
     * garante que uma rota de dinheiro nova nasça coberta.
     */
    const dono = await entrar(DONO);
    const carlos = await cliente(dono);

    const semAutenticador = await com(dono)(
      http().get(`/v1/admin/customers/${carlos}/dados`),
    ).expect(403);
    expect(semAutenticador.body.error.code).toBe('mfa_setup_required');

    await comSegundoFator(dono);
    await com(dono)(http().get(`/v1/admin/customers/${carlos}/dados`)).expect(200);
  });

  it('a exportação traz o histórico, o encarregado, e fica na trilha', async () => {
    const dono = await entrar(DONO);
    await comSegundoFator(dono);
    const carlos = await cliente(dono);

    await com(dono)(
      http().put('/v1/admin/change-window').send({
        cancelMinHours: 2,
        rescheduleMinHours: 2,
        maxReschedules: 2,
        dpoName: 'Matheus Cardoso',
        dpoEmail: 'dados@domari.com.br',
      }),
    ).expect(200);

    await com(dono)(
      http()
        .put(`/v1/admin/customers/${carlos}/consentimentos`)
        .send({ finalidade: 'marketing', concedido: true, versaoDoTexto: 'marketing-2026-08' }),
    ).expect(200);

    const dados = await com(dono)(http().get(`/v1/admin/customers/${carlos}/dados`)).expect(200);

    expect(dados.body.cadastro.nome).toBe('Carlos Souza');
    expect(dados.body.consentimentos).toHaveLength(1);
    expect(dados.body.barbearia.encarregado).toBe('Matheus Cardoso <dados@domari.com.br>');
    // Sessão é credencial, não dado pessoal: exportá-la entregaria um acesso
    // vivo num arquivo que sai por e-mail.
    expect(dados.body).not.toHaveProperty('sessoes');

    const trilha = await admin.$queryRawUnsafe<{ action: string }[]>(
      `SELECT action FROM audit_log WHERE entity_id = '${carlos}' AND action = 'customer.data_exported'`,
    );
    expect(trilha).toHaveLength(1);
  });

  it('e-mail de encarregado sem formato é recusado', async () => {
    const dono = await entrar(DONO);
    await com(dono)(
      http().put('/v1/admin/change-window').send({
        cancelMinHours: 2,
        rescheduleMinHours: 2,
        maxReschedules: 2,
        dpoName: 'Matheus',
        dpoEmail: 'nao-e-email',
      }),
    ).expect(400);
  });

  // -- isolamento ------------------------------------------------------------

  it('o cliente da vizinha não existe, e a resposta não confirma que existe', async () => {
    const dono = await entrar(DONO);
    const rita = await entrar(VIZINHA);
    const dela = await cliente(rita, 'Cliente da Vizinha');

    // Com o segundo fator provado, para que a recusa seja pelo tenant e não
    // pelo autenticador — senão o 403 do MFA mascararia o que se quer provar.
    await comSegundoFator(dono);

    // 404 e não 403: recusar por permissão confirmaria que o id é válido em
    // algum lugar, que é meia enumeração da base alheia.
    await com(dono)(http().get(`/v1/admin/customers/${dela}/dados`)).expect(404);
    await com(dono)(
      http()
        .put(`/v1/admin/customers/${dela}/consentimentos`)
        .send({ finalidade: 'marketing', concedido: true, versaoDoTexto: 'v1' }),
    ).expect(404);

    // E a leitura do consentimento alheio volta vazia, não com o dela.
    const lido = await com(dono)(
      http().get(`/v1/admin/customers/${dela}/consentimentos`),
    ).expect(200);
    expect(lido.body.historico).toEqual([]);
  });

  // -- pedido do titular -----------------------------------------------------

  it('o pedido nasce com prazo de 15 dias e some da fila quando é atendido', async () => {
    const dono = await entrar(DONO);
    const carlos = await cliente(dono);

    const aberto = await com(dono)(
      http().post(`/v1/admin/customers/${carlos}/lgpd/pedidos`).send({ tipo: 'export' }),
    ).expect(201);

    const dias = Math.round(
      (new Date(aberto.body.venceEm).getTime() - Date.now()) / 86_400_000,
    );
    expect(dias).toBe(15);

    const fila = await com(dono)(http().get('/v1/admin/customers/lgpd/pedidos')).expect(200);
    expect(fila.body.pedidos).toHaveLength(1);
    expect(fila.body.pedidos[0].estado).toBe('open');

    await com(dono)(
      http()
        .put(`/v1/admin/customers/lgpd/pedidos/${aberto.body.id}`)
        .send({ atendido: true, nota: 'Arquivo enviado por e-mail' }),
    ).expect(200);

    const depois = await com(dono)(http().get('/v1/admin/customers/lgpd/pedidos')).expect(200);
    expect(depois.body.pedidos[0].estado).toBe('done');

    // Encerrar duas vezes não reabre nem grava duas trilhas: a segunda não acha
    // pedido aberto.
    await com(dono)(
      http()
        .put(`/v1/admin/customers/lgpd/pedidos/${aberto.body.id}`)
        .send({ atendido: true, nota: 'de novo' }),
    ).expect(404);
  });

  it('recusar pedido sem motivo escrito é recusado', async () => {
    const dono = await entrar(DONO);
    const carlos = await cliente(dono);

    const aberto = await com(dono)(
      http().post(`/v1/admin/customers/${carlos}/lgpd/pedidos`).send({ tipo: 'deletion' }),
    ).expect(201);

    await com(dono)(
      http().put(`/v1/admin/customers/lgpd/pedidos/${aberto.body.id}`).send({ atendido: false }),
    ).expect(400);

    // Com motivo, passa — e o motivo fica gravado.
    await com(dono)(
      http()
        .put(`/v1/admin/customers/lgpd/pedidos/${aberto.body.id}`)
        .send({ atendido: false, nota: 'Guarda fiscal obrigatória de 5 anos' }),
    ).expect(200);

    const fila = await com(dono)(http().get('/v1/admin/customers/lgpd/pedidos')).expect(200);
    expect(fila.body.pedidos[0].estado).toBe('refused');
    expect(fila.body.pedidos[0].nota).toMatch(/guarda fiscal/i);
  });

  // -- exclusão (bloco 32) ---------------------------------------------------

  it('apagar o cadastro é permissão própria — não acompanha settings.manage', async () => {
    /**
     * `customers.anonymize` é a única permissão do produto que autoriza uma
     * operação sem volta. Ela não vai junto de `settings.manage` porque
     * responder pedido de LGPD e destruir a base são tarefas diferentes: o
     * gerente que responde e-mail não deveria poder apagar cliente.
     */
    const dono = await entrar(DONO);
    const carlos = await cliente(dono);

    await com(dono)(
      http()
        .put('/v1/admin/team/permissoes/manager')
        .send({ permissoes: ['settings.manage', 'customers.view', 'customers.edit'] }),
    ).expect(200);

    const gerente = await conta(dono, 'bruno@domari.com.br', 'manager');

    const negado = await com(gerente)(
      http().post(`/v1/admin/customers/${carlos}/anonimizar`).send({ motivo: 'pedido' }),
    ).expect(403);
    expect(negado.body.error.code).toBe('forbidden');

    // O cadastro continua inteiro.
    const [linha] = await admin.$queryRawUnsafe<{ phone_e164: string | null }[]>(
      `SELECT phone_e164 FROM customers WHERE id = '${carlos}'`,
    );
    expect(linha?.phone_e164).not.toBeNull();
  });

  it('apagar exige motivo escrito, e o motivo fica na trilha sem o nome', async () => {
    const dono = await entrar(DONO);
    const carlos = await cliente(dono);

    await com(dono)(
      http().post(`/v1/admin/customers/${carlos}/anonimizar`).send({ motivo: 'ok' }),
    ).expect(400);

    await com(dono)(
      http()
        .post(`/v1/admin/customers/${carlos}/anonimizar`)
        .send({ motivo: 'Pedido de exclusão por WhatsApp' }),
    ).expect(201);

    const trilha = await admin.$queryRawUnsafe<{ after: unknown }[]>(
      `SELECT after FROM audit_log WHERE action = 'customer.anonymized'`,
    );
    expect(trilha).toHaveLength(1);
    expect(JSON.stringify(trilha[0]?.after)).not.toContain('Carlos');
  });

  it('atender exclusão fecha o pedido aberto, e o cliente da vizinha não é alcançado', async () => {
    const dono = await entrar(DONO);
    const rita = await entrar(VIZINHA);
    const carlos = await cliente(dono);
    const dela = await cliente(rita, 'Cliente da Vizinha');

    await com(dono)(
      http().post(`/v1/admin/customers/${carlos}/lgpd/pedidos`).send({ tipo: 'deletion' }),
    ).expect(201);

    const feito = await com(dono)(
      http().post(`/v1/admin/customers/${carlos}/anonimizar`).send({ motivo: 'pedido do titular' }),
    ).expect(201);
    expect(feito.body.anonimizou).toBe(true);
    expect(feito.body.pedidosFechados).toBe(1);

    const fila = await com(dono)(http().get('/v1/admin/customers/lgpd/pedidos')).expect(200);
    expect(fila.body.pedidos[0].estado).toBe('done');

    // O cadastro da vizinha continua intacto: a função do banco filtra o tenant
    // dentro dela, e não depende da RLS para isso.
    const semEfeito = await com(dono)(
      http().post(`/v1/admin/customers/${dela}/anonimizar`).send({ motivo: 'tentativa' }),
    ).expect(201);
    expect(semEfeito.body.anonimizou).toBe(false);

    const [linha] = await admin.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM customers WHERE id = '${dela}'`,
    );
    expect(linha?.name).toBe('Cliente da Vizinha');
  });

  it('marcar um pedido de exclusão como atendido pela rota de encerrar é recusado', async () => {
    // Silenciar seria o pior resultado: o registro dizendo que a obrigação foi
    // cumprida enquanto o cadastro continua inteiro.
    const dono = await entrar(DONO);
    const carlos = await cliente(dono);

    const aberto = await com(dono)(
      http().post(`/v1/admin/customers/${carlos}/lgpd/pedidos`).send({ tipo: 'deletion' }),
    ).expect(201);

    const recusa = await com(dono)(
      http().put(`/v1/admin/customers/lgpd/pedidos/${aberto.body.id}`).send({ atendido: true }),
    ).expect(409);
    expect(recusa.body.error.code).toBe('exclusao_tem_caminho_proprio');

    const [linha] = await admin.$queryRawUnsafe<{ phone_e164: string | null }[]>(
      `SELECT phone_e164 FROM customers WHERE id = '${carlos}'`,
    );
    expect(linha?.phone_e164).not.toBeNull();
  });

  it('a fila de pedidos é de quem responde pela empresa, não do balcão', async () => {
    const dono = await entrar(DONO);
    const maria = await recepcionista(dono);

    // Declarar que uma obrigação legal foi cumprida é ato de quem responde pela
    // empresa. Registrar que o pedido chegou é cadastro, e a recepção faz.
    await com(maria)(http().get('/v1/admin/customers/lgpd/pedidos')).expect(403);
  });
});
