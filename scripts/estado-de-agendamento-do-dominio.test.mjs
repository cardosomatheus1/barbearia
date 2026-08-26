import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { falhasDoEstadoDeAgendamento } from './estado-de-agendamento-do-dominio.mjs';

const RAIZ = resolve(import.meta.dirname, '..');

test('o produto de hoje não escreve nenhum dos conjuntos à mão', () =>
  assert.deepEqual(falhasDoEstadoDeAgendamento(), []));

/** Copia só o que a guarda lê, e muta a cópia. */
function comMutacao(arquivo, de, para) {
  const dir = mkdtempSync(join(tmpdir(), 'estados-'));
  for (const pasta of ['packages/finance/src', 'packages/core/src', 'apps/web/src']) {
    cpSync(join(RAIZ, pasta), join(dir, pasta), { recursive: true });
  }
  const alvo = join(dir, arquivo);
  const antes = readFileSync(alvo, 'utf8');
  const depois = antes.replace(de, para);
  assert.notEqual(depois, antes, `fixture desatualizada: "${de}" não foi encontrado`);
  writeFileSync(alvo, depois);
  try {
    return falhasDoEstadoDeAgendamento(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('detecta o conjunto que ocupa a agenda reescrito numa consulta', () => {
  const falhas = comMutacao(
    'packages/finance/src/painel.ts',
    '= ANY(${[...ESTADOS_QUE_OCUPAM_A_AGENDA]}::appointment_status[])',
    "IN ('completed', 'in_progress', 'checked_in', 'waiting', 'confirmed', 'pending')",
  );
  assert.ok(falhas.some((f) => f.includes('ESTADOS_QUE_OCUPAM_A_AGENDA')), falhas.join('\n'));
});

test('detecta a união de estados soletrada de novo numa tela', () => {
  const falhas = comMutacao(
    'apps/web/src/lib/admin-api/operacao.ts',
    'export type StatusAtendimento = AppointmentStatus;',
    "export type StatusAtendimento =\n  | 'pending' | 'confirmed' | 'checked_in' | 'waiting' | 'in_progress';",
  );
  assert.ok(falhas.length > 0, 'a união reescrita passou');
});

/**
 * O outro lado, e é o que impede a guarda de virar aquela que alguém desliga:
 * conjunto **próprio** é decisão de domínio e não pode ser acusado. Quatro
 * consultas do produto têm um, cada uma respondendo outra pergunta.
 */
test('não acusa conjunto próprio, que é decisão de domínio', () => {
  const falhas = comMutacao(
    'packages/finance/src/painel.ts',
    "import { withTenant",
    "const NAO_CONTA = ['cancelled_customer', 'cancelled_business', 'rescheduled'];\nimport { withTenant",
  );
  assert.deepEqual(falhas, []);
});
