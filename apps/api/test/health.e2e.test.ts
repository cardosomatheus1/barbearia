import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthController, estadoDePronto } from '../src/common/health.controller.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { FORA_DO_LIMITE as FORA_DO_LIMITE_IMPORTADO } from '../src/common/throttler.config.js';

/**
 * As sondas do bloco 23.
 *
 * O teste que importa aqui não é "responde 200" — é que **as duas sondas
 * discordam quando devem**. Uma sonda de vivo que cai junto com o banco faz o
 * orquestrador matar a API no meio de um incidente de Postgres; uma sonda de
 * pronto que não olha o banco deixa a versão nova entrar no balanceador antes
 * de conseguir atender.
 */
describe('sondas de saúde', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Teto de uma requisição por minuto: se `@SkipThrottle` sumir do
      // controller, a segunda chamada vira 429 e o teste acusa. Sonda que o
      // balanceador chama de segundo em segundo não pode gastar cota.
      imports: [ThrottlerModule.forRoot([{ name: 'short', ttl: 60_000, limit: 1 }])],
      controllers: [HealthController],
      providers: [
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

  it('o vivo responde sem tocar no banco', async () => {
    const resposta = await request(app.getHttpServer()).get('/health');

    expect(resposta.status).toBe(200);
    expect(resposta.body.status).toBe('ok');
    // Se ele consultasse o banco, esta suíte — que não abre banco nenhum —
    // não passaria. É essa a prova de que ele sobrevive a uma queda de Postgres.
    expect(resposta.body).not.toHaveProperty('banco');
  });

  it('o vivo fica fora do limite de requisições', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await request(app.getHttpServer()).get('/health')).status);
    }

    expect(statuses).toEqual([200, 200, 200, 200]);
  });

  // `scripts/test.sh` levanta um Postgres descartável e exporta `DATABASE_URL`;
  // rodar este arquivo sozinho não tem banco. A asserção depende disso, então
  // ela declara a dependência em vez de fingir que não tem — um teste que muda
  // de resposta conforme quem o chamou é pior que um teste a menos.
  it.skipIf(!process.env['DATABASE_URL'])(
    'o pronto confirma que a conexão desta suíte não ignora RLS',
    async () => {
      // Com banco de verdade e o role da aplicação, a sonda vira prova de que
      // ele é NOBYPASSRLS — a garantia que separa uma barbearia da outra
      // (CLAUDE.md §2).
      const resposta = await request(app.getHttpServer()).get('/health/pronto');

      expect(resposta.status).toBe(200);
      expect(resposta.body).toMatchObject({ status: 'ok', banco: 'ok', rls: 'aplicada' });
    },
  );

  it('banco fora do ar vira degradado, sem matar o vivo', async () => {
    const caiu = await estadoDePronto(() => {
      throw new Error('conexão recusada em 127.0.0.1:5432 para o usuário barbearia_app');
    });

    expect(caiu).toMatchObject({ status: 'degradado', banco: 'inacessivel', rls: 'desconhecida' });
  });

  it('role que ignora RLS é degradado mesmo com o banco respondendo', async () => {
    // O caso que `main.ts` já recusa na partida — mas um `ALTER ROLE ...
    // BYPASSRLS` aplicado com o processo no ar não passa por lá. Se a sonda
    // não acusasse, o isolamento cairia sem ninguém saber.
    const semIsolamento = await estadoDePronto(async () => [{ bypass_rls: true }]);

    expect(semIsolamento).toMatchObject({ status: 'degradado', banco: 'ok', rls: 'ignorada' });
  });

  it('nenhuma sonda descreve a falha para quem perguntou', async () => {
    const caiu = await estadoDePronto(() => {
      throw new Error('ECONNREFUSED 127.0.0.1:5432 — password authentication failed for user "barbearia_app"');
    });
    const corpo = JSON.stringify(caiu);

    // Erro de conexão do Prisma traz host, porta, usuário e às vezes o
    // `DATABASE_URL` inteiro. Nada disso pode atravessar uma rota pública.
    for (const vazamento of ['postgres', 'prisma', 'ECONNREFUSED', 'password', '5432', 'barbearia_app']) {
      expect(corpo.toLowerCase()).not.toContain(vazamento.toLowerCase());
    }
  });
});

describe('a isenção do limite acompanha a configuração', () => {
  it('todo limitador configurado está no mapa de isenção', async () => {
    const { throttlerConfig, FORA_DO_LIMITE } = await import('../src/common/throttler.config.js');
    const configurados = throttlerConfig() as { name?: string }[];

    // A regressão que isto impede: alguém acrescenta um terceiro limitador na
    // configuração e a sonda passa a ser barrada por ele em silêncio — o
    // mesmo defeito de origem, com nome diferente.
    expect(configurados.map((t) => t.name).sort()).toEqual(Object.keys(FORA_DO_LIMITE).sort());
  });

  it('o mapa não é vazio', () => {
    // Um `{}` isentaria nada e todos os testes acima passariam a medir outra
    // coisa. `@SkipThrottle({})` é indistinguível de não ter decorador.
    expect(Object.keys(FORA_DO_LIMITE_IMPORTADO).length).toBeGreaterThan(0);
  });
});
