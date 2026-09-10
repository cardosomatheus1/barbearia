import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const sha = 'a'.repeat(40);
function instalar({ gate = true, pronta = true, existente = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'barbearia-instalar-'));
  try {
    mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'deploy'));
    const file = (name, body) => writeFileSync(join(dir, name), body, { mode: 0o700 });
    // Todo comando que alcançaria host/rede é substituído dentro desta pasta.
    for (const name of ['ufw', 'sleep']) file(`bin/${name}`, '#!/bin/sh\nexit 0\n');
    file('bin/id', '#!/bin/sh\necho 0\n');
    file('bin/curl', '#!/bin/sh\necho 192.0.2.1\n');
    file('bin/getent', '#!/bin/sh\necho "192.0.2.1 STREAM teste"\n');
    file('bin/seq', '#!/bin/sh\nprintf "1\\n60\\n"\n');
    file('bin/install', '#!/bin/sh\ntouch "$DESTINO/backup-installed"\n');
    file('bin/docker', '#!/bin/sh\nprintf "%s|%s\\n" "$*" "$APP_VERSION" >> "$DESTINO/docker-calls"\n');
    file('bin/git', `#!/bin/sh
case "$*" in
  *"rev-parse --short HEAD") echo aaaaaaa ;;
  *"rev-parse HEAD"|*"rev-parse origin/main") echo ${sha} ;;
  "clone "*) mkdir -p "$DESTINO/.git" ;;
  *"fetch "*|*"checkout "*) exit 0 ;;
  *) exit 1 ;;
esac
`);
    file('deploy/segredos.sh', '#!/bin/sh\necho DOMINIO=barberdock.example > "$1"\n');
    file('deploy/cron-do-backup.sh', '#!/bin/sh\nexit 0\n');
    file('deploy/backup.sh', '#!/bin/sh\nexit 0\n');
    file('deploy/atualizar.sh', '#!/bin/sh\ntouch "$DESTINO/delegated-update"\n');
    file('deploy/verificar-esteira.mjs', `process.exit(process.env.GATE_OK === '1' && process.argv[2] === '${sha}' ? 0 : 1);`);
    file('deploy/verificar-prontidao.mjs', `process.exit(process.env.STACK_OK === '1' && process.argv[2] === '${sha}' ? 0 : 1);`);
    if (existente) { mkdirSync(join(dir, '.git')); file('.env', 'DOMINIO=barberdock.example\n'); }
    const result = spawnSync('bash', [resolve('deploy/instalar.sh'), 'barberdock.example', 'ops@example.test'], {
      encoding: 'utf8', env: { ...process.env, DESTINO: dir, BRANCH: 'main', GATE_OK: gate ? '1' : '0',
        STACK_OK: pronta ? '1' : '0', PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    });
    return { status: result.status, output: result.stdout + result.stderr,
      backup: existsSync(join(dir, 'backup-installed')), delegated: existsSync(join(dir, 'delegated-update')),
      calls: existsSync(join(dir, 'docker-calls')) ? readFileSync(join(dir, 'docker-calls'), 'utf8') : '' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('primeira instalação exige CI antes de subir e passa o SHA aprovado aos serviços', () => {
  const blocked = instalar({ gate: false });
  assert.equal(blocked.status, 1, blocked.output);
  assert.doesNotMatch(blocked.calls, /up -d/);
  assert.equal(blocked.backup, false);
  const success = instalar();
  assert.equal(success.status, 0, success.output);
  assert.match(success.calls, new RegExp(`up -d --build\\|${sha}`));
  assert.equal(success.backup, true);
});

test('homepage respondendo não permite concluir instalação com pilha indisponível', () => {
  const result = instalar({ pronta: false });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.backup, false);
  assert.match(result.output, /pilha não ficou pronta/);
});

test('instalação existente usa atualização com backup em vez de migrar diretamente', () => {
  const result = instalar({ existente: true });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.delegated, true);
  assert.equal(result.calls, '');
});
