import { execFile, execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Migração limpa, retomada segura, concorrência e adoção explícita de legado. */
const ADMIN = process.env.ADMIN_DATABASE_URL;
const RAIZ_DB = join(import.meta.dirname, '..');
// Fixtures de migração nunca entram na pasta que as demais suítes percorrem.
const FIXTURE = mkdtempSync(join(tmpdir(), 'migracoes-test-'));
cpSync(join(RAIZ_DB, 'migrations'), join(FIXTURE, 'migrations'), { recursive: true });
cpSync(join(RAIZ_DB, 'scripts'), join(FIXTURE, 'scripts'), { recursive: true });
symlinkSync(join(RAIZ_DB, 'node_modules'), join(FIXTURE, 'node_modules'), 'dir');
const MIGRATE = join(FIXTURE, 'scripts', 'migrate.sh');
const PASTA_MIGRACOES = join(FIXTURE, 'migrations');
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

function migrar(url, extras = {}) {
  return execFileSync('bash', [MIGRATE], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url, ...extras },
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
  }, 300_000);

  afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
    for (const nome of BANCOS) {
      try {
        psql(ADMIN, `DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
      } catch {
        // Banco descartável: falhar em apagar não invalida o que foi provado.
      }
    }
    // Cinco `DROP DATABASE ... WITH (FORCE)` passam dos 10s padrão do gancho
    // quando o portão roda dez suítes contra o mesmo Postgres. Sem esta folga o
    // arquivo fica vermelho com os cinco testes verdes — reprovado pela
    // limpeza, que é o pior formato de vermelho que existe: ele não aponta
    // defeito nenhum e ensina a ignorar a cor.
    //
    // **E 180s também não bastaram.** Numa máquina mais lenta os cinco testes
    // levaram **397s** e o gancho estourou os 180, com os cinco verdes: a saída
    // dizia `Tests 5 passed` acima de `Hook timed out`, que é o retrato exato do
    // vermelho que este parágrafo descreve. O número subiu para 300s pela mesma
    // regra de antes — ele é medido, e acompanha o tempo da suíte, não um palpite.
    //
    // **60s não bastavam, e o número aqui é medido.** No portão inteiro os
    // cinco testes levaram 340s e o gancho estourou os 60 — exatamente o
    // vermelho que o parágrafo acima descreve, e ele apareceu duas vezes
    // seguidas antes de alguém ler a saída inteira em vez do `tail`. A folga
    // passa a ser a mesma dos testes deste arquivo: se uma passada de migração
    // ganha 180s, apagar cinco bancos sob a mesma contenção ganha igual.
  }, 300_000);

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
    300_000,
  );

  it(
    'o livro-caixa registra uma linha por migração',
    () => {
      const url = banco('livro_caixa_registro');

      migrar(url);

      const registradas = Number(psql(url, 'SELECT count(*) FROM schema_migrations'));
      expect(registradas).toBe(arquivosDeMigracao().length);
    },
    300_000,
  );

  it(
    'banco anterior ao livro-caixa é adotado, sem reaplicar nada',
    () => {
      // O banco que já está lá fora: schema inteiro, livro nenhum.
      const url = banco('livro_caixa_adocao');
      lacoIngenuo(url);

      expect(() => migrar(url)).toThrow();
      const saida = migrar(url, { MIGRATION_ADOPT_THROUGH: arquivosDeMigracao().at(-1) });

      expect(saida).toContain('adotado');
      const registradas = Number(psql(url, 'SELECT count(*) FROM schema_migrations'));
      expect(registradas).toBe(arquivosDeMigracao().length);
    },
    300_000,
  );

  it(
    'depois da adoção validada, uma migração nova ainda é aplicada',
    () => {
      /**
       * A metade perigosa da adoção. Marcar **tudo** como aplicado deixaria a
       * migração nova ser pulada em silêncio, e a falha só apareceria quando a
       * aplicação lesse a coluna que ninguém criou.
       */
      const url = banco('livro_caixa_posterior');
      lacoIngenuo(url);

      migrar(url, { MIGRATION_ADOPT_THROUGH: arquivosDeMigracao().at(-1) });
      writeFileSync(POSTERIOR, 'CREATE TABLE IF NOT EXISTS teste_do_livro_caixa (id integer PRIMARY KEY);\n');
      migrar(url);

      const existe = psql(
        url,
        "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'teste_do_livro_caixa'",
      );
      expect(existe, 'a migração posterior à baseline foi pulada em silêncio').toBe('1');
    },
    300_000,
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
    300_000,
  );
  it('primeira migração sem journal nunca é confundida com 83 migrações aplicadas', () => {
    const url = banco('livro_caixa_interrompido');
    execFileSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-f', join(PASTA_MIGRACOES, arquivosDeMigracao()[0])], { stdio: 'pipe' });
    expect(() => migrar(url)).toThrow();
    expect(psql(url, "SELECT to_regclass('public.schema_migrations') IS NULL")).toBe('t');
    expect(() => migrar(url, { MIGRATION_ADOPT_THROUGH: '0083_recurso_fiscal.sql' })).toThrow();
    expect(psql(url, 'SELECT count(*) FROM schema_migrations')).toBe('0');
  }, 300_000);

  it('checksum alterado e tentativa interrompida impedem uma nova aplicação', () => {
    const url = banco('livro_caixa_checksum');
    migrar(url);
    psql(url, "UPDATE schema_migrations SET sha256='alterado' WHERE nome=(SELECT min(nome) FROM schema_migrations)");
    expect(() => migrar(url)).toThrow();
    psql(url, "INSERT INTO schema_migration_attempts (nome, sha256) VALUES ('interrompida', 'abc')");
    expect(() => migrar(url)).toThrow();
    expect(psql(url, 'SELECT count(*) FROM schema_migration_attempts')).toBe('1');
    expect(psql(url, "SELECT has_table_privilege('barbearia_app','schema_migrations','UPDATE')")).toBe('f');
  }, 300_000);

  it('dois migradores simultâneos aplicam cada arquivo uma única vez', async () => {
    const url = banco('livro_caixa_concorrencia');
    const executar = () => promisify(execFile)('bash', [MIGRATE], {
      env: { ...process.env, DATABASE_URL: url }, maxBuffer: 8 * 1024 * 1024,
    });
    const resultados = await Promise.all([executar(), executar()]);
    expect(resultados.filter((r) => r.stdout.includes('nada a aplicar'))).toHaveLength(1);
    expect(Number(psql(url, 'SELECT count(*) FROM schema_migrations'))).toBe(arquivosDeMigracao().length);
  }, 300_000);

  it('falha SQL deixa tentativa registrada, reverte o DDL e impede reaplicação silenciosa', () => {
    const url = banco('livro_caixa_falha_sql');
    migrar(url);
    const arquivo = join(PASTA_MIGRACOES, '9999_zz_falha_sql.sql');
    try {
      writeFileSync(arquivo, 'CREATE TABLE prova_rollback_migracao (id int); SELECT 1/0;');
      expect(() => migrar(url)).toThrow();
      expect(psql(url, "SELECT to_regclass('prova_rollback_migracao') IS NULL")).toBe('t');
      expect(psql(url, "SELECT count(*) FROM schema_migration_attempts WHERE nome='9999_zz_falha_sql.sql'")).toBe('1');
      expect(() => migrar(url)).toThrow();
      expect(psql(url, "SELECT count(*) FROM schema_migrations WHERE nome='9999_zz_falha_sql.sql'")).toBe('0');
    } finally { rmSync(arquivo, { force: true }); }
  }, 300_000);

});
