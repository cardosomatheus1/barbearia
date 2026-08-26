import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { falhasDaRedeDeDeploy } from './verificar-rede-de-deploy.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = ['deploy/backup.sh', 'deploy/atualizar.sh', 'deploy/voltar.sh'];

test('o deploy de hoje passa', () => assert.deepEqual(falhasDaRedeDeDeploy(), []));

function copia() {
  const base = mkdtempSync(resolve(tmpdir(), 'rede-deploy-'));
  for (const p of SCRIPTS) {
    const destino = join(base, p);
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, readFileSync(join(RAIZ, p), 'utf8'));
  }
  return base;
}

const quebras = [
  [
    'o backup volta a exigir a API de pé',
    'deploy/backup.sh',
    (s) =>
      s.replace(
        /\$COMPOSE run --rm --no-deps -T --entrypoint sh api \\\n\s*-c/,
        "$COMPOSE exec -T api sh -c",
      ),
  ],
  [
    'o backup volta a fazer backup antes de buscar o código',
    'deploy/atualizar.sh',
    (s) => {
      // Troca os dois blocos de lugar, que é a regressão de verdade — e não
      // apagar um deles, que a guarda pegaria por outro motivo.
      const fetch = 'git fetch --quiet origin "$BRANCH"';
      const backup = 'DESTINO="$DESTINO" "$DESTINO/deploy/backup.sh"';
      return s.replace(fetch, '@@F@@').replace(backup, fetch).replace('@@F@@', backup);
    },
  ],
  [
    'a volta para de conferir se o site responde',
    'deploy/voltar.sh',
    (s) => s.replace(/curl -fsS --max-time 5 "https:\/\/\$DOMINIO_NO_ENV\//, 'true "#'),
  ],
  [
    'a volta volta a terminar em sucesso com a versão quebrada',
    'deploy/voltar.sh',
    (s) => s.replace('morrer "a versão', 'echo "a versão'),
  ],
];

for (const [nome, arquivo, quebrar] of quebras) {
  test(`fica vermelha quando ${nome}`, () => {
    const base = copia();
    try {
      const antes = readFileSync(join(base, arquivo), 'utf8');
      const depois = quebrar(antes);
      // Quebra que não casa deixa o teste passando pelo motivo errado: a guarda
      // pareceria não prestar quando quem não prestou foi a quebra.
      assert.notEqual(depois, antes, `a quebra "${nome}" não casou com nada`);
      writeFileSync(join(base, arquivo), depois);
      assert.ok(falhasDaRedeDeDeploy(base).length > 0, `a guarda não viu: ${nome}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
