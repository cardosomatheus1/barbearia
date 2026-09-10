import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const script = resolve('deploy/atualizar.sh');
const approved = 'a'.repeat(40), newer = 'b'.repeat(40), old = 'c'.repeat(40);
function run(fail = false, automatico = false) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-sha-'));
  try {
    mkdirSync(join(dir, 'deploy')); mkdirSync(join(dir, 'bin'));
    const file = (path, text) => writeFileSync(join(dir, path), text, { mode: 0o700 });
    file('.env', 'DOMINIO=barberdock.example\n');
    file('head', old);
    file('deploy/backup.sh', '#!/bin/sh\nexit 0\n');
    file('deploy/verificar-prontidao.mjs', 'process.exit(0);\n');
    copyFileSync(script, join(dir, 'deploy/atualizar.sh'));
    file('deploy/verificar-esteira.mjs', `
import { existsSync, writeFileSync } from 'node:fs';
const marker = process.env.DESTINO + '/gate-checked';
const first = !existsSync(marker);
writeFileSync(marker, 'checked');
process.exit(process.env.GATE_FAIL === '1' && !(process.env.AUTO_TEST === '1' && first) ? 1 : 0);
`);
    file('bin/curl', `#!/bin/sh\nprintf '%s\\n' '{"sha":"${approved}"}'\n`);
    file('bin/docker', '#!/bin/sh\nprintf "%s\\n" "$APP_VERSION" >> "$DESTINO/versions"\n');
    file('bin/git', `#!/bin/sh
case "$*" in
  *"rev-parse --abbrev-ref"*) echo origin/main ;;
  "rev-parse HEAD") cat "$DESTINO/head" ;;
  "rev-parse origin/main") echo ${newer} ;;
  "rev-parse --short"*) echo short ;;
  "fetch"*) echo ${newer} > "$DESTINO/remote" ;;
  "cat-file"*) exit 0 ;;
  "reset --hard --quiet"*) printf "%s" "$4" > "$DESTINO/head" ;;
  *) exit 1 ;;
esac
`);
    const result = spawnSync('bash', [automatico ? resolve('deploy/auto-atualizar.sh') : script], { encoding: 'utf8', env: {
      ...process.env, DESTINO: dir, DEPLOY_SHA: approved, BRANCH: 'main',
      AUTO_TEST: automatico ? '1' : '0', AUTO_LOG: join(dir, 'auto.log'), AUTO_TRAVA: join(dir, 'auto.lock'),
      GATE_FAIL: fail ? '1' : '0', PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    } });
    return { status: result.status, output: result.stderr + result.stdout, previousWritten: existsSync(join(dir, '.versao-anterior')), blacklisted: existsSync(join(dir, '.commits-que-falharam')), head: readFileSync(join(dir, 'head'), 'utf8'),
      versions: existsSync(join(dir, 'versions')) ? readFileSync(join(dir, 'versions'), 'utf8').trim().split('\n') : [] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('branch avançando durante fetch não troca o SHA aprovado e publicado', () => {
  const result = run();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.head, approved);
  assert.ok(result.versions.length > 0);
  assert.ok(result.versions.every((version) => version === approved));
});
test('deploy manual também recusa gate sem aprovação antes de trocar checkout', () => {
  const result = run(true);
  assert.equal(result.status, 78);
  assert.equal(result.previousWritten, false);
  assert.equal(result.head, old);
});
test('reexecução de CI entre os dois exames adia o deploy automático sem bloquear o commit', () => {
  const result = run(true, true);
  assert.equal(result.status, 0, result.output);
  assert.equal(result.head, old);
  assert.equal(result.previousWritten, false);
  assert.equal(result.blacklisted, false);
  assert.deepEqual(result.versions, []);
  assert.match(result.output, /voltou a aguardar o portão/);
});

test('ativação funciona sem crontab anterior e desativação aceita remover a única entrada', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-cron-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/crontab'), `#!/bin/sh
if [ "$1" = '-l' ]; then
  [ -f "$DESTINO/cron" ] || exit 1
  cat "$DESTINO/cron"
else
  cat > "$DESTINO/cron"
fi
`, { mode: 0o700 });
    const run = (arg) => spawnSync('bash', [resolve('deploy/auto-atualizar.sh'), arg], { encoding: 'utf8', env: {
      ...process.env, DESTINO: dir, AUTO_LOG: join(dir, 'auto.log'), PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    } });
    const on = run('--ligar');
    assert.equal(on.status, 0, on.stdout + on.stderr);
    assert.match(readFileSync(join(dir, 'cron'), 'utf8'), /EXIGIR_ESTEIRA=1/);
    assert.equal(run('--ligar').status, 0);
    assert.equal(readFileSync(join(dir, 'cron'), 'utf8').trim().split('\n').length, 1);
    assert.equal(run('--desligar').status, 0);
    assert.equal(readFileSync(join(dir, 'cron'), 'utf8'), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
