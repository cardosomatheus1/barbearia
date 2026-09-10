import test from 'node:test';
import assert from 'node:assert/strict';
import { conferirWorker } from './worker-pronto.mjs';
import { verificarProntidao } from '../deploy/verificar-prontidao.mjs';
const sha = 'a'.repeat(40);
test('heartbeat expirado, processo morto e outra versão são recusados', () => {
  const record = { pid: 7, versao: sha, atualizadoEm: 1000 };
  const config = { agora: 2000, versao: sha, vivo: () => {} };
  assert.equal(conferirWorker(record, config).status, 'ok');
  for (const changed of [{ atualizadoEm: -200000 }, { atualizadoEm: 3000 }, { versao: 'antiga' }]) {
    assert.throws(() => conferirWorker({ ...record, ...changed }, config));
  }
  assert.throws(() => conferirWorker(record, { ...config, vivo: () => { throw new Error('morto'); } }));
});
test('homepage viva não encobre API, worker, banco ou leitura de domínio indisponíveis', () => {
  const api = { status: 'ok', banco: 'ok', rls: 'aplicada', versao: sha };
  const worker = { status: 'ok', versao: sha };
  const exec = (a = api, w = worker, status = '404') => (_, args) => {
    if (args.includes('worker')) return JSON.stringify(w);
    if (args.some((s) => s.endsWith('/health/pronto'))) return JSON.stringify(a);
    if (args.includes('%{http_code}')) return status;
    return '<html>ok</html>';
  };
  verificarProntidao('/tmp/app', sha, exec());
  for (const a of [{ ...api, banco: 'inacessivel' }, { ...api, rls: 'ignorada' }, { ...api, versao: 'antiga' }]) {
    assert.throws(() => verificarProntidao('/tmp/app', sha, exec(a)));
  }
  assert.throws(() => verificarProntidao('/tmp/app', sha, exec(api, { status: 'degradado', versao: sha })));
  assert.throws(() => verificarProntidao('/tmp/app', sha, exec(api, worker, '500')));
});
