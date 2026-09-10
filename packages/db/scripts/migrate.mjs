import { Client } from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalSchema, sql, withScratchDatabase } from './schema-tools.mjs';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('defina DATABASE_URL');
const folder = join(import.meta.dirname, '..', 'migrations');
const files = readdirSync(folder).filter((name) => name.endsWith('.sql')).sort().map((name) => {
  if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) throw new Error('nome de migração inválido');
  const body = readFileSync(join(folder, name), 'utf8');
  return { name, body, hash: createHash('sha256').update(body).digest('hex') };
});
const db = new Client({ connectionString: url });
await db.connect();
try {
  // A conexão permanece aberta durante todos os psql filhos. Dois migradores
  // jamais decidem simultaneamente que falta a mesma migração.
  await db.query("SELECT pg_advisory_lock(hashtext('barbearia.schema_migrations'))");
  const { rows: [state] } = await db.query(`SELECT
    to_regclass('public.schema_migrations') IS NOT NULL AS journal,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND c.relname NOT IN ('schema_migrations','schema_migration_attempts')) AS populated`);
  if (!state.journal && state.populated && !process.env.MIGRATION_ADOPT_THROUGH) {
    throw new Error('Banco preexistente sem histórico: adoção explícita com validação de schema é obrigatória');
  }
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    nome text PRIMARY KEY, aplicada_em timestamptz NOT NULL DEFAULT now(), sha256 text);
    ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS sha256 text;
    CREATE TABLE IF NOT EXISTS schema_migration_attempts (
      nome text PRIMARY KEY, sha256 text NOT NULL, iniciada_em timestamptz NOT NULL DEFAULT now());
    REVOKE ALL ON schema_migrations, schema_migration_attempts FROM PUBLIC;
    REVOKE ALL ON schema_migrations, schema_migration_attempts FROM barbearia_app;`);
  const { rows: attempts } = await db.query('SELECT nome FROM schema_migration_attempts');
  if (attempts.length) throw new Error(`Migração interrompida exige inspeção antes de retentar: ${attempts[0].nome}`);
  const { rows: recorded } = await db.query('SELECT nome, sha256 FROM schema_migrations ORDER BY nome');
  const adoption = process.env.MIGRATION_ADOPT_THROUGH;
  if (adoption) {
    const end = files.findIndex((f) => f.name === adoption);
    if (end < 0) throw new Error('MIGRATION_ADOPT_THROUGH não identifica uma migração deste checkout');
    if (!process.env.ADMIN_DATABASE_URL) throw new Error('Adoção exige ADMIN_DATABASE_URL para referência descartável');
    const selected = files.slice(0, end + 1);
    if (recorded.some((r) => !selected.some((f) => f.name === r.nome) ||
      (r.sha256 && selected.find((f) => f.name === r.nome).hash !== r.sha256))) {
      throw new Error('Histórico diverge do intervalo solicitado para adoção');
    }
    const expected = await withScratchDatabase(process.env.ADMIN_DATABASE_URL, async (reference) => {
      for (const file of selected) sql(reference, file.body);
      return canonicalSchema(reference, process.env.ADMIN_DATABASE_URL);
    });
    if (expected !== await canonicalSchema(url, process.env.ADMIN_DATABASE_URL)) {
      throw new Error('Adoção recusada: schema e permissões divergem da referência reconstruída');
    }
    await db.query('BEGIN');
    for (const file of selected) await db.query(`INSERT INTO schema_migrations (nome, sha256)
      VALUES ($1,$2) ON CONFLICT (nome) DO UPDATE SET sha256=EXCLUDED.sha256`, [file.name, file.hash]);
    await db.query('COMMIT');
    console.log(`banco preexistente adotado: ${selected.length} migrações verificadas`);
  } else if ((state.populated && recorded.length === 0) || recorded.some((r) => !r.sha256)) {
    throw new Error('Histórico vazio ou sem checksum: use adoção explícita com validação de schema');
  }
  const { rows: history } = await db.query('SELECT nome, sha256 FROM schema_migrations ORDER BY nome');
  // O histórico tem que ser um prefixo íntegro da lista, nunca uma lista com buracos.
  for (const [i, row] of history.entries()) {
    if (files[i]?.name !== row.nome || files[i]?.hash !== row.sha256) {
      throw new Error(`Histórico ou checksum divergente: ${row.nome}`);
    }
  }
  let applied = 0;
  for (const file of files.slice(history.length)) {
    await db.query('INSERT INTO schema_migration_attempts (nome, sha256) VALUES ($1,$2)', [file.name, file.hash]);
    console.log(`==> ${file.name}`);
    // ADD VALUE precisa de commit antes de usar o enum. Nos demais arquivos,
    // DDL e registro são atômicos; o marcador também cobre morte do processo.
    const transactional = !/\bALTER\s+TYPE\b[\s\S]*?\bADD\s+VALUE\b/i.test(file.body);
    sql(url, `${file.body}\nINSERT INTO schema_migrations (nome, sha256) VALUES ('${file.name}','${file.hash}');
      DELETE FROM schema_migration_attempts WHERE nome='${file.name}';
      REVOKE ALL ON schema_migrations, schema_migration_attempts FROM barbearia_app;`, transactional);
    applied += 1;
  }
  console.log(applied ? `migrações aplicadas: ${applied}` : 'migrações aplicadas: nada a aplicar');
} catch (error) {
  // Não imprimir connection strings nem SQL com dados que possam existir em migrações.
  console.error(error?.stderr ? 'Migração SQL falhou; histórico não avançou. Inspecione a tentativa registrada.' : error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
