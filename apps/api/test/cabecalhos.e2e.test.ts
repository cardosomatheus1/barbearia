import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CABECALHOS_DA_API } from '../src/common/cabecalhos.middleware.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';

/**
 * Os cabeçalhos de segurança, nas **três** saídas.
 *
 * O que este teste existe para provar não é "o cabeçalho está lá" — é que ele
 * está lá também quando a resposta não veio de um controller. Um interceptor
 * global cobriria só a primeira das três: rota que existe e responde. A recusa
 * da guarda sobe pelo filtro de exceção e o endereço inexistente nem chega ao
 * roteador, e as duas sairiam nuas.
 *
 * É a diferença entre middleware e interceptor escrita como teste, para que
 * trocar um pelo outro fique vermelho em vez de silencioso.
 */
describe('cabeçalhos de segurança da API', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const conferir = (cabecalhos: Record<string, string | undefined>, onde: string): void => {
    for (const [nome, valor] of Object.entries(CABECALHOS_DA_API)) {
      expect(cabecalhos[nome], `${nome} ausente em ${onde}`).toBe(valor);
    }
  };

  it('a resposta de uma rota que existe leva todos', async () => {
    // A sonda de vivo, que é a única rota 200 que não toca o banco.
    const resposta = await request(app.getHttpServer()).get('/health').expect(200);
    conferir(resposta.headers, 'resposta 200');
  });

  it('a recusa da guarda leva todos', async () => {
    // Sem `Authorization`: a `StaffGuard` recusa antes de qualquer ida ao banco,
    // e a resposta é montada pelo filtro de exceção — fora de todo controller.
    const resposta = await request(app.getHttpServer()).get('/v1/admin/state').expect(401);
    conferir(resposta.headers, 'recusa 401');
  });

  it('o endereço que não existe leva todos', async () => {
    const resposta = await request(app.getHttpServer()).get('/nao-existe-nada-aqui').expect(404);
    conferir(resposta.headers, '404 do roteador');
  });

  it('a política da API não abre exceção para script', () => {
    /**
     * A API devolve só JSON, e é o único lugar do produto onde a política pode
     * ser a mais fechada que existe. Uma exceção aqui — `'unsafe-inline'`, um
     * domínio liberado, `default-src *` — só entraria por engano, e o engano
     * seria invisível: nada quebra quando uma CSP afrouxa.
     */
    const csp = CABECALHOS_DA_API['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('*');
  });
});
