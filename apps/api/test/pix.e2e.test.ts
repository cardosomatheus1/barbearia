import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConsoleMessagingProvider, codigoDoPasso, passoAgora } from '@barbearia/identity';
import { assinarWebhook } from '@barbearia/platform';
import { CaixaController } from '../src/admin/caixa.controller.js';
import { MfaController } from '../src/admin/mfa.controller.js';
import { MeController, TeamController } from '../src/admin/team.controller.js';
import { OnboardingController, StaffAuthController } from '../src/admin/admin.controller.js';
import { StripeWebhookController } from '../src/plataforma/stripe-webhook.controller.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { MESSAGING_PROVIDER } from '../src/auth/messaging.token.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { guardarCorpoCru } from '../src/common/corpo-cru.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { throttlerConfig } from '../src/common/throttler.config.js';
import { limparBanco } from './limpar.js';

/**
 * O Pix da comanda pela HTTP (bloco 35).
 *
 * O que só se prova com a pilha de pé: que a rota de cobrar exige o segundo
 * fator como toda rota de dinheiro, que a chave de idempotência é **obrigatória**
 * nela, e que o webhook sem assinatura válida não fecha comanda nenhuma —
 * porque ele é a segunda rota do produto sem sessão e com efeito sobre dinheiro.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const SEGREDO = 'segredo-do-webhook-da-stripe';

let app: NestExpressApplication;
let admin: PrismaClient;
let tenants: TenantService;

const DONO = {
  name: 'Matheus Cardoso',
  email: 'dono@domari.com.br',
  password: 'senha-bem-comprida',
  phone: '(71) 98888-7777',
  businessName: 'Domari Barber Club',
};

const JORNADA = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 0,
  endMinute: 1439,
}));

describeIfDb('o Pix da comanda pela HTTP', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    process.env['MFA_SECRET_KEY'] = Buffer.alloc(32, 9).toString('base64');
    process.env['STRIPE_WEBHOOK_SECRET'] = SEGREDO;
    // `fake` **explícito**, e não a ausência da variável: a cobrança da comanda
    // só existe quando o modo foi escolhido, senão a barbearia que nunca
    // configurou adquirente veria um Pix de mentira na tela e o cliente iria
    // embora achando que pagou. O que se prova aqui é o caminho do produto, não
    // que a Stripe responde.
    process.env['PSP_MODO'] = 'fake';
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(throttlerConfig())],
      controllers: [
        StaffAuthController,
        OnboardingController,
        CaixaController,
        MfaController,
        TeamController,
        MeController,
        StripeWebhookController,
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
    app = moduleRef.createNestApplication<NestExpressApplication>();
    // O mesmo parser do `main.ts`: a assinatura é sobre os bytes que o provedor
    // assinou, e reserializar o objeto já analisado passaria aqui e falharia em
    // produção.
    app.useBodyParser('json', { verify: guardarCorpoCru });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
    delete process.env['STRIPE_WEBHOOK_SECRET'];
  });

  beforeEach(async () => {
    await limparBanco(admin, ['tenants', 'staff_directory']);
    tenants.forget('domari-barber-club');
  });

  const http = () => request(app.getHttpServer());
  const com = (token: string) => (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  async function abrirBarbearia(): Promise<string> {
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
      http().put('/v1/admin/services').send({
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

    /**
     * Estas suítes existem para provar o caminho **com** segundo fator, e desde
     * o bloco 37 ele nasce desligado. Ligar aqui é o que mantém as provas
     * falando do que dizem falar — sem isto elas passariam a verde por a
     * exigência não existir mais, que é o pior jeito de um teste continuar
     * verde.
     */
    await com(token)(http().put('/v1/admin/mfa/policy').send({ exigir: true })).expect(200);


    const inicio = await com(token)(http().post('/v1/admin/mfa/setup')).expect(201);
    const segredo: string = inicio.body.segredoBase32;
    const passo = passoAgora(new Date());
    await com(token)(
      http().post('/v1/admin/mfa/confirm').send({ codigo: codigoDoPasso(segredo, passo) }),
    ).expect(201);
    await com(token)(
      http().post('/v1/admin/mfa/verify').send({ codigo: codigoDoPasso(segredo, passo + 1) }),
    ).expect(201);

    return token;
  }

  async function comandaDe4900(token: string): Promise<string> {
    const aberta = await com(token)(http().post('/v1/admin/orders').send({})).expect(201);
    const id: string = aberta.body.id;
    await com(token)(
      http().post(`/v1/admin/orders/${id}/items`).send({
        tipo: 'service',
        descricao: 'Corte de cabelo',
        quantidade: 1,
        precoUnitarioCents: 4900,
      }),
    ).expect(201);
    return id;
  }

  const cobrar = (token: string, orderId: string, chave: string | null = 'toque-1') => {
    const req = http().post(`/v1/admin/orders/${orderId}/charges`).send({ meio: 'pix' });
    return com(token)(chave === null ? req : req.set('Idempotency-Key', chave));
  };

  /** Assina como a Stripe assina: `t=…,v1=…` sobre `${instante}.${corpo cru}`. */
  function comoAStripe(corpo: unknown, instante = Math.floor(Date.now() / 1000)) {
    const cru = JSON.stringify(corpo);
    return {
      cru,
      cabecalho: `t=${instante},v1=${assinarWebhook({ corpoCru: cru, segredo: SEGREDO, instante })}`,
    };
  }

  function eventoPago(tenantId: string, orderId: string, pagamentoId: string, eventoId = 'evt_1') {
    return {
      id: eventoId,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: pagamentoId,
          status: 'succeeded',
          metadata: { tenant_id: tenantId, order_id: orderId },
        },
      },
    };
  }

  /**
   * O id da barbearia, lido do banco.
   *
   * Não sai de nenhuma rota, e está certo assim: o tenant vem do token, e
   * devolvê-lo ao navegador daria a quem opera o balcão um identificador que
   * nenhuma tela precisa. Aqui ele serve para montar o evento como a Stripe o
   * devolveria, com o metadado que a emissão mandou.
   */
  async function tenantIdDo(nome: string): Promise<string> {
    const linhas = await admin.$queryRaw<{ id: string }[]>`
      SELECT id FROM tenants WHERE name = ${nome}
    `;
    const tenant = linhas[0];
    if (!tenant) throw new Error(`barbearia ${nome} não encontrada`);
    return tenant.id;
  }

  // -- a porta ---------------------------------------------------------------

  it('cobrar é rota de dinheiro: sem o segundo fator, recusa', async () => {
    /**
     * A exigência é **derivada** da permissão declarada (`cashier.open`), não
     * de um decorador que alguém precise lembrar de pôr. Emitir cobrança é
     * mover dinheiro de verdade.
     */
    await http().post('/v1/admin/signup').send(DONO).expect(202);
    const entrou = await http()
      .post('/v1/admin/login')
      .send({ email: DONO.email, password: DONO.password })
      .expect(201);

    // A barbearia precisa ter **ligado** a exigência: desde o bloco 37 ela
    // nasce desligada. Sem esta linha o teste continuaria verde por a regra não
    // valer mais — e o 404 que aparecia no lugar do 403 era a pista.
    await com(entrou.body.token)(
      http().put('/v1/admin/mfa/policy').send({ exigir: true }),
    ).expect(200);

    const recusa = await com(entrou.body.token)(
      http()
        .post('/v1/admin/orders/11111111-1111-1111-1111-111111111111/charges')
        .set('Idempotency-Key', 'pix-e2e-252')
        .set('Idempotency-Key', 'x')
        .send({ meio: 'pix' }),
    ).expect(403);
    expect(recusa.body.error.code).toBe('mfa_setup_required');
  });

  it('sem `Idempotency-Key` a cobrança é recusada', async () => {
    /**
     * A primeira rota do produto que a exige. O motivo é o efeito: cada toque a
     * mais seria um QR Code a mais para a mesma conta, e o cliente com dois
     * códigos na frente paga um deles ao acaso.
     */
    const token = await abrirBarbearia();
    const orderId = await comandaDe4900(token);

    const recusa = await cobrar(token, orderId, null).expect(400);
    expect(recusa.body.error.code).toBe('invalid_request');
  });

  it('meio desconhecido é recusado na borda', async () => {
    const token = await abrirBarbearia();
    const orderId = await comandaDe4900(token);

    await com(token)(
      http()
        .post(`/v1/admin/orders/${orderId}/charges`)
        .set('Idempotency-Key', 'pix-e2e-278')
        .set('Idempotency-Key', 'toque-1')
        .send({ meio: 'boleto' }),
    ).expect(400);
  });

  // -- o caminho feliz -------------------------------------------------------

  it('o QR Code sai na tela e o webhook fecha a comanda', async () => {
    const token = await abrirBarbearia();
    await com(token)(http().post('/v1/admin/cash/open').send({ openingCents: 20000 })).expect(201);
    const orderId = await comandaDe4900(token);
    const tenantId = await tenantIdDo(DONO.businessName);

    const cobranca = await cobrar(token, orderId).expect(201);
    expect(cobranca.body.estado).toBe('aguardando');
    expect(cobranca.body.valorCents).toBe(4900);
    expect(cobranca.body.pixCopiaECola).toBeTruthy();

    const { cru, cabecalho } = comoAStripe(
      eventoPago(tenantId, orderId, cobranca.body.pagamentoId),
    );
    const resposta = await http()
      .post('/v1/webhooks/stripe')
      .set('stripe-signature', cabecalho)
      .set('content-type', 'application/json')
      .send(cru)
      .expect(201);
    expect(resposta.body.desfecho).toBe('pago');

    const comanda = await com(token)(http().get(`/v1/admin/orders/${orderId}`)).expect(200);
    expect(comanda.body.status).toBe('paid');
  });

  it('o duplo toque devolve a mesma cobrança, e não dois QR Codes', async () => {
    const token = await abrirBarbearia();
    const orderId = await comandaDe4900(token);

    const primeira = await cobrar(token, orderId).expect(201);
    const segunda = await cobrar(token, orderId).expect(201);

    expect(segunda.body.id).toBe(primeira.body.id);
    const lista = await com(token)(http().get(`/v1/admin/orders/${orderId}/charges`)).expect(200);
    expect(lista.body.cobrancas).toHaveLength(1);
  });

  it('o balcão cancela o Pix e a comanda aceita outra cobrança', async () => {
    const token = await abrirBarbearia();
    const orderId = await comandaDe4900(token);
    const cobranca = await cobrar(token, orderId).expect(201);

    await com(token)(
      http().delete(`/v1/admin/orders/${orderId}/charges/${cobranca.body.id}`),
    ).expect(200);

    const lista = await com(token)(http().get(`/v1/admin/orders/${orderId}/charges`)).expect(200);
    expect(lista.body.cobrancas[0].estado).toBe('expirado');
  });

  // -- a porta do adquirente -------------------------------------------------

  it('webhook sem assinatura não fecha comanda', async () => {
    const token = await abrirBarbearia();
    await com(token)(http().post('/v1/admin/cash/open').send({ openingCents: 20000 })).expect(201);
    const orderId = await comandaDe4900(token);
    const tenantId = await tenantIdDo(DONO.businessName);
    const cobranca = await cobrar(token, orderId).expect(201);

    const corpo = eventoPago(tenantId, orderId, cobranca.body.pagamentoId);
    await http().post('/v1/webhooks/stripe').send(corpo).expect(400);
    await http()
      .post('/v1/webhooks/stripe')
      .set('stripe-signature', 't=1,v1=deadbeef')
      .send(corpo)
      .expect(400);

    const comanda = await com(token)(http().get(`/v1/admin/orders/${orderId}`)).expect(200);
    expect(comanda.body.status).toBe('open');
  });

  it('assinatura fora da janela é recusada', async () => {
    /**
     * Assinatura válida sem prazo é assinatura reaproveitável: quem capturasse
     * um evento antigo o reenviaria para sempre. A janela é de cinco minutos, e
     * a conta é a mesma do bloco 29.
     */
    const antigo = Math.floor(Date.now() / 1000) - 3600;
    const { cru, cabecalho } = comoAStripe(
      eventoPago(
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        'pi_1',
      ),
      antigo,
    );

    await http()
      .post('/v1/webhooks/stripe')
      .set('stripe-signature', cabecalho)
      .set('content-type', 'application/json')
      .send(cru)
      .expect(400);
  });

  it('evento assinado apontando para a barbearia errada não move nada', async () => {
    /**
     * Assinatura prova origem, não intenção. O metadado abre o tenant; quem
     * confirma é o id do pagamento, procurado **dentro** dele — e a cobrança de
     * outra barbearia é invisível ali, pela RLS.
     */
    const token = await abrirBarbearia();
    await com(token)(http().post('/v1/admin/cash/open').send({ openingCents: 20000 })).expect(201);
    const orderId = await comandaDe4900(token);
    const cobranca = await cobrar(token, orderId).expect(201);

    const outroTenant = '99999999-9999-9999-9999-999999999999';
    const { cru, cabecalho } = comoAStripe(
      eventoPago(outroTenant, orderId, cobranca.body.pagamentoId),
    );

    const resposta = await http()
      .post('/v1/webhooks/stripe')
      .set('stripe-signature', cabecalho)
      .set('content-type', 'application/json')
      .send(cru)
      .expect(201);
    expect(resposta.body.desfecho).toBe('ignorado');

    const comanda = await com(token)(http().get(`/v1/admin/orders/${orderId}`)).expect(200);
    expect(comanda.body.status).toBe('open');
  });

  it('reentrega assinada responde 2xx e não conta o pagamento de novo', async () => {
    /**
     * A Stripe reentrega tudo que não recebeu 2xx. Responder 404 para um evento
     * sobre comanda já paga faria ela repetir por horas o que já está certo, e
     * no fim marcar o endereço como quebrado.
     */
    const token = await abrirBarbearia();
    await com(token)(http().post('/v1/admin/cash/open').send({ openingCents: 20000 })).expect(201);
    const orderId = await comandaDe4900(token);
    const tenantId = await tenantIdDo(DONO.businessName);
    const cobranca = await cobrar(token, orderId).expect(201);

    const primeira = comoAStripe(eventoPago(tenantId, orderId, cobranca.body.pagamentoId));
    const enviar = (assinado: { cru: string; cabecalho: string }) =>
      http()
        .post('/v1/webhooks/stripe')
        .set('stripe-signature', assinado.cabecalho)
        .set('content-type', 'application/json')
        .send(assinado.cru);

    expect((await enviar(primeira).expect(201)).body.desfecho).toBe('pago');
    expect((await enviar(primeira).expect(201)).body.desfecho).toBe('ignorado');

    const comanda = await com(token)(http().get(`/v1/admin/orders/${orderId}`)).expect(200);
    expect(comanda.body.pagamentos).toHaveLength(1);
  });

  it('`payment_intent.created` não mata a cobrança nem consome a entrega', async () => {
    /**
     * O achado nº 2 da revisão. A versão anterior derivava o desfecho do
     * `status` do objeto, e `requires_payment_method` — o estado inicial normal
     * de um intent de cartão — traduzia para `recusado`. O evento mais
     * inofensivo do ciclo matava a cobrança segundos depois de ela nascer, e o
     * `succeeded` seguinte encontrava tudo encerrado e virava silêncio.
     *
     * O status vai `requires_payment_method` de propósito: era o único que a
     * versão antiga tratava errado, e o teste anterior mandava `requires_action`
     * — justamente o que a fazia parecer certa.
     */
    const token = await abrirBarbearia();
    await com(token)(http().post('/v1/admin/cash/open').send({ openingCents: 20000 })).expect(201);
    const orderId = await comandaDe4900(token);
    const tenantId = await tenantIdDo(DONO.businessName);
    const cobranca = await cobrar(token, orderId).expect(201);

    const criado = comoAStripe({
      id: 'evt_mesmo',
      type: 'payment_intent.created',
      data: {
        object: {
          id: cobranca.body.pagamentoId,
          status: 'requires_payment_method',
          metadata: { tenant_id: tenantId, order_id: orderId },
        },
      },
    });
    const enviar = (a: { cru: string; cabecalho: string }) =>
      http()
        .post('/v1/webhooks/stripe')
        .set('stripe-signature', a.cabecalho)
        .set('content-type', 'application/json')
        .send(a.cru);

    expect((await enviar(criado).expect(201)).body.desfecho).toBe('ignorado');

    // A cobrança continua viva: o `created` não a encerrou.
    const emCurso = await com(token)(http().get(`/v1/admin/orders/${orderId}/charges`)).expect(200);
    expect(emCurso.body.cobrancas[0].estado).toBe('aguardando');

    // E o evento de verdade, com o **mesmo id**, ainda fecha a venda.
    const pago = comoAStripe(
      eventoPago(tenantId, orderId, cobranca.body.pagamentoId, 'evt_mesmo'),
    );
    expect((await enviar(pago).expect(201)).body.desfecho).toBe('pago');
  });
});
