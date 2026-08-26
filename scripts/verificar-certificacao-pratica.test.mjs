import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const raiz = process.cwd();
const arquivos = [
  'scripts/medicao.sh',
  'scripts/carga-concorrencia-reserva.mjs',
  '.github/workflows/portao.yml',
  'docs/go-live.md',
  'docs/deploy.md',
  'ROADMAP.md',
  'package.json',
  'scripts/verify.sh',
  'scripts/verificar-certificacao-pratica.mjs',
  ...fs.readdirSync(path.join(raiz, 'packages/db/migrations'))
    .filter((nome) => /^\d{4}_.+\.sql$/.test(nome))
    .map((nome) => `packages/db/migrations/${nome}`),
];

function preparar() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barberdock-certificacao-pratica-'));
  for (const arquivo of new Set(arquivos)) {
    const destino = path.join(tmp, arquivo);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.copyFileSync(path.join(raiz, arquivo), destino);
  }
  return tmp;
}

function mutacao(relativo, de, para) {
  const tmp = preparar();
  const alvo = path.join(tmp, relativo);
  const antes = fs.readFileSync(alvo, 'utf8');
  assert.ok(antes.includes(de), `fixture não contém mutação: ${de.slice(0, 100)}`);
  fs.writeFileSync(alvo, antes.replace(de, para));
  const resultado = spawnSync(process.execPath, ['scripts/verificar-certificacao-pratica.mjs'], {
    cwd: tmp,
    encoding: 'utf8',
  });
  assert.notEqual(resultado.status, 0, `guarda aceitou regressão em ${relativo}`);
}

test('detecta Worker removido da medição', () => mutacao(
  'scripts/medicao.sh',
  'nohup node apps/worker/dist/main.js',
  'echo "worker removido"',
));

test('detecta retomada após SIGKILL removida', () => mutacao(
  'scripts/medicao.sh',
  "printf '\\n\\033[1m==> queda abrupta e retomada do Worker\\033[0m\\n'\nkill -KILL \"$PID_WORKER\"",
  "printf '\\n\\033[1m==> queda abrupta e retomada do Worker\\033[0m\\n'\ntrue # queda removida",
));

test('detecta redução silenciosa da disputa para menos de 50', () => mutacao(
  'scripts/carga-concorrencia-reserva.mjs',
  'CARGA_RESERVAS_SIMULTANEAS ?? 100',
  'CARGA_RESERVAS_SIMULTANEAS ?? 2',
));

test('detecta retirada da prova direta no banco', () => mutacao(
  'scripts/carga-concorrencia-reserva.mjs',
  'totalNoBanco !== 1',
  'false && totalNoBanco !== 1',
));

test('detecta idempotência removida da carga', () => mutacao(
  'scripts/carga-concorrencia-reserva.mjs',
  'replay.body?.id !== appointmentId',
  'false && replay.body?.id !== appointmentId',
));

/**
 * A contagem sai do disco, não escrita aqui.
 *
 * Ela era `'aplica as 117 migrações'` à mão, e a migração seguinte deixou este
 * teste procurando um texto que já não existia: ele reprovava com "fixture não
 * contém mutação" — falha que **parece** defeito da documentação e é do próprio
 * teste. A guarda que ele prova já conta as migrações; contar de novo aqui era a
 * mesma lista escrita duas vezes, e a segunda envelheceu primeiro.
 */
const QUANTAS_MIGRACOES = fs.readdirSync(path.join(raiz, 'packages/db/migrations'))
  .filter((nome) => /^\d{4}_.+\.sql$/.test(nome)).length;

test('detecta documentação voltando a uma contagem antiga de migrações', () => mutacao(
  'docs/deploy.md',
  `aplica as ${QUANTAS_MIGRACOES} migrações`,
  'aplica as 83 migrações',
));

test('detecta promessa falsa de provider fiscal/split', () => mutacao(
  'docs/go-live.md',
  'Fiscal e split\nnão possuem provider real',
  'Fiscal e split\nestão prontos em produção',
));

test('detecta guarda removida do portão', () => mutacao(
  'scripts/verify.sh',
  'lancar "certificação prática da pilha" node scripts/verificar-certificacao-pratica.mjs',
  'echo "certificação prática removida"',
));
