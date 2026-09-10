import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function conferirWorker(registro, { agora = Date.now(), versao = process.env.APP_VERSION ?? 'dev', vivo = (pid) => process.kill(pid, 0) } = {}) {
  if (!Number.isInteger(registro.pid) || registro.pid <= 0 || registro.versao !== versao ||
    !Number.isFinite(registro.atualizadoEm) || agora - registro.atualizadoEm > 120_000 ||
    registro.atualizadoEm > agora) throw new Error('Worker sem rodada recente nesta versão');
  vivo(registro.pid);
  return { status: 'ok', versao: registro.versao };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(conferirWorker(JSON.parse(readFileSync('/tmp/barbearia-worker-ready.json', 'utf8'))))); }
  catch { console.error('Worker não está pronto'); process.exitCode = 1; }
}
