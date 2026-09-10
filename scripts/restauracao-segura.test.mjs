import test, { before } from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withScratchDatabase, sql } from '../packages/db/scripts/schema-tools.mjs';
const admin = process.env.ADMIN_DATABASE_URL;
before(() => {
  if (!admin) return;
  process.env.APP_DB_PASSWORD ??= randomBytes(24).toString('hex');
  execFileSync('bash', ['scripts/bootstrap-role.sh'], { env: process.env, stdio: 'pipe' });
});
const migrate = (url) => execFileSync('bash', ['packages/db/scripts/migrate.sh'], {
  env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe',
});
const restore = (url) => spawnSync('bash', ['scripts/ensaio-de-restauracao.sh', new URL(url).pathname.slice(1)], {
  encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: process.env,
});
test('assinatura dos dados detecta alteração sem mudar contagem ou estrutura e ignora ordem física', { skip: !admin }, async () => {
  await withScratchDatabase(admin, async (url) => {
    const assinatura = () => execFileSync('node', ['packages/db/scripts/check-schema.mjs', 'data-signature', url],
      { encoding: 'utf8', env: process.env }).trim();
    sql(url, `CREATE TABLE registro(id integer PRIMARY KEY, valor text); INSERT INTO registro VALUES(1,'original'),(2,'segundo');`);
    const antes = assinatura();
    assert.match(antes, /^[a-f0-9]{64}$/);
    sql(url, "UPDATE registro SET valor='alterado' WHERE id=1");
    assert.notEqual(assinatura(), antes);
    sql(url, "DELETE FROM registro; INSERT INTO registro VALUES(2,'segundo'),(1,'original')");
    assert.equal(assinatura(), antes);
  });
});
test('backup atual restaura duas barbearias e permite acesso isolado com login da aplicação', { skip: !admin }, async () => {
  await withScratchDatabase(admin, async (url) => {
    migrate(url);
    sql(url, `INSERT INTO tenants(id,name) VALUES ('11111111-1111-4111-8111-111111111111','Teste A'),
      ('22222222-2222-4222-8222-222222222222','Teste B');
      INSERT INTO customers(tenant_id,name,phone_e164) VALUES
      ('11111111-1111-4111-8111-111111111111','Cliente A','+5511999990001'),
      ('22222222-2222-4222-8222-222222222222','Cliente B','+5511999990002');`);
    const result = restore(url);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /tenants exercitados: 2/);
    assert.match(result.stdout, /checksum e estrutura conferidos/);
  });
});
test('schema antigo com import_id não é aceito como versão atual', { skip: !admin }, async () => {
  await withScratchDatabase(admin, async (url) => {
    for (const name of readdirSync('packages/db/migrations').sort().filter((name) => name <= '0025_zzzz.sql')) {
      sql(url, readFileSync(resolve('packages/db/migrations', name), 'utf8'));
    }
    const result = restore(url);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /schema ou histórico incompleto/);
  });
});
test('restore não aprova permissões perdidas mesmo quando o administrador lê o banco', { skip: !admin }, async () => {
  await withScratchDatabase(admin, async (url) => {
    migrate(url);
    sql(url, 'REVOKE SELECT ON customers FROM barbearia_app; SELECT count(*) FROM customers;');
    const result = restore(url);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /não atende ao role real da aplicação/);
  });
});
