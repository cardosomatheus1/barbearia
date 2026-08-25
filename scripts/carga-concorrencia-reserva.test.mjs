import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const raiz = process.cwd();
const ID = '11111111-1111-4111-8111-111111111111';
const PRO = '22222222-2222-4222-8222-222222222222';
const LOC = '33333333-3333-4333-8333-333333333333';
const SERVICO = '44444444-4444-4444-8444-444444444444';
const INICIO = '2026-09-01T12:00:00.000Z';

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function servidorDaDisputa({ falharUma = false } = {}) {
  let winnerKey = null;
  let falhaUsada = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health/pronto') return json(res, 200, { status: 'ok' });
    if (url.pathname === '/v1/admin/login') return json(res, 200, { token: 'token' });
    if (url.pathname === '/v1/admin/templates') {
      return json(res, 200, { templates: [{ name: 'Corte', priceCents: 5000, durationMinutes: 30 }] });
    }
    if (url.pathname === '/v1/admin/state') return json(res, 200, { slug: 'carga' });
    if (url.pathname === '/v1/b/carga/availability') {
      return json(res, 200, { days: [{ slots: [{ start: '09:00' }] }] });
    }
    if (url.pathname === '/v1/b/carga') {
      return json(res, 200, {
        location: { id: LOC },
        categories: [{ services: [{ id: SERVICO, durationMinutes: 30 }] }],
        professionals: [{ id: PRO }],
      });
    }
    if (url.pathname === '/v1/admin/appointments') {
      const key = String(req.headers['idempotency-key'] ?? '');
      if (!winnerKey) winnerKey = key;
      if (key === winnerKey) {
        return json(res, 201, { id: ID, startsAt: INICIO, professionalId: PRO });
      }
      if (falharUma && !falhaUsada) {
        falhaUsada = true;
        return json(res, 500, { error: { code: 'internal_error', message: 'Erro interno' } });
      }
      return json(res, 409, { error: { code: 'slot_taken', message: 'Horário ocupado' } });
    }

    // As portas de preparação não precisam devolver campos para este contrato.
    if (['POST', 'PUT'].includes(req.method ?? '')) return json(res, 200, { ok: true });
    return json(res, 404, { error: { code: 'not_found' } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endereco = server.address();
  if (!endereco || typeof endereco === 'string') throw new Error('servidor sem porta');
  return { server, api: `http://127.0.0.1:${endereco.port}` };
}

function psqlFake() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barberdock-psql-fake-'));
  const arquivo = path.join(tmp, 'psql');
  fs.writeFileSync(arquivo, '#!/usr/bin/env sh\necho 1\n');
  fs.chmodSync(arquivo, 0o755);
  return tmp;
}

async function executar(opcoes) {
  const { server, api } = await servidorDaDisputa(opcoes);
  const bin = psqlFake();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/carga-concorrencia-reserva.mjs'], {
        cwd: raiz,
        env: {
          ...process.env,
          API_URL: api,
          DEMO_DATABASE_URL: 'postgres://teste.invalid/banco',
          CARGA_RESERVAS_SIMULTANEAS: '50',
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.once('error', reject);
      child.once('close', (status, signal) => {
        clearTimeout(timer);
        resolve({ status, signal, stdout, stderr });
      });
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

test('aceita exatamente um vencedor, 49 conflitos, replay e uma linha no banco', async () => {
  const resultado = await executar({});
  assert.equal(resultado.status, 0, `${resultado.stdout}\n${resultado.stderr}`);
  assert.match(resultado.stdout, /PASS — 1 criada, 49 recusadas com 409, 0 respostas 500/);
  assert.match(resultado.stdout, /banco confirmou 1 linha ativa; replay idempotente/);
});

test('recusa a medição se uma das respostas virar 500', async () => {
  const resultado = await executar({ falharUma: true });
  assert.notEqual(resultado.status, 0);
  assert.match(resultado.stderr, /1 resposta\(s\) inesperada\(s\)/);
});
