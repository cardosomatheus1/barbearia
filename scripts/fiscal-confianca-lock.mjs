import { spawn } from 'node:child_process';

/** Lock do kernel: inclusive SIGKILL do atualizador fecha stdin e solta flock. */
export function reservarAtualizacao(caminho) {
  return new Promise((resolve, reject) => {
    // O caminho é um argumento; o trecho shell é constante e não recebe entrada
    // do manifesto. A pipe mantém o lock vivo enquanto o processo pai trabalha.
    const filho = spawn('/usr/bin/flock', ['--nonblock', caminho, '/bin/sh', '-c', 'printf "locked\\n"; cat >/dev/null'],
      { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    let pronto = false; let recebido = '';
    const fechado = new Promise(r => filho.once('close', r));
    filho.once('error', () => reject(new Error('lock_indisponivel')));
    filho.stdin.on('error', () => { /* Encerramento da pipe não imprime dados. */ });
    filho.once('exit', () => { if (!pronto) reject(new Error('atualizacao_em_curso')); });
    filho.stdout.on('data', parte => {
      recebido += parte.toString();
      if (!pronto && recebido === 'locked\n') {
        pronto = true;
        resolve(async () => { filho.stdin.end(); await fechado; });
      }
    });
  });
}
