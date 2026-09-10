import { Client } from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalSchema, sql, withScratchDatabase } from './schema-tools.mjs';

const [mode, url] = process.argv.slice(2);
const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!url || !adminUrl) throw new Error('informe modo, banco e ADMIN_DATABASE_URL');
const admin = new Client({ connectionString: url });
try {
  if (mode === 'signature') {
    console.log(await canonicalSchema(url, adminUrl));
  } else if (mode === 'data-signature') {
    await admin.connect();
    await admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: tabelas } = await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    const resumo = [];
    for (const { tablename } of tabelas) {
      const identificador = '"' + tablename.replaceAll('"', '""') + '"';
      const { rows: [dados] } = await admin.query(`SELECT count(*)::text AS quantidade,
        md5(COALESCE(string_agg(linha, chr(10) ORDER BY linha), '')) AS conteudo
        FROM (SELECT to_jsonb(t)::text AS linha FROM public.${identificador} t) linhas`);
      resumo.push([tablename, dados.quantidade, dados.conteudo]);
    }
    await admin.query('COMMIT');
    // Só o resumo sai do processo; nomes, documentos e conteúdo das linhas não.
    console.log(createHash('sha256').update(JSON.stringify(resumo)).digest('hex'));
  } else if (mode === 'current') {
    await admin.connect();
    const folder = join(import.meta.dirname, '..', 'migrations');
    const files = readdirSync(folder).filter((n) => n.endsWith('.sql')).sort();
    const { rows } = await admin.query('SELECT nome, sha256 FROM schema_migrations ORDER BY nome');
    if (rows.length !== files.length) throw new Error('Histórico não corresponde à versão atual');
    for (const [i, name] of files.entries()) {
      const hash = createHash('sha256').update(readFileSync(join(folder, name))).digest('hex');
      if (rows[i].nome !== name || rows[i].sha256 !== hash) throw new Error('Histórico ou checksum divergente');
    }
    if ((await admin.query('SELECT 1 FROM schema_migration_attempts LIMIT 1')).rowCount) {
      throw new Error('Há migração interrompida');
    }
    const expected = await withScratchDatabase(adminUrl, async (reference) => {
      for (const name of files) sql(reference, readFileSync(join(folder, name), 'utf8'));
      return canonicalSchema(reference, adminUrl);
    });
    if (expected !== await canonicalSchema(url, adminUrl)) throw new Error('Schema diverge da versão atual');
    console.log(`schema atual: ${files.length} migrações, checksum e estrutura conferidos`);
  } else if (mode === 'app') {
    if (!process.env.APP_DB_PASSWORD) throw new Error('defina APP_DB_PASSWORD para testar login real da aplicação');
    await admin.connect();
    const appUrl = new URL(url);
    appUrl.username = 'barbearia_app';
    appUrl.password = process.env.APP_DB_PASSWORD;
    const app = new Client({ connectionString: appUrl.toString() });
    await app.connect();
    try {
      const { rows: [role] } = await app.query(`SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole AS unsafe
        FROM pg_roles WHERE rolname=current_user`);
      if (!role || role.unsafe) throw new Error('Role da aplicação tem privilégios excessivos');
      const tables = ['customers', 'appointments', 'orders', 'locations'];
      for (const table of tables) {
        const { rows: [r] } = await app.query(`SELECT count(*) AS n FROM ${table}`);
        if (r.n !== '0') throw new Error('RLS expõe dados sem tenant');
      }
      const { rows: tenants } = await admin.query('SELECT id FROM tenants ORDER BY id LIMIT 2');
      for (const tenant of tenants) {
        await app.query('BEGIN READ ONLY');
        await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);
        for (const table of tables) {
          const { rows: [expected] } = await admin.query(`SELECT count(*) AS n FROM ${table} WHERE tenant_id=$1`, [tenant.id]);
          const { rows: [actual] } = await app.query(`SELECT count(*) AS n FROM ${table}`);
          if (expected.n !== actual.n) throw new Error('Aplicação não lê exatamente os dados do tenant restaurado');
        }
        await app.query('COMMIT');
      }
      console.log(`login da aplicação, permissões e RLS conferidos; tenants exercitados: ${tenants.length}`);
    } finally { await app.end(); }
  } else throw new Error('modo inválido');
} catch (error) {
  console.error(error?.stderr ? 'Falha na comparação de schema em banco descartável' : error.message);
  process.exitCode = 1;
} finally { await admin.end(); }
