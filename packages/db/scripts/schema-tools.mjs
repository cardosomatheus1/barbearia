import { Client } from 'pg';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

export function databaseUrl(base, name) {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

export function sql(url, text, singleTransaction = false) {
  return execFileSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    ...(singleTransaction ? ['--single-transaction'] : [])], {
    input: text, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export async function withScratchDatabase(adminUrl, action) {
  const name = `audit_schema_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    return await action(databaseUrl(adminUrl, name));
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

function dumpSchema(url) {
  return execFileSync('pg_dump', [url, '--schema-only', '--no-owner',
    '--exclude-table=public.schema_migrations', '--exclude-table=public.schema_migration_attempts'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Reparse pelo PostgreSQL, em vez de apagar casts com regex e esconder diferenças. */
export async function canonicalSchema(url, adminUrl) {
  return withScratchDatabase(adminUrl, async (scratch) => {
    sql(scratch, dumpSchema(url));
    const stable = dumpSchema(scratch).split('\n')
      .filter((line) => !/^\\(?:un)?restrict /.test(line))
      .join('\n').trim();
    return createHash('sha256').update(stable).digest('hex');
  });
}
