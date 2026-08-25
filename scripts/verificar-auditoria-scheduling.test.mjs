import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const raiz = process.cwd();
const arquivos = [
  'packages/scheduling/src/booking.ts',
  'packages/scheduling/src/booking-idempotencia.ts',
  'packages/scheduling/src/repository.ts',
  'packages/scheduling/src/service.ts',
  'packages/scheduling/src/espera.ts',
  'packages/scheduling/src/oferta.ts',
  'packages/scheduling/src/fila.ts',
  'packages/scheduling/src/agenda.ts',
  'packages/scheduling/src/dayboard.ts',
  'packages/scheduling/src/concorrencia.ts',
  'packages/scheduling/src/booking-contratos.ts',
  'packages/db/migrations/0110_scheduling_concorrencia_recursos.sql',
  'packages/db/prisma/schema.prisma',
  'apps/api/src/auth/auth.schemas.ts',
  'apps/api/src/booking/appointments.controller.ts',
  'scripts/verificar-auditoria-scheduling.mjs',
];

function mutacao(rel, de, para) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barberdock-scheduling-'));
  for (const arq of arquivos) {
    const dst = path.join(tmp, arq);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(raiz, arq), dst);
  }
  const alvo = path.join(tmp, rel);
  const antes = fs.readFileSync(alvo, 'utf8');
  assert.ok(antes.includes(de), `fixture não contém mutação: ${de.slice(0, 50)}`);
  fs.writeFileSync(alvo, antes.replaceAll(de, para));
  const r = spawnSync(process.execPath, ['scripts/verificar-auditoria-scheduling.mjs'], {
    cwd: tmp, encoding: 'utf8',
  });
  assert.notEqual(r.status, 0, `guarda aceitou regressão em ${rel}`);
}

test('detecta remoção da trava diária', () =>
  mutacao('packages/scheduling/src/concorrencia.ts', 'pg_advisory_xact_lock', 'pg_advisory_xact_unlock'));
test('detecta remoção do fingerprint', () =>
  mutacao('packages/scheduling/src/booking-idempotencia.ts', 'fingerprintDaIntencao', 'fingerprint_removido'));
test('detecta hold sem recursos', () =>
  mutacao('packages/db/migrations/0110_scheduling_concorrencia_recursos.sql', 'CREATE TABLE slot_hold_resources', 'CREATE TABLE hold_resources_removido'));
test('detecta quantity ignorada', () =>
  mutacao('packages/scheduling/src/repository.ts', 'generate_series(1, ar.quantity)', 'generate_series(1, 1)'));
test('detecta walk-in sem recursos', () =>
  mutacao('packages/scheduling/src/fila.ts', 'INSERT INTO appointment_resources', 'INSERT INTO recurso_removido'));
test('detecta fila pública aceitando item offline', () =>
  mutacao('packages/scheduling/src/espera.ts', 'AND bookable_online', 'AND true'));
test('detecta remarcação sem lock da linha', () =>
  mutacao('packages/scheduling/src/booking.ts', 'FOR UPDATE OF a', ''));
test('detecta espera sem serialização por cliente', () =>
  mutacao('packages/scheduling/src/espera.ts', 'barberdock:espera:', 'barberdock:espera-removida:'));

test('detecta API pública reexpondo holdId', () =>
  mutacao('apps/api/src/auth/auth.schemas.ts', "  start: z.string().regex(/^([01]\\d|2[0-3]):[0-5]\\d$/),", "  start: z.string().regex(/^([01]\\d|2[0-3]):[0-5]\\d$/),\n  holdId: z.string().uuid().optional(),"));
test('detecta consumo de hold sem trava/validação', () =>
  mutacao('packages/scheduling/src/booking.ts', 'FOR UPDATE OF h', ''));

test('detecta desfazer falta sem revalidar recurso', () =>
  mutacao('packages/scheduling/src/dayboard.ts', 'recursosAindaCabemAoDesfazerFalta', 'recursos_sem_revalidacao'));
