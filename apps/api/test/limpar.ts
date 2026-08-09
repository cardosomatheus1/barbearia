import type { PrismaClient } from '@prisma/client';

/**
 * Esvazia o banco entre testes sem travar contra a própria aplicação.
 *
 * ## O que aconteceu
 *
 * A esteira reprovou com `deadlock detected` no `TRUNCATE` do `beforeEach`, e
 * o detalhe do Postgres nomeia os dois lados:
 *
 *     Process 461 espera AccessExclusiveLock  — é este TRUNCATE
 *     Process 462 espera RowShareLock         — é a aplicação, consultando
 *
 * Ou seja: **não são dois arquivos de teste** — `fileParallelism` já é `false`.
 * É a conexão da aplicação, com uma consulta ainda em voo de um teste anterior,
 * segurando a tabela que o TRUNCATE quer, enquanto o TRUNCATE segura a que ela
 * quer. Inversão de ordem de lock clássica, e o Postgres mata um dos dois.
 *
 * Nunca apareceu nesta máquina e apareceu na primeira execução da esteira, que
 * tem outro número de núcleos e outra temporização. É a categoria de falha que
 * mais estraga um portão: intermitente, e portanto ensina todo mundo a
 * reexecutar em vez de olhar.
 *
 * ## Por que retentar é a resposta certa aqui, e não um curativo
 *
 * Deadlock não é defeito de dado nem de consulta: é o Postgres **detectando** e
 * quebrando um ciclo que só existe pela ordem em que duas transações chegaram.
 * A documentação dele diz explicitamente que a aplicação deve estar preparada
 * para repetir a transação. Nada é perdido na repetição — o TRUNCATE é
 * idempotente por natureza.
 *
 * O que **não** seria certo é aumentar o tempo de espera e torcer. Por isso:
 *
 * - `lock_timeout` curto, para falhar rápido em vez de pendurar o portão;
 * - número de tentativas fechado, para um banco genuinamente travado reprovar
 *   em vez de girar para sempre;
 * - só `40P01` (deadlock) e `55P03` (lock não disponível) são retentados.
 *   Qualquer outro erro sobe na hora — se o TRUNCATE falhar por permissão ou
 *   por tabela que não existe, isso é defeito e tem que aparecer.
 *
 * Os dois mecanismos cobrem casos diferentes, e vale saber qual faz o quê:
 * o `lock_timeout` **espera** a consulta em voo terminar, e é ele que resolve a
 * contenção comum; a retentativa cobre o deadlock de verdade, que o Postgres
 * aborta na hora e que esperar não resolve.
 *
 * Reproduzido contra banco real, com uma segunda conexão segurando a tabela por
 * 1,2s: o `TRUNCATE` nu reprovou com `55P03`, e esta função passou.
 */

/** Códigos que valem uma nova tentativa. Qualquer outro sobe. */
const TRANSITORIOS = ['40P01', '55P03'];

const TENTATIVAS = 5;

function codigoDoPostgres(erro: unknown): string | null {
  const meta = (erro as { meta?: { code?: unknown } })?.meta;
  return typeof meta?.code === 'string' ? meta.code : null;
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * @param tabelas raízes a truncar. O `CASCADE` leva o resto junto.
 */
export async function limparBanco(
  admin: PrismaClient,
  tabelas: readonly string[] = ['tenants'],
): Promise<void> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      // Dois segundos: mais que o suficiente para uma consulta em voo terminar,
      // e pouco o bastante para cinco tentativas não somarem um minuto.
      await admin.$executeRawUnsafe(`SET lock_timeout = '2s'`);
      for (const tabela of tabelas) {
        await admin.$executeRawUnsafe(`TRUNCATE ${tabela} CASCADE`);
      }
      return;
    } catch (erro) {
      const codigo = codigoDoPostgres(erro);
      if (!codigo || !TRANSITORIOS.includes(codigo) || tentativa === TENTATIVAS) throw erro;

      // Espera crescente: a consulta em voo do outro lado precisa de tempo para
      // terminar, e repetir no mesmo instante recria o mesmo ciclo.
      await dormir(tentativa * 50);
    }
  }
}
