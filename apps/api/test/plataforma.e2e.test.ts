import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emailKey, hashPassword } from '@barbearia/identity';
import {
  confirmarCadastroDoSegundoFator,
  criarAdminDaPlataforma,
  iniciarCadastroDoSegundoFator,
} from '@barbearia/platform';
import { codigoDoPasso, passoAgora } from '@barbearia/identity';
import { BookingController } from '../src/booking/booking.controller.js';
import { SessoesController } from '../src/admin/sessoes.controller.js';
import { BoardController } from '../src/admin/board.controller.js';
import { FilaController } from '../src/admin/fila.controller.js';
import { FilaPublicaController } from '../src/booking/fila-publica.controller.js';
import { SuporteInterceptor } from '../src/admin/suporte.interceptor.js';
import { StaffAuthController } from '../src/admin/admin.controller.js';
import { MeController } from '../src/admin/team.controller.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { guardarCorpoCru } from '../src/common/corpo-cru.js';
import { WebhookDoPspController } from '../src/plataforma/webhook.controller.js';
import {
  aplicarRegua,
  assinarWebhook,
  FakePspProvider,
  PspCobrancaProvider,
  salvarMeioDePagamento,
} from '@barbearia/platform';
import { PlanoController } from '../src/admin/plano.controller.js';
import { StaffGuard } from '../src/admin/staff.guard.js';
import { PermissaoGuard } from '../src/admin/permissao.guard.js';
import {
  PlataformaAuthController,
  PlataformaController,
} from '../src/plataforma/plataforma.controller.js';
import { PlataformaGuard } from '../src/plataforma/plataforma.guard.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { TenantService } from '../src/tenant/tenant.service.js';
import { limparBanco } from './limpar.js';

/**
 * O bloqueio de conta pelo Super Admin, visto de fora.
 *
 * O teste de integração de `@barbearia/platform` prova que a coluna muda. O que
 * **este** arquivo prova é a outra metade, que é a que interessa: que a coluna
 * é lida. Uma marca de bloqueio que nenhuma porta consulta é exatamente o
 * defeito que a regra "campo que ninguém preenche é mentira" descreve, só que
 * pelo avesso — aqui o campo é preenchido e ninguém o lê.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const DOMARI = '24242424-1111-1111-1111-111111111111';
const VIZINHA = '24242424-2222-2222-2222-222222222222';
const LOCAL = 'a2424242-0000-0000-0000-000000000001';
const LOCAL_VIZINHA = 'a2424242-0000-0000-0000-000000000002';
const DONO = 'b2424242-0000-0000-0000-000000000001';
const EMAIL_DO_DONO = 'dono@domari.test';
const SERVICO = 'e2424242-0000-0000-0000-000000000001';
const TOKEN_DA_FILA = 'token-de-acompanhamento-do-bloco-26';
const SENHA = 'senha-do-dono-24';
const SENHA_DA_PLATAFORMA = 'senha-super-admin-24';

let app: NestExpressApplication;
let admin: PrismaClient;
let tenants: TenantService;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const s of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(s);
  }
}

const http = () => request(app.getHttpServer());

/**
 * O segredo do webhook, fixado pela suíte.
 *
 * Ele é lido de `process.env` pelo controller, como em produção — o teste
 * define a variável em vez de injetar o valor, porque o que precisa ser provado
 * é o caminho completo, incluindo "sem a variável, a rota recusa".
 */
const SEGREDO_DO_WEBHOOK = 'segredo-do-webhook-no-e2e';

/** O id do Super Admin, para as chamadas de domínio que exigem autor. */
async function adminDaPlataforma(): Promise<{ id: string }> {
  const linhas = await admin.$queryRaw<{ id: string }[]>`SELECT id FROM platform_admins LIMIT 1`;
  const linha = linhas[0];
  if (!linha) throw new Error('nenhum admin de plataforma no seed');
  return linha;
}

async function tokenDaPlataforma(): Promise<string> {
  const resposta = await http()
    .post('/v1/plataforma/login')
    .send({ email: 'super@plataforma.test', senha: SENHA_DA_PLATAFORMA })
    .expect(201);
  return resposta.body.token as string;
}

async function tokenDoDono(): Promise<string> {
  const resposta = await http()
    .post('/v1/admin/login')
    .send({ email: EMAIL_DO_DONO, password: SENHA })
    .expect(201);
  return resposta.body.token as string;
}

/**
 * Uma sessão de plataforma com o segundo fator já provado.
 *
 * O código é gerado do mesmo segredo que o cadastro devolveu — TOTP de verdade,
 * não um atalho. Mocar a conferência aqui seria mocar justamente a barreira que
 * separa "senha vazada" de "base de clientes de todas as barbearias".
 */
async function comSegundoFator(): Promise<string> {
  // Uma sessão, uma prova. Provar de novo na mesma janela de trinta segundos é
  // **recusado de propósito** — o TOTP não aceita reuso de passo —, e reabrir
  // sessão a cada teste tropeçaria nisso. Também é o que uma pessoa do suporte
  // faz: entra uma vez, confirma o código uma vez, trabalha trinta minutos.
  if (tokenProvado) return tokenProvado;

  const token = await tokenDaPlataforma();
  const estado = await http()
    .get('/v1/plataforma/mfa')
    .set('authorization', `Bearer ${token}`)
    .expect(200);

  if (!estado.body.ligado) {
    const cadastro = await http()
      .post('/v1/plataforma/mfa')
      .set('authorization', `Bearer ${token}`)
      .send({ email: 'super@plataforma.test' })
      .expect(201);
    segredoDoMfa = cadastro.body.segredoBase32 as string;

    await http()
      .post('/v1/plataforma/mfa/confirmar')
      .set('authorization', `Bearer ${token}`)
      .send({ codigo: codigoDoPasso(segredoDoMfa, passoAgora(new Date())) })
      .expect(201);
  }

  await http()
    .post('/v1/plataforma/mfa/provar')
    .set('authorization', `Bearer ${token}`)
    // Um passo à frente: o de agora já foi consumido na confirmação, e o TOTP
    // recusa reuso dentro da mesma janela de trinta segundos — de propósito.
    .send({ codigo: codigoDoPasso(segredoDoMfa, passoAgora(new Date()) + 1) })
    .expect(201);

  tokenProvado = token;
  return token;
}

let segredoDoMfa = '';
let tokenProvado = '';

/** A trilha da barbearia, relendo até a gravação assíncrona aparecer. */
async function esperarTrilha(
  acao: string,
): Promise<{ actor_name: string; after: unknown }[]> {
  for (let i = 0; i < 40; i++) {
    const linhas = await admin.$queryRawUnsafe<{ actor_name: string; after: unknown }[]>(
      `SELECT actor_name, after FROM audit_log WHERE action = '${acao}' ORDER BY id DESC`,
    );
    if (linhas.length > 0) return linhas;
    // Espera pela **condição**, não pelo relógio: um `sleep` fixo seria lento
    // quando dá certo e instável quando a máquina está sob carga.
    await new Promise((r) => setTimeout(r, 25));
  }
  return [];
}

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

describeIfDb('bloqueio de conta pela plataforma', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });

    // `platform_admins` e `platform_audit` não penduram em `tenants`, e é de
    // propósito (a trilha sobrevive à barbearia apagada). O preço é que elas
    // não saem no `TRUNCATE ... CASCADE` e precisam ser nomeadas aqui.
    await limparBanco(admin, ['tenants', 'platform_admins', 'platform_audit']);

    const pepper = process.env['STAFF_EMAIL_PEPPER'];
    if (!pepper) throw new Error('STAFF_EMAIL_PEPPER é obrigatória');
    const hash = await hashPassword(SENHA);

    await exec(admin, `
      INSERT INTO tenants (id, name) VALUES
        ('${DOMARI}', 'Domari Barber Club'),
        ('${VIZINHA}', 'Barbearia Vizinha');

      INSERT INTO tenant_slugs (slug, tenant_id, is_primary) VALUES
        ('domari24', '${DOMARI}', true),
        ('vizinha24', '${VIZINHA}', true);

      INSERT INTO locations (id, tenant_id, name, timezone, city, state) VALUES
        ('${LOCAL}', '${DOMARI}', 'Pituba', 'America/Bahia', 'Salvador', 'BA'),
        ('${LOCAL_VIZINHA}', '${VIZINHA}', 'Rio Vermelho', 'America/Bahia', 'Salvador', 'BA');

      INSERT INTO service_categories (id, tenant_id, name, position)
      VALUES ('d2424242-0000-0000-0000-000000000001', '${DOMARI}', 'Cabelo', 1);

      INSERT INTO services (id, tenant_id, category_id, name, price_cents, duration_minutes)
      VALUES ('${SERVICO}', '${DOMARI}', 'd2424242-0000-0000-0000-000000000001',
              'Corte', 4900, 30);

      INSERT INTO staff_users (id, tenant_id, name, email, phone_e164, password_hash, role)
      VALUES ('${DONO}', '${DOMARI}', 'Matheus', 'dono@domari.test', '+5571988880024',
              '${hash}', 'owner');

      INSERT INTO staff_directory (email_key, tenant_id, staff_user_id)
      VALUES ('${emailKey(EMAIL_DO_DONO, pepper)}', '${DOMARI}', '${DONO}');
    `);

    // Sem o padrão de fábrica, nem o dono consegue fazer nada — e o teste do
    // recurso desligado mediria a falta de permissão em vez do recurso.
    const { seedRolePermissions } = await import('@barbearia/identity');
    const { withTenant } = await import('@barbearia/db');
    for (const tenant of [DOMARI, VIZINHA]) {
      await withTenant(tenant, (tx) => seedRolePermissions(tx, tenant));
    }

    await criarAdminDaPlataforma({
      nome: 'Super',
      email: 'super@plataforma.test',
      senha: SENHA_DA_PLATAFORMA,
      // Explícito desde o bloco 33: conta nova nasce `viewer`, e a suíte
      // inteira exercita ações sobre a conta de barbearias.
      papel: 'operator',
    });

    // A conta de leitura, para provar que a separação vale de verdade.
    await criarAdminDaPlataforma({
      nome: 'Consulta',
      email: 'consulta@plataforma.test',
      senha: SENHA_DA_PLATAFORMA,
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [
        BookingController,
        StaffAuthController,
        MeController,
        PlanoController,
        WebhookDoPspController,
        BoardController,
        SessoesController,
        FilaController,
        FilaPublicaController,
        PlataformaAuthController,
        PlataformaController,
      ],
      providers: [
        TenantService,
        StaffGuard,
        PermissaoGuard,
        PlataformaGuard,
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        { provide: APP_INTERCEPTOR, useClass: SuporteInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    /**
     * O mesmo parser de `apps/api/src/main.ts`, e é por isso que ele foi
     * exportado de lá.
     *
     * A assinatura do webhook do adquirente é sobre os bytes recebidos. Um
     * teste que montasse a aplicação sem o `verify` provaria uma configuração
     * que não é a de produção — e o defeito apareceria no primeiro webhook de
     * verdade, que é o pior lugar para descobrir.
     */
    app.useBodyParser('json', { verify: guardarCorpoCru });
    process.env['PSP_WEBHOOK_SECRET'] = SEGREDO_DO_WEBHOOK;
    await app.init();
    tenants = app.get(TenantService);
  });

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
  });

  it('a porta da plataforma recusa quem não tem sessão', async () => {
    await http().get('/v1/plataforma/barbearias').expect(401);
    await http()
      .get('/v1/plataforma/barbearias')
      .set('authorization', 'Bearer inventado')
      .expect(401);
  });

  it('o token do gestor não abre o painel da plataforma', async () => {
    // O caminho que transformaria um dono de barbearia em administrador de
    // todas elas. As duas portas resolvem token contra tabelas diferentes e
    // não compartilham código — este teste é o que garante que continuam assim.
    const doDono = await tokenDoDono();
    await http()
      .get('/v1/plataforma/barbearias')
      .set('authorization', `Bearer ${doDono}`)
      .expect(401);
  });

  it('o token da plataforma não abre o painel de nenhuma barbearia', async () => {
    const daPlataforma = await tokenDaPlataforma();
    await http()
      .get('/v1/admin/me')
      .set('authorization', `Bearer ${daPlataforma}`)
      .expect(401);
  });

  it('lista as barbearias com plano e estado', async () => {
    const token = await tokenDaPlataforma();
    const resposta = await http()
      .get('/v1/plataforma/barbearias')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    const nomes = resposta.body.barbearias.map((b: { nome: string }) => b.nome);
    expect(nomes).toContain('Domari Barber Club');
    expect(nomes).toContain('Barbearia Vizinha');

    const domari = resposta.body.barbearias.find(
      (b: { tenantId: string }) => b.tenantId === DOMARI,
    );
    expect(domari.slug).toBe('domari24');
    expect(domari.bloqueada).toBe(false);
  });

  it('bloquear sem motivo é recusado na borda', async () => {
    const token = await tokenDaPlataforma();
    await http()
      .post(`/v1/plataforma/barbearias/${DOMARI}/bloqueio`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: '  ' })
      .expect(400);
  });

  it('tenant que não é uuid não chega ao banco', async () => {
    const token = await tokenDaPlataforma();
    await http()
      .post(`/v1/plataforma/barbearias/nao-e-uuid/bloqueio`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: 'qualquer' })
      .expect(400);
  });

  it('antes do bloqueio: a página pública responde e o dono entra', async () => {
    await http().get('/v1/b/domari24').expect(200);
    // A mesma consulta que o teste do bloqueio faz. Sem esta linha, o 404 de lá
    // poderia vir de qualquer outra coisa e o teste provaria nada.
    await http()
      .get(
        `/v1/b/domari24/availability?locationId=${LOCAL}&serviceIds=${SERVICO}&dateFrom=2030-01-06`,
      )
      .expect(200);
    const token = await tokenDoDono();
    await http().get('/v1/admin/me').set('authorization', `Bearer ${token}`).expect(200);
  });

  it('bloquear derruba a página pública, o login e a sessão já aberta', async () => {
    // A sessão é aberta **antes** do bloqueio de propósito: bloquear conta com
    // gente logada não pode esperar o token vencer, que são horas.
    const jaLogado = await tokenDoDono();
    const daPlataforma = await tokenDaPlataforma();

    await http()
      .post(`/v1/plataforma/barbearias/${DOMARI}/bloqueio`)
      .set('authorization', `Bearer ${daPlataforma}`)
      .send({ motivo: 'inadimplente há 60 dias' })
      .expect(201);

    const publica = await http().get('/v1/b/domari24').expect(404);
    // O visitante não fica sabendo por quê: a inadimplência do estabelecimento
    // não é assunto de quem só queria cortar o cabelo.
    expect(JSON.stringify(publica.body)).not.toContain('inadimplente');

    // A grade fecha junto. A consulta é montada válida de propósito: com
    // parâmetro faltando ela morre no schema com 400 e o teste passaria sem
    // nunca ter chegado à checagem de bloqueio.
    await http()
      .get(
        `/v1/b/domari24/availability?locationId=${LOCAL}&serviceIds=${SERVICO}&dateFrom=2030-01-06`,
      )
      .expect(404);

    const sessaoAntiga = await http()
      .get('/v1/admin/me')
      .set('authorization', `Bearer ${jaLogado}`)
      .expect(403);
    expect(sessaoAntiga.body.error.code).toBe('tenant_blocked');
    // O dono, ao contrário do visitante, precisa do motivo: é o que ele usa
    // para saber a quem ligar.
    expect(sessaoAntiga.body.error.message).toContain('inadimplente');

    const novoLogin = await http()
      .post('/v1/admin/login')
      .send({ email: EMAIL_DO_DONO, password: SENHA })
      .expect(403);
    expect(novoLogin.body.error.code).toBe('tenant_blocked');
  });

  it('e a senha errada continua sendo senha errada, não conta bloqueada', async () => {
    // Se o bloqueio fosse checado antes da senha, esta resposta diria
    // "bloqueada" — e a internet inteira poderia mapear quem está inadimplente
    // na plataforma chutando e-mails.
    const resposta = await http()
      .post('/v1/admin/login')
      .send({ email: EMAIL_DO_DONO, password: 'senha-errada-mesmo' })
      .expect(401);
    expect(resposta.body.error.code).toBe('invalid_credentials');
  });

  it('bloquear uma barbearia não derruba a vizinha', async () => {
    await http().get('/v1/b/vizinha24').expect(200);
  });

  it('bloquear de novo não é aceito — a data do primeiro bloqueio é o prazo', async () => {
    const token = await tokenDaPlataforma();
    const resposta = await http()
      .post(`/v1/plataforma/barbearias/${DOMARI}/bloqueio`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: 'outro motivo' })
      .expect(409);
    expect(resposta.body.error.code).toBe('not_blockable');
  });

  it('desbloquear devolve a página e o painel no mesmo instante', async () => {
    const token = await tokenDaPlataforma();
    await http()
      .delete(`/v1/plataforma/barbearias/${DOMARI}/bloqueio`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    // Sem invalidação de cache, isto só voltaria depois do TTL — e o teste
    // falharia aqui, que é onde ele precisa falhar.
    await http().get('/v1/b/domari24').expect(200);
    const doDono = await tokenDoDono();
    await http().get('/v1/admin/me').set('authorization', `Bearer ${doDono}`).expect(200);
  });

  it('trocar de plano fica na trilha, com quem fez e de onde para onde', async () => {
    const token = await tokenDaPlataforma();
    await http()
      .put(`/v1/plataforma/barbearias/${DOMARI}/plano`)
      .set('authorization', `Bearer ${token}`)
      .send({ planoCode: 'starter' })
      .expect(200);

    const trilha = await http()
      .get('/v1/plataforma/trilha')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    const troca = trilha.body.eventos.find(
      (e: { acao: string }) => e.acao === 'tenant.plan_changed',
    );
    expect(troca.tenantId).toBe(DOMARI);
    expect(troca.adminNome).toBe('Super');
    expect(troca.detalhe).toMatchObject({ de: 'pro', para: 'starter' });

    const acoes = trilha.body.eventos.map((e: { acao: string }) => e.acao);
    expect(acoes).toContain('tenant.blocked');
    expect(acoes).toContain('tenant.unblocked');

    // Devolve a barbearia ao plano padrão antes de sair. A partir do bloco 27 o
    // plano decide quais recursos existem, então um teste que baixa o plano e
    // não o restaura desliga a fila para todos os que vierem depois — e eles
    // falhariam por um motivo que não tem nada a ver com o que testam.
    await http()
      .put(`/v1/plataforma/barbearias/${DOMARI}/plano`)
      .set('authorization', `Bearer ${token}`)
      .send({ planoCode: 'pro' })
      .expect(200);

    // Devolve ao plano padrão: a partir do bloco 27 o plano decide quais
    // recursos a barbearia tem, e um teste que muda plano e não volta apaga a
    // fila para todos os testes seguintes deste arquivo. Estado compartilhado
    // entre casos é o que faz uma suíte falhar por ordem de execução.
    await http()
      .put(`/v1/plataforma/barbearias/${DOMARI}/plano`)
      .set('authorization', `Bearer ${token}`)
      .send({ planoCode: 'pro' })
      .expect(200);
  });

  it('plano inexistente é 404 e não muda nada', async () => {
    const token = await tokenDaPlataforma();
    await http()
      .put(`/v1/plataforma/barbearias/${DOMARI}/plano`)
      .set('authorization', `Bearer ${token}`)
      .send({ planoCode: 'ouro' })
      .expect(404);
  });

  // -- métricas (bloco 25) ---------------------------------------------------

  it('as métricas exigem sessão de plataforma como todo o resto', async () => {
    await http().get('/v1/plataforma/metricas').expect(401);
    await http().get('/v1/plataforma/saude').expect(401);
  });

  it('sem nenhum dia apurado, o painel responde zero em vez de quebrar', async () => {
    // É o estado do primeiro dia de operação **e** o do worker parado. A tela
    // tem os dois desenhados, então a API não pode explodir em nenhum.
    const token = await tokenDaPlataforma();
    const resposta = await http()
      .get('/v1/plataforma/metricas')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    expect(resposta.body.resumo.agendamentos).toBe(0);
    expect(resposta.body.resumo.ocupacaoEmPontos).toBe(0);
    expect(resposta.body.ate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('o MRR sai dos planos, e a lista traz uma linha por barbearia', async () => {
    const token = await tokenDaPlataforma();

    await http()
      .put(`/v1/plataforma/barbearias/${VIZINHA}/plano`)
      .set('authorization', `Bearer ${token}`)
      .send({ planoCode: 'business' })
      .expect(200);

    const metricas = await http()
      .get('/v1/plataforma/metricas')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    // A Domari está no 'pro' (9900); a vizinha acabou de entrar no 'business'
    // (24900).
    expect(metricas.body.resumo.mrrCents).toBe(34800);

    const saude = await http()
      .get('/v1/plataforma/saude')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    expect(saude.body.barbearias).toHaveLength(2);
    expect(saude.body.barbearias.every((b: { ultimoDia: null }) => b.ultimoDia === null)).toBe(true);
  });

  it('janela fora do permitido morre na borda, não no banco', async () => {
    const token = await tokenDaPlataforma();
    await http()
      .get('/v1/plataforma/metricas?dias=9999')
      .set('authorization', `Bearer ${token}`)
      .expect(400);
    await http()
      .get('/v1/plataforma/metricas?ate=ontem')
      .set('authorization', `Bearer ${token}`)
      .expect(400);
    // Formato certo e data que não existe. Sem a conferência, esta passa da
    // borda e estoura lá dentro na aritmética de data — 500 sobre entrada do
    // cliente, que é a definição de validação faltando.
    await http()
      .get('/v1/plataforma/metricas?ate=0000-00-00')
      .set('authorization', `Bearer ${token}`)
      .expect(400);
  });

  // -- recursos e suporte (bloco 26) -----------------------------------------

  it('recurso desligado tira a rota do ar e devolve 404, não 403', async () => {
    // 403 mandaria a recepção procurar o dono para liberar algo que o dono
    // também não tem. Para quem está do outro lado, recurso desligado não
    // existe.
    const daPlataforma = await tokenDaPlataforma();
    const doDono = await tokenDoDono();

    await http().get('/v1/admin/queue').set('authorization', `Bearer ${doDono}`).expect(200);

    await http()
      .put(`/v1/plataforma/barbearias/${DOMARI}/recursos`)
      .set('authorization', `Bearer ${daPlataforma}`)
      .send({ code: 'fila', ligado: false })
      .expect(200);

    const recusada = await http()
      .get('/v1/admin/queue')
      .set('authorization', `Bearer ${doDono}`)
      .expect(404);
    expect(recusada.body.error.code).toBe('feature_off');

    // E não vazou para a vizinha.
    const daVizinha = await http()
      .get(`/v1/plataforma/barbearias/${VIZINHA}/recursos`)
      .set('authorization', `Bearer ${daPlataforma}`)
      .expect(200);
    expect(
      daVizinha.body.recursos.find((r: { code: string }) => r.code === 'fila').ligado,
    ).toBe(true);

    await http()
      .put(`/v1/plataforma/barbearias/${DOMARI}/recursos`)
      .set('authorization', `Bearer ${daPlataforma}`)
      .send({ code: 'fila', ligado: true })
      .expect(200);
  });

  it('desligar a fila derruba também o link que o cliente já tem na mão', async () => {
    // A quebra que passou despercebida no ensaio de vermelho: a checagem existia
    // na rota pública e nada a provava. Desligar o recurso no balcão e deixar no
    // ar um link que mostra a posição de uma fila que ninguém mais move é pior
    // do que não ter fila.
    //
    // Um 404 sozinho não prova nada aqui — token inválido também dá 404, de
    // propósito. Por isso a entrada é real, e o teste mede a **diferença** entre
    // o recurso ligado e desligado com o mesmo link.
    const daPlataforma = await tokenDaPlataforma();
    await exec(admin, `
      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('c2424242-0000-0000-0000-000000000009', '${DOMARI}', 'Carlos', '+5571988880099');

      INSERT INTO queue_entries (tenant_id, location_id, customer_id, public_token_hash)
      VALUES ('${DOMARI}', '${LOCAL}', 'c2424242-0000-0000-0000-000000000009',
              '${createHash('sha256').update(TOKEN_DA_FILA).digest('hex')}');
    `);

    await http().get(`/v1/b/domari24/queue/${TOKEN_DA_FILA}`).expect(200);

    await http()
      .put(`/v1/plataforma/barbearias/${DOMARI}/recursos`)
      .set('authorization', `Bearer ${daPlataforma}`)
      .send({ code: 'fila', ligado: false })
      .expect(200);

    await http().get(`/v1/b/domari24/queue/${TOKEN_DA_FILA}`).expect(404);

    await http()
      .put(`/v1/plataforma/barbearias/${DOMARI}/recursos`)
      .set('authorization', `Bearer ${daPlataforma}`)
      .send({ code: 'fila', ligado: true })
      .expect(200);
  });

  it('recurso que o código não conhece morre na borda', async () => {
    const token = await tokenDaPlataforma();
    await http()
      .put(`/v1/plataforma/barbearias/${DOMARI}/recursos`)
      .set('authorization', `Bearer ${token}`)
      .send({ code: 'inventado', ligado: false })
      .expect(400);
  });

  it('entrar na conta de um cliente exige o segundo fator provado', async () => {
    // A capacidade mais grave do produto. Sem esta recusa, uma senha vazada da
    // plataforma abre a base de clientes de todas as barbearias.
    const token = await tokenDaPlataforma();
    const recusada = await http()
      .post(`/v1/plataforma/barbearias/${DOMARI}/suporte`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: 'chamado 4471' })
      .expect(403);
    expect(recusada.body.error.code).toBe('mfa_required');
  });

  it('e exige um motivo escrito, como o bloqueio', async () => {
    const token = await comSegundoFator();
    await http()
      .post(`/v1/plataforma/barbearias/${DOMARI}/suporte`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: ' ' })
      .expect(400);
  });

  it('a sessão de suporte lê a agenda e não escreve nada', async () => {
    const token = await comSegundoFator();
    const aberta = await http()
      .post(`/v1/plataforma/barbearias/${DOMARI}/suporte`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: 'chamado 4471: horário sumindo da grade' })
      .expect(201);

    const suporte = aberta.body.token as string;
    expect(aberta.body.barbearia).toBe('Domari Barber Club');

    // Lê.
    await http()
      .get('/v1/admin/day?date=2030-01-07')
      .set('authorization', `Bearer ${suporte}`)
      .expect(200);

    // Não escreve. `appointments.attend` é o que move um atendimento.
    const escrita = await http()
      .post(`/v1/admin/appointments/${DOMARI}/attendance`)
      .set('authorization', `Bearer ${suporte}`)
      .send({ action: 'check_in' })
      .expect(403);
    expect(escrita.body.error.code).toBe('support_read_only');
  });

  it('e não troca a senha do dono pela porta que não pede permissão', async () => {
    // `@Exige()` vazio é a fuga da guarda, e existe para o que a conta faz sobre
    // si mesma. `every` sobre lista vazia é verdadeiro: sem a cláusula
    // explícita, esta requisição trocaria a senha do dono da barbearia.
    const token = await comSegundoFator();
    const aberta = await http()
      .post(`/v1/plataforma/barbearias/${DOMARI}/suporte`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: 'chamado 4472' })
      .expect(201);

    const recusada = await http()
      .put('/v1/admin/me/password')
      .set('authorization', `Bearer ${aberta.body.token}`)
      .send({ currentPassword: SENHA, newPassword: 'senha-do-invasor-24' })
      .expect(403);
    expect(recusada.body.error.code).toBe('support_read_only');

    // E a senha continua sendo a do dono.
    await http()
      .post('/v1/admin/login')
      .send({ email: EMAIL_DO_DONO, password: SENHA })
      .expect(201);
  });

  it('o que o suporte acessou fica na trilha **da barbearia**', async () => {
    // A metade da SPEC que uma trilha só de plataforma não cumpre: "o tenant
    // deve poder consultar esse log".
    const token = await comSegundoFator();
    const aberta = await http()
      .post(`/v1/plataforma/barbearias/${DOMARI}/suporte`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: 'chamado 4473' })
      .expect(201);

    await http()
      .get('/v1/admin/day?date=2030-01-07')
      .set('authorization', `Bearer ${aberta.body.token}`)
      .expect(200);

    // O interceptador grava fora do caminho da resposta; a trilha aparece logo
    // depois, sem `sleep` — a consulta é a espera.
    const linhas = await esperarTrilha('support.accessed');
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas[0]?.actor_name).toContain('Super');
    // A rota entra genérica: gravar o id da ficha faria a trilha de auditoria
    // virar mais uma cópia de dado pessoal.
    expect(JSON.stringify(linhas[0]?.after)).not.toContain(DOMARI);

    const inicio = await esperarTrilha('support.started');
    expect(JSON.stringify(inicio[0]?.after)).toContain('chamado');
  });

  it('e o que o suporte digitou na busca **não** fica na trilha', async () => {
    // A /security-review encontrou o caminho: a busca de clientes é
    // `?q=<termo>`, e mascarar só UUID e sequência de seis dígitos deixa nome
    // próprio e telefone com grupos curtos passarem limpos — para dentro de uma
    // tabela append-only por REVOKE, que nem pedido de exclusão apaga.
    const token = await comSegundoFator();
    const aberta = await http()
      .post(`/v1/plataforma/barbearias/${DOMARI}/suporte`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: 'chamado 4475' })
      .expect(201);

    await http()
      .get('/v1/admin/customers?q=Maria%20da%20Silva')
      .set('authorization', `Bearer ${aberta.body.token}`);

    const linhas = await esperarTrilha('support.accessed');
    const trilha = JSON.stringify(linhas.map((l) => l.after));
    expect(trilha).not.toContain('Maria');
    expect(trilha).not.toContain('?');
  });

  it('conta bloqueada recusa o suporte na porta, não depois', async () => {
    // Sem esta recusa, o token sairia e nenhuma tela o aceitaria — a StaffGuard
    // barra toda rota de barbearia bloqueada. E a trilha do dono ganharia uma
    // linha dizendo que entraram na conta dele quando ninguém entrou.
    const token = await comSegundoFator();

    await http()
      .post(`/v1/plataforma/barbearias/${VIZINHA}/bloqueio`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: 'inadimplente para o teste do suporte' })
      .expect(201);

    const recusada = await http()
      .post(`/v1/plataforma/barbearias/${VIZINHA}/suporte`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: 'chamado 4474' })
      .expect(409);
    expect(recusada.body.error.code).toBe('tenant_blocked');

    await http()
      .delete(`/v1/plataforma/barbearias/${VIZINHA}/bloqueio`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('e a plataforma sabe quais sessões de suporte estão abertas', async () => {
    const token = await comSegundoFator();
    const lista = await http()
      .get('/v1/plataforma/suporte')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    expect(lista.body.suportes.length).toBeGreaterThan(0);
    expect(lista.body.suportes[0].barbearia).toBe('Domari Barber Club');
    expect(lista.body.suportes[0].motivo).toContain('chamado');
  });

  it('a plataforma encerra o suporte antes da hora, e o token morre na hora', async () => {
    // Sem esta rota, a única saída seria esperar os trinta minutos — e
    // `encerrarSuporte` seria uma função que ninguém chama, que é o defeito que
    // este projeto passou oito blocos com `blocks` para aprender.
    const token = await comSegundoFator();
    const aberta = await http()
      .post(`/v1/plataforma/barbearias/${DOMARI}/suporte`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: 'chamado 4476' })
      .expect(201);

    // Uma rota que a sessão de suporte de fato alcança — `/v1/admin/me` declara
    // `@Exige()` vazio e é recusada de propósito.
    await http()
      .get('/v1/admin/day?date=2030-01-07')
      .set('authorization', `Bearer ${aberta.body.token}`)
      .expect(200);

    await http()
      .delete(`/v1/plataforma/barbearias/${DOMARI}/suporte`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    await http()
      .get('/v1/admin/day?date=2030-01-07')
      .set('authorization', `Bearer ${aberta.body.token}`)
      .expect(401);

    // E o encerramento fica na trilha do dono, como a abertura.
    const fim = await esperarTrilha('support.ended');
    expect(fim.length).toBeGreaterThan(0);

    // Encerrar de novo não é silêncio.
    await http()
      .delete(`/v1/plataforma/barbearias/${DOMARI}/suporte`)
      .set('authorization', `Bearer ${token}`)
      .expect(409);
  });

  it('o dono expulsa o suporte sozinho, sem pedir para ninguém', async () => {
    /**
     * Era lacuna declarada desde o bloco 26 (bloco 33).
     *
     * A capacidade existia inteira — a plataforma abria, listava e encerrava, e
     * o dono via na trilha quem tinha entrado. O que faltava era a porta do
     * lado de quem é dono do dado: até aqui, ver alguém dentro da conta e não
     * concordar significava ligar para a plataforma e pedir que saíssem.
     */
    const daPlataforma = await comSegundoFator();
    const aberta = await http()
      .post(`/v1/plataforma/barbearias/${DOMARI}/suporte`)
      .set('authorization', `Bearer ${daPlataforma}`)
      .send({ motivo: 'chamado 8891' })
      .expect(201);

    const dono = await tokenDoDono();

    // O dono vê quem está na conta dele.
    const lista = await http()
      .get('/v1/admin/sessoes')
      .set('authorization', `Bearer ${dono}`)
      .expect(200);
    expect(lista.body.suporte).toHaveLength(1);
    expect(lista.body.suporte[0].motivo).toBe('chamado 8891');
    // E a própria sessão dele aparece marcada, para ele não encerrá-la por
    // engano achando que é de outro aparelho.
    expect(lista.body.sessoes.some((s: { atual: boolean }) => s.atual)).toBe(true);

    // E expulsa.
    const fora = await http()
      .delete('/v1/admin/sessoes/suporte/tudo')
      .set('authorization', `Bearer ${dono}`)
      .expect(200);
    expect(fora.body.encerradas).toBe(1);

    // O token do suporte morre na hora, como quando a plataforma encerra.
    await http()
      .get('/v1/admin/day?date=2030-01-07')
      .set('authorization', `Bearer ${aberta.body.token}`)
      .expect(401);

    // E some da lista do dono.
    const depois = await http()
      .get('/v1/admin/sessoes')
      .set('authorization', `Bearer ${dono}`)
      .expect(200);
    expect(depois.body.suporte).toEqual([]);

    // Sem suporte aberto, o botão responde que não há o que encerrar.
    await http()
      .delete('/v1/admin/sessoes/suporte/tudo')
      .set('authorization', `Bearer ${dono}`)
      .expect(404);
  });

  it('o dono encerra a sessão de outro aparelho, e não a do colega', async () => {
    /**
     * A outra lacuna que esta tela fecha — "encerrar sessão nos outros
     * aparelhos", sem bloco desde o 5.
     *
     * O `staff_user_id` no `WHERE` não é redundância com a RLS: a política
     * separa barbearias, não separa pessoas dentro de uma. Sem ele, o id de uma
     * sessão da colega derrubaria a sessão dela.
     */
    const primeiro = await tokenDoDono();
    const segundo = await tokenDoDono();

    const lista = await http()
      .get('/v1/admin/sessoes')
      .set('authorization', `Bearer ${segundo}`)
      .expect(200);
    expect(lista.body.sessoes.length).toBeGreaterThanOrEqual(2);

    const outra = lista.body.sessoes.find((s: { atual: boolean }) => !s.atual);
    expect(outra).toBeDefined();

    await http()
      .delete(`/v1/admin/sessoes/${outra.id}`)
      .set('authorization', `Bearer ${segundo}`)
      .expect(200);

    // O primeiro token morreu; o segundo continua.
    await http()
      .get('/v1/admin/day?date=2030-01-07')
      .set('authorization', `Bearer ${primeiro}`)
      .expect(401);
    await http()
      .get('/v1/admin/day?date=2030-01-07')
      .set('authorization', `Bearer ${segundo}`)
      .expect(200);

    // A do próprio pedido é recusada: "Sair" já faz isso, e encerrá-la aqui
    // devolveria um 401 que parece defeito.
    const atual = lista.body.sessoes.find((s: { atual: boolean }) => s.atual);
    const recusa = await http()
      .delete(`/v1/admin/sessoes/${atual.id}`)
      .set('authorization', `Bearer ${segundo}`)
      .expect(400);
    expect(recusa.body.error.code).toBe('sessao_atual');
  });

  // -- assinatura (bloco 27) -------------------------------------------------

  it('a barbearia nasce em teste, e o dono consegue ver o próprio plano', async () => {
    // A assinatura nasce no painel da plataforma. Ficar só lá seria o dado que
    // é cobrado e que a pessoa de quem se cobra não consegue conferir.
    const daPlataforma = await tokenDaPlataforma();
    const assinatura = await http()
      .get(`/v1/plataforma/barbearias/${DOMARI}/assinatura`)
      .set('authorization', `Bearer ${daPlataforma}`)
      .expect(200);

    expect(assinatura.body).toMatchObject({ planoCode: 'pro', estado: 'trialing' });
    expect(assinatura.body.testeAte).toEqual(expect.any(String));

    const doDono = await tokenDoDono();
    const plano = await http()
      .get('/v1/admin/plano')
      .set('authorization', `Bearer ${doDono}`)
      .expect(200);

    expect(plano.body.plano).toMatchObject({ code: 'pro', precoCents: 9900 });
    expect(plano.body.cadeiras).toEqual({ emUso: 0, teto: 5 });
    // A tela precisa distinguir o que vem no plano do que é cortesia.
    expect(plano.body.recursos.every((r: { noPlano: boolean }) => r.noPlano)).toBe(true);
  });

  it('cancelar a assinatura não tira a barbearia do ar', async () => {
    // Cortar no dia do pedido é cobrar por um mês e entregar meio.
    const token = await tokenDaPlataforma();
    await http()
      .post(`/v1/plataforma/barbearias/${VIZINHA}/cancelamento`)
      .set('authorization', `Bearer ${token}`)
      .send({ motivo: 'fechou as portas' })
      .expect(201);

    await http().get('/v1/b/vizinha24').expect(200);

    const depois = await http()
      .get(`/v1/plataforma/barbearias/${VIZINHA}/assinatura`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(depois.body.estado).toBe('canceled');

    await http()
      .delete(`/v1/plataforma/barbearias/${VIZINHA}/cancelamento`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
  });

  // -- cobrança (bloco 28) ---------------------------------------------------

  it('o dono troca de plano e paga só o que falta do período', async () => {
    const doDono = await tokenDoDono();

    const opcoes = await http()
      .get('/v1/admin/plano/opcoes')
      .set('authorization', `Bearer ${doDono}`)
      .expect(200);

    // O Enterprise não é oferecido por autoatendimento: quem chega nele veio de
    // uma conversa, e um botão o colocaria num plano sem preço.
    expect(opcoes.body.map((o: { code: string }) => o.code)).toEqual([
      'starter',
      'pro',
      'business',
    ]);
    const business = opcoes.body.find((o: { code: string }) => o.code === 'business');
    expect(business.atual).toBe(false);
    expect(business.cobrarCents).toBeGreaterThan(0);
    expect(business.cobrarCents).toBeLessThan(24900);

    const trocada = await http()
      .post('/v1/admin/plano')
      .set('authorization', `Bearer ${doDono}`)
      .set('idempotency-key', 'troca-1')
      .send({ planoCode: 'business' })
      .expect(201);

    expect(trocada.body.cobrarCents).toBe(business.cobrarCents);
    expect(trocada.body.faturaId).toEqual(expect.any(String));

    const extrato = await http()
      .get('/v1/admin/plano/faturas')
      .set('authorization', `Bearer ${doDono}`)
      .expect(200);
    expect(extrato.body).toHaveLength(1);
    expect(extrato.body[0]).toMatchObject({
      tipo: 'proration',
      estado: 'open',
      valorCents: business.cobrarCents,
    });

    // O mesmo POST de novo devolve o mesmo acerto e **não** emite a segunda
    // cobrança. Sem a chave, o duplo toque cobraria duas vezes pela mesma troca.
    const repetida = await http()
      .post('/v1/admin/plano')
      .set('authorization', `Bearer ${doDono}`)
      .set('idempotency-key', 'troca-1')
      .send({ planoCode: 'business' })
      .expect(201);
    expect(repetida.body.faturaId).toBe(trocada.body.faturaId);

    const depois = await http()
      .get('/v1/admin/plano/faturas')
      .set('authorization', `Bearer ${doDono}`)
      .expect(200);
    expect(depois.body).toHaveLength(1);
  });

  it('o Super Admin registra o pagamento e a fatura sai da fila', async () => {
    const token = await tokenDaPlataforma();

    const fila = await http()
      .get('/v1/plataforma/faturas')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    const minha = fila.body.faturas.find(
      (f: { tenantId: string }) => f.tenantId === DOMARI,
    );
    expect(minha).toBeDefined();

    await http()
      .post(`/v1/plataforma/faturas/${minha.id}/pagamento`)
      .set('authorization', `Bearer ${token}`)
      .send({ metodo: 'manual' })
      .expect(201);

    // Encerrada não se paga de novo: a segunda baixa seria dinheiro contado
    // duas vezes no relatório da plataforma.
    await http()
      .post(`/v1/plataforma/faturas/${minha.id}/pagamento`)
      .set('authorization', `Bearer ${token}`)
      .send({ metodo: 'manual' })
      .expect(409);

    const doDono = await tokenDoDono();
    const extrato = await http()
      .get('/v1/admin/plano/faturas')
      .set('authorization', `Bearer ${doDono}`)
      .expect(200);
    expect(extrato.body[0]).toMatchObject({ estado: 'paid' });
  });

  it('a barbearia não enxerga o extrato da vizinha', async () => {
    // A RLS de `invoices` é mais estrita que a de `subscriptions`: aqui há
    // histórico de pagamento, e extrato é informação de negócio de quem o
    // recebeu. O caminho de leitura do dono não tem por onde pedir outro tenant,
    // e é isso que este teste fixa — a rota é do próprio, sempre.
    const doDono = await tokenDoDono();
    const extrato = await http()
      .get('/v1/admin/plano/faturas')
      .set('authorization', `Bearer ${doDono}`)
      .expect(200);

    const token = await tokenDaPlataforma();
    const daVizinha = await http()
      .get(`/v1/plataforma/barbearias/${VIZINHA}/faturas`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    const meus = new Set(extrato.body.map((f: { id: string }) => f.id));
    expect(daVizinha.body.faturas.some((f: { id: string }) => meus.has(f.id))).toBe(false);
  });

  it('descer para um plano menor que a equipe é recusado com o que fazer', async () => {
    const token = await tokenDaPlataforma();
    const recusada = await http()
      .put(`/v1/plataforma/barbearias/${DOMARI}/plano`)
      .set('authorization', `Bearer ${token}`)
      .send({ planoCode: 'starter' })
      .expect(200);
    expect(recusada.body.ok).toBe(true);

    // Sobe para business, ocupa seis cadeiras e tenta voltar ao pro.
    await http()
      .put(`/v1/plataforma/barbearias/${DOMARI}/plano`)
      .set('authorization', `Bearer ${token}`)
      .send({ planoCode: 'business' })
      .expect(200);

    await exec(admin, `
      INSERT INTO professionals (tenant_id, location_id, name, kind)
      SELECT '${DOMARI}', '${LOCAL}', 'Cadeira ' || n, 'professional'
      FROM generate_series(1, 6) AS n
    `);

    const erro = await http()
      .put(`/v1/plataforma/barbearias/${DOMARI}/plano`)
      .set('authorization', `Bearer ${token}`)
      .send({ planoCode: 'pro' })
      .expect(409);
    expect(erro.body.error.code).toBe('chairs_exceed_plan');
    expect(erro.body.error.message).toMatch(/desligue/i);
  });

  // -- adquirente (bloco 29) -------------------------------------------------

  it('o webhook recusa sem assinatura, com assinatura de outro segredo e fora da janela', async () => {
    const corpo = { id: 'evt_e2e_1', type: 'charge.paid', chargeId: 'ch_e2e_1', data: {} };
    const cru = JSON.stringify(corpo);
    const agora = Math.floor(Date.now() / 1000);

    await http().post('/v1/webhooks/psp').send(corpo).expect(400);

    await http()
      .post('/v1/webhooks/psp')
      .set('x-psp-signature', `t=${agora},v1=${assinarWebhook({ corpoCru: cru, segredo: 'outro', instante: agora })}`)
      .send(corpo)
      .expect(400);

    const velho = agora - 3600;
    await http()
      .post('/v1/webhooks/psp')
      .set(
        'x-psp-signature',
        `t=${velho},v1=${assinarWebhook({ corpoCru: cru, segredo: SEGREDO_DO_WEBHOOK, instante: velho })}`,
      )
      .send(corpo)
      .expect(400);
  });

  it('o webhook assinado quita a fatura, e a reentrega não quita de novo', async () => {
    // A cobrança nasce pendente pelo adquirente de mentira, exatamente como um
    // Pix nasce: o dinheiro chega depois, e é o webhook que conta.
    const psp = new FakePspProvider();
    psp.proximoEstado = 'pendente';
    const provider = new PspCobrancaProvider(psp);
    const base = new Date('2026-06-01T12:00:00Z');
    const emDias = (n: number) => new Date(base.getTime() + n * 86_400_000);

    await exec(admin, `
      UPDATE subscriptions
         SET period_start = '2026-05-18T12:00:00Z', period_end = '${base.toISOString()}'
       WHERE tenant_id = '${DOMARI}'
    `);
    await salvarMeioDePagamento({
      adminId: (await adminDaPlataforma()).id,
      tenantId: DOMARI,
      pspCustomerId: 'cus_e2e',
      pspMethodId: 'pm_e2e',
      bandeira: 'visa',
      final: '4242',
    });

    await aplicarRegua({ agora: emDias(-3), provider });
    await aplicarRegua({ agora: emDias(5), provider });
    await aplicarRegua({ agora: emDias(6), provider });

    const emitida = psp.cobrancas.length;
    expect(emitida).toBe(1);
    const chargeId = 'ch_fake_1';

    const corpo = { id: 'evt_e2e_pago', type: 'charge.paid', chargeId, data: {} };
    const cru = JSON.stringify(corpo);
    const agora = Math.floor(Date.now() / 1000);
    const cabecalho = `t=${agora},v1=${assinarWebhook({ corpoCru: cru, segredo: SEGREDO_DO_WEBHOOK, instante: agora })}`;

    const primeira = await http()
      .post('/v1/webhooks/psp')
      .set('x-psp-signature', cabecalho)
      .send(corpo)
      .expect(201);
    expect(primeira.body.desfecho).toBe('paid');

    // O adquirente reentrega o que não recebeu 2xx, e reentrega o que recebeu
    // também. A segunda vez responde 2xx e não move nada.
    const segunda = await http()
      .post('/v1/webhooks/psp')
      .set('x-psp-signature', cabecalho)
      .send(corpo)
      .expect(201);
    expect(segunda.body.desfecho).toBe('ignored');

    // A suíte é sequencial e a barbearia já tem histórico de testes anteriores;
    // o que importa é que **esta** cobrança virou uma baixa, e uma só.
    const baixas = await admin.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM invoices
       WHERE psp_charge_id = ${chargeId} AND status = 'paid'
    `;
    expect(Number(baixas[0]?.n)).toBe(1);

    const eventos = await admin.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM psp_events WHERE event_id = 'evt_e2e_pago'
    `;
    expect(Number(eventos[0]?.n)).toBe(1);
  });

  // -- papéis dentro da plataforma (bloco 33) ---------------------------------

  it('a conta de consulta lê tudo e não age sobre a conta de ninguém', async () => {
    /**
     * Era lacuna declarada desde o bloco 26. Havia **uma** conta, com todas as
     * capacidades, e a lacuna dizia por que esperar: inventar papéis antes de
     * existir a segunda pessoa criaria permissão que nenhuma conta distingue.
     *
     * O que mudou é que agora existe o que separar. Depois dos blocos 28 e 29,
     * uma conta de plataforma bloqueia barbearia, liga recurso, entra na conta
     * do cliente por suporte assistido e cancela cobrança.
     */
    const consulta = await http()
      .post('/v1/plataforma/login')
      .send({ email: 'consulta@plataforma.test', senha: SENHA_DA_PLATAFORMA })
      .expect(201);
    const token: string = consulta.body.token;

    // Lê tudo, como antes.
    const como = (req: request.Test) => req.set('authorization', `Bearer ${token}`);

    await como(http().get('/v1/plataforma/barbearias')).expect(200);
    await como(http().get('/v1/plataforma/metricas')).expect(200);
    await como(http().get('/v1/plataforma/trilha')).expect(200);

    // E não age.
    const negado = await como(
      http()
        .post(`/v1/plataforma/barbearias/${DOMARI}/bloqueio`)
        .send({ motivo: 'tentativa de quem não deveria poder' }),
    ).expect(403);
    expect(negado.body.error.code).toBe('forbidden');

    await como(
      http()
        .post(`/v1/plataforma/barbearias/${DOMARI}/suporte`)
        .send({ motivo: 'entrar na conta do cliente sem ser operador' }),
    ).expect(403);

    // A barbearia continua no ar: nada do que ela tentou aconteceu.
    const estado = await admin.$queryRaw<{ blocked_at: Date | null }[]>`
      SELECT blocked_at FROM tenant_platform WHERE tenant_id = ${DOMARI}::uuid
    `;
    expect(estado[0]?.blocked_at).toBeNull();
  });

  it('o segundo fator da própria conta não exige ser operador', async () => {
    // Exigir `operator` no autenticador **dele** trancaria a conta de leitura
    // fora do próprio segundo fator, que é o oposto de endurecer.
    const consulta = await http()
      .post('/v1/plataforma/login')
      .send({ email: 'consulta@plataforma.test', senha: SENHA_DA_PLATAFORMA })
      .expect(201);

    // A chave do segundo fator falha alto quando ausente, de propósito
    // (CLAUDE.md §2). Sem ela a rota devolveria 500 e o teste passaria a medir
    // a falta da variável em vez do papel.
    process.env['MFA_SECRET_KEY'] = Buffer.alloc(32, 3).toString('base64');

    await http()
      .post('/v1/plataforma/mfa')
      .set('authorization', `Bearer ${consulta.body.token}`)
      .expect(201);
  });

  it('sair invalida o token da plataforma', async () => {
    const token = await tokenDaPlataforma();
    await http().post('/v1/plataforma/logout').set('authorization', `Bearer ${token}`).expect(201);
    await http()
      .get('/v1/plataforma/barbearias')
      .set('authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('o TTL é o teto de quanto tempo um bloqueio demora a valer em outra instância', async () => {
    // A invalidação de cache só alcança o processo que bloqueou. Este teste
    // simula a **outra** instância: cache quente, nenhuma invalidação, e o
    // relógio andando além do TTL. É o comportamento que o comentário em
    // `TenantService` promete, e sem ele a promessa seria só um texto.
    const daPlataforma = await tokenDaPlataforma();
    const base = Date.now();
    tenants.now = () => base;

    await http().get('/v1/b/vizinha24').expect(200);

    await exec(admin, `
      UPDATE tenant_platform SET blocked_at = now(), blocked_reason = 'direto no banco'
       WHERE tenant_id = '${VIZINHA}';
    `);

    // Cache quente: ainda atende, e é essa a janela declarada.
    await http().get('/v1/b/vizinha24').expect(200);

    tenants.now = () => base + 31_000;
    await http().get('/v1/b/vizinha24').expect(404);

    tenants.now = () => Date.now();
    await http()
      .delete(`/v1/plataforma/barbearias/${VIZINHA}/bloqueio`)
      .set('authorization', `Bearer ${daPlataforma}`)
      .expect(200);
  });
});
