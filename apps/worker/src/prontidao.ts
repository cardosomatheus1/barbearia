import { renameSync, writeFileSync } from 'node:fs';

/** Só uma rodada que conseguiu ler a fila atualiza esta evidência. */
export function marcarWorkerPronto(): void {
  const path = '/tmp/barbearia-worker-ready.json';
  writeFileSync(`${path}.tmp`, JSON.stringify({
    pid: process.pid, versao: process.env['APP_VERSION'] ?? 'dev', atualizadoEm: Date.now(),
  }), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
