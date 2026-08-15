import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * As migrações, **aplicadas duas vezes**.
 *
 * ## O defeito que este arquivo existe para não deixar voltar
 *
 * `deploy/compose.yml` aplicava as migrações assim, e `migrate.sh` e o
 * `test.sh` tinham cópias da mesma ideia:
 *
 *     for m in packages/db/migrations/*.sql; do psql ... -f "$m"; done
 *
 * Todas, sempre, sem registrar nenhuma. Na primeira subida funciona. Na segunda
 * — que é **toda atualização**, porque `preparar` roda a cada `docker compose
 * up` — o `0001` reencontra o que ele mesmo criou e morre em
 * `CREATE TYPE professional_kind ... já existe`, com saída 3.
 *
 * E o estrago não para no container que falhou. `api`, `worker` e `web` esperam
 * `preparar` com `condition: service_completed_successfully`; o compose aborta a
 * subida inteira e **não sobe o Caddy**. O sintoma em produção é o site fora do
 * ar, na porta 443 recusando conexão, depois de um comando que era só para
 * atualizar. Foi exatamente o que aconteceu na primeira instalação de verdade.
 *
 * ## O livro-caixa, e por que ele tem uma baseline
 *
 * O conserto é registrar o que já foi aplicado, em `schema_migrations`. Só que
 * os bancos que já existem lá fora não têm esse registro, e um livro vazio faria
 * o script achar que **nada** foi aplicado — reaplicando tudo e reproduzindo o
 * mesmo erro que ele veio consertar.
 *
 * Daí a adoção: banco com schema e sem livro é banco anterior ao livro, e as
 * migrações até a baseline entram como aplicadas sem rodar. A baseline é um
 * nome de arquivo escrito, e não "todas": um banco adotado precisa continuar
 * recebendo o que veio **depois** dele. Marcar tudo faria a migração seguinte
 * ser pulada em silêncio, que é a única falha pior que a que estamos
 * consertando — ela só aparece quando a aplicação lê a coluna que não existe.
 */

const ADMIN = process.env.ADMIN_DATABASE_URL;
const RAIZ_DB = join(import.meta.dirname, '..');
const MIGRATE = join(RAIZ_DB, 'scripts', 'migrate.sh');
const PASTA_MIGRACOES = join(RAIZ_DB, 'migrations');
/** As migrações dão `GRANT` ao role da aplicação: sem ele, nem a primeira roda. */
const BOOTSTRAP = join(import.meta.dirname, '..', '..', '..', 'scripts', 'bootstrap-role.sh');

/** Depois da baseline, para provar que banco adotado ainda recebe o que é novo. */
const POSTERIOR = join(PASTA_MIGRACOES, '9999_teste_do_livro_caixa.sql');

function psql(url, sql) {
  return execFileSync('psql', [url, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const BASE = ADMIN ? ADMIN.slice(0, ADMIN.lastIndexOf('/')) : '';

function bancoLimpo(nome) {
  psql(ADMIN, `DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
  psql(ADMIN, `CREATE DATABASE ${nome}`);
  return `${BASE}/${nome}`;
}

function migrar(url) {
  return execFileSync('bash', [MIGRATE], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function arquivosDeMigracao() {
  return readdirSync(PASTA_MIGRACOES)
    .filter((n) => n.endsWith('.sql'))
    .sort();
}

/** O laço de antes: todas, sempre, sem registrar nenhuma. */
function lacoIngenuo(url) {
  for (const nome of arquivosDeMigracao()) {
    execFileSync('psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', '-f', join(PASTA_MIGRACOES, nome)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
}

const BANCOS = [];
function banco(nome) {
  BANCOS.push(nome);
  return bancoLimpo(nome);
}

describe.skipIf(!ADMIN)('as migrações aplicadas duas vezes', () => {
  beforeAll(() => {
    // Senha efêmera por execução, como em `packages/db/scripts/test.sh`: nunca
    // há credencial previsível, nem no repositório.
    execFileSync('bash', [BOOTSTRAP], {
      env: {
        ...process.env,
        ADMIN_DATABASE_URL: ADMIN,
        APP_DB_PASSWORD: process.env.APP_DB_PASSWORD || execFileSync('openssl', ['rand', '-hex', '16'], { encoding: 'utf8' }).trim(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }, 60_000);

  afterAll(() => {
    rmSync(POSTERIOR, { force: true });
    for (const nome of BANCOS) {
      try {
        psql(ADMIN, `DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
      } catch {
        // Banco descartável: falhar em apagar não invalida o que foi provado.
      }
    }
  });

  it(
    'a segunda passada não quebra — e é ela que derrubava o site',
    () => {
      const url = banco('livro_caixa_repetido');

      migrar(url);
      // Sem livro-caixa, esta linha morre em `professional_kind já existe`, o
      // compose aborta a subida e o Caddy não sobe.
      const segunda = migrar(url);

      expect(segunda).toContain('nada a aplicar');
    },
    180_000,
  );

  it(
    'o livro-caixa registra uma linha por migração',
    () => {
      const url = banco('livro_caixa_registro');

      migrar(url);

      const registradas = Number(psql(url, 'SELECT count(*) FROM schema_migrations'));
      expect(registradas).toBe(arquivosDeMigracao().length);
    },
    180_000,
  );

  it(
    'banco anterior ao livro-caixa é adotado, sem reaplicar nada',
    () => {
      // O banco que já está lá fora: schema inteiro, livro nenhum.
      const url = banco('livro_caixa_adocao');
      lacoIngenuo(url);

      const saida = migrar(url);

      expect(saida).toContain('adotado');
      const registradas = Number(psql(url, 'SELECT count(*) FROM schema_migrations'));
      expect(registradas).toBe(arquivosDeMigracao().length);
    },
    180_000,
  );

  it(
    'no banco adotado, a migração posterior à baseline ainda é aplicada',
    () => {
      /**
       * A metade perigosa da adoção. Marcar **tudo** como aplicado deixaria a
       * migração nova ser pulada em silêncio, e a falha só apareceria quando a
       * aplicação lesse a coluna que ninguém criou.
       */
      const url = banco('livro_caixa_posterior');
      lacoIngenuo(url);

      writeFileSync(POSTERIOR, 'CREATE TABLE IF NOT EXISTS teste_do_livro_caixa (id integer PRIMARY KEY);\n');
      migrar(url);

      const existe = psql(
        url,
        "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'teste_do_livro_caixa'",
      );
      expect(existe, 'a migração posterior à baseline foi pulada em silêncio').toBe('1');
    },
    180_000,
  );

  it(
    'o laço ingênuo, que era o de antes, falha na segunda passada',
    () => {
      /**
       * Guarda que não fica vermelha não guarda nada. Se um dia as migrações
       * ficarem todas idempotentes por conta própria, este teste passa a
       * reprovar — e aí o livro-caixa merece uma conversa, não um `skip`.
       */
      const url = banco('livro_caixa_ingenuo');
      lacoIngenuo(url);

      let morreu = false;
      try {
        lacoIngenuo(url);
      } catch {
        morreu = true;
      }

      expect(morreu, 'o laço ingênuo deixou de falhar: este teste perdeu o sentido').toBe(true);
    },
    180_000,
  );
});
