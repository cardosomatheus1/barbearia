import 'reflect-metadata';
import { BadRequestException, Controller, Get, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DomainError } from '../src/common/errors.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import type { LinhaDeLog } from '../src/common/log.js';

// O teste exercita a escrita real do interceptor, que o runner geral desliga.
vi.stubEnv('LOG_REQUISICOES', 'sim');
const { LogInterceptor } = await import('../src/common/log.interceptor.js');

@Controller('v1/b/:slug')
class RotasComCredencial {
  @Get('queue/:token') posicao() { return { ok: true }; }
  @Post('offer/:token/accept') aceitar() { throw new DomainError('oferta_encerrada', 409, 'Convite encerrado.'); }
  @Get('futura/:credencial') futura() { return { ok: true }; }
  @Get('invalida/:entrada') invalida() { throw new BadRequestException('Entrada inválida.'); }
}

let app: INestApplication;
beforeAll(async () => {
  const modulo = await Test.createTestingModule({ controllers: [RotasComCredencial] }).compile();
  app = modulo.createNestApplication({ logger: false });
  app.useGlobalInterceptors(new LogInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
});
afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); });

it.each([
  ['GET', 'queue', ':token', '', 200],
  ['POST', 'offer', ':token', '/accept', 409],
  ['GET', 'futura', ':credencial', '', 200],
  ['GET', 'invalida', ':entrada', '', 400],
] as const)('o log HTTP de %s %s omite parâmetros e conserva o resultado', async (metodo, rota, marcador, sufixo, status) => {
  const segredo = randomBytes(32).toString('base64url');
  const capturadas: string[] = [];
  const espiao = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    capturadas.push(String(chunk)); return true;
  });
  let resposta;
  try {
    const caminho = `/v1/b/barbearia-sintetica/${rota}/${segredo}${sufixo}?credencial=${segredo}`;
    const chamada = request(app.getHttpServer());
    resposta = await (metodo === 'POST' ? chamada.post(caminho) : chamada.get(caminho))
      .set('Authorization', `Bearer ${segredo}`).set('Referer', `https://example.invalid/${segredo}`);
  } finally { espiao.mockRestore(); }
  expect(resposta.status).toBe(status);
  const linhas = capturadas.flatMap(c => c.split('\n')).filter(c => c.startsWith('{'))
    .map(c => JSON.parse(c) as LinhaDeLog).filter(c => typeof c.requisicaoId === 'string');
  expect(linhas).toHaveLength(1);
  // Asserções booleanas: a prova de vazamento não imprime a própria credencial.
  expect(JSON.stringify(linhas).includes(segredo)).toBe(false);
  expect(linhas[0]!.rota === `/v1/b/:slug/${rota}/${marcador}${sufixo}`).toBe(true);
  expect(linhas[0]!.status).toBe(status);
  expect(linhas[0]!.metodo).toBe(metodo);
  expect(linhas[0]!.requisicaoId).toBe(resposta.headers['x-request-id']);
});
