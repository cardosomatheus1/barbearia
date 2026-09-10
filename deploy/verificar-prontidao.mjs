import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function conferirSondas(api, worker, versao) {
  if (!/^[a-f0-9]{40}$/.test(versao) || api.status !== 'ok' || api.banco !== 'ok' || api.rls !== 'aplicada' ||
    api.versao !== versao || worker.status !== 'ok' || worker.versao !== versao) throw new Error('Pilha indisponível ou versão incorreta');
}

export function verificarProntidao(destino, versao, executar = execFileSync) {
  const compose = ['compose', '-f', `${destino}/deploy/compose.yml`, '--env-file', `${destino}/.env`, 'exec', '-T'];
  const run = (args) => executar('docker', [...compose, ...args], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const api = JSON.parse(run(['api', 'curl', '-fsS', '--max-time', '5', 'http://127.0.0.1:3000/health/pronto']));
  const worker = JSON.parse(run(['worker', 'node', 'scripts/worker-pronto.mjs']));
  conferirSondas(api, worker, versao);
  // Leitura de domínio passa pelo banco; não depende de cliente ou tenant real.
  const status = run(['api', 'curl', '-sS', '--max-time', '5', '-o', '/dev/null', '-w', '%{http_code}',
    'http://127.0.0.1:3000/v1/b/readiness-unidade-inexistente']);
  if (status !== '404') throw new Error('Leitura pública não respondeu como esperado');
  run(['web', 'curl', '-fsS', '--max-time', '5', 'http://127.0.0.1:3001/']);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { verificarProntidao(process.env.DESTINO ?? '/opt/barbearia', process.argv[2]); console.log('API, banco, RLS, worker e web prontos'); }
  catch { console.error('Pilha ainda não está pronta na versão esperada'); process.exitCode = 1; }
}
