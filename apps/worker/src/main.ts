import { assertRlsEnforced, disconnect } from '@barbearia/db';
import {
  ConsoleNotificationProvider,
  RELOGIO_REAL,
  rodarWorker,
  type ResultadoDaRodada,
} from '@barbearia/jobs';
import { recursoLigado } from '@barbearia/platform';

/**
 * O segundo processo do produto.
 *
 * Até o bloco 20 existia um só: a API, que só faz coisa enquanto alguém espera a
 * resposta. Lembrete de 24 horas não cabe nesse modelo — ninguém está esperando
 * às 9h da manhã de ontem.
 *
 * Ele é deliberadamente burro. Toda regra está em `packages/core`, todo acesso a
 * dado passa por `withTenant` dentro do handler, e este arquivo só liga o
 * provedor ao laço e cuida de terminar direito.
 *
 * **Sobe junto com a API, não no lugar dela.** São dois processos do mesmo
 * código, e o `SKIP LOCKED` já permite quantas cópias forem necessárias sem
 * duas pegarem a mesma tarefa.
 */

const INTERVALO_MS = Number(process.env['WORKER_INTERVALO_MS'] ?? 5_000);

async function main(): Promise<void> {
  // Mesma guarda da API: se a conexão ignora RLS, o isolamento entre barbearias
  // não existe. Aqui o risco é maior, porque o worker atravessa tenants por
  // desenho — uma tarefa de cada barbearia, uma de cada vez.
  await assertRlsEnforced();

  let parando = false;
  const parar = (sinal: string): void => {
    if (parando) return;
    parando = true;
    // Sem `process.exit`: o laço confere `parar()` entre tarefas e sai depois
    // de terminar a que está em curso. Matar no meio deixaria `running`
    // pendurado até a varredura de órfãs — que existe, mas é a rede, não o
    // plano.
    console.log(`[worker] ${sinal} recebido; terminando a tarefa em curso`);
  };

  process.on('SIGTERM', () => parar('SIGTERM'));
  process.on('SIGINT', () => parar('SIGINT'));

  console.log(`[worker] ouvindo a fila a cada ${INTERVALO_MS}ms`);

  await rodarWorker(
    {
      provider: new ConsoleNotificationProvider(),
      relogio: RELOGIO_REAL,
      // É aqui que a plataforma se liga ao worker, e só aqui: `packages/jobs`
      // não conhece a camada de cima, do mesmo jeito que não conhece o provedor
      // de mensagem. Quem monta o processo é quem liga as duas pontas.
      recursoLigado,
    },
    {
      intervaloMs: INTERVALO_MS,
      parar: () => parando,
      aoRodar: (resultado: ResultadoDaRodada) => {
        // Rodada vazia é a maioria e não vira linha de log: um worker que
        // escreve a cada cinco segundos enterra o dia em que algo falhou.
        if (resultado.tomadas === 0) return;
        console.log(
          `[worker] ${resultado.tomadas} tarefa(s): ${resultado.concluidas} ok, ` +
            `${resultado.reagendadas} para tentar de novo, ${resultado.falhadas} falha(s)`,
        );
      },
    },
  );

  await disconnect();
  console.log('[worker] encerrado');
}

void main().catch((erro: unknown) => {
  console.error('[worker] parou com erro', erro);
  process.exitCode = 1;
});
