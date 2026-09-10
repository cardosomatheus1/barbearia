"""Apply the real migrator to disposable databases, including an interrupted first migration."""
from pathlib import Path
import os, subprocess, json
from urllib.parse import urlparse
root=Path(__file__).resolve().parents[1]
admin=os.environ['ADMIN_DATABASE_URL']
assert urlparse(admin).hostname=='127.0.0.1' and urlparse(admin).port==5432
base=admin.rsplit('/',1)[0]
def sql(db, query):
 return subprocess.check_output(['psql',base+'/'+db,'-X','-q','-tA','-v','ON_ERROR_STOP=1','-c',query],text=True).strip()
def migrate(db):
 env=dict(os.environ,DATABASE_URL=base+'/'+db)
 return subprocess.run(['bash','packages/db/scripts/migrate.sh'],cwd=root,env=env,text=True,capture_output=True)
full='barbearia_audit_independent'
partial='barbearia_audit_partial'
for name in [full,partial]:
 assert name.startswith('barbearia_audit_')
 sql('postgres',f'DROP DATABASE IF EXISTS {name} WITH (FORCE)')
 sql('postgres',f'CREATE DATABASE {name}')
first=migrate(full)
if first.returncode: print(first.stdout[-2000:]+first.stderr[-2000:])
assert first.returncode==0
count=int(sql(full,'SELECT count(*) FROM schema_migrations'))
assert count==119
second=migrate(full)
assert second.returncode==0 and 'nada a aplicar' in second.stdout
print(json.dumps({'scenario':'Migração limpa e segunda execução','migrations':count,'first_exit':first.returncode,'second_exit':second.returncode},ensure_ascii=False))
query="""SELECT json_build_object(
 'tables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'),
 'rls_tables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity),
 'forced_rls_tables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relforcerowsecurity),
 'tenant_tables_without_forced_rls',(SELECT coalesce(json_agg(c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relforcerowsecurity AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)),
 'policies',(SELECT count(*) FROM pg_policies WHERE schemaname='public'))"""
print(json.dumps({'scenario':'Inventário do schema aplicado','catalog':json.loads(sql(full,query))},ensure_ascii=False))
# Simulates a process lost after migration 0001 commits but before the tracking INSERT.
initial=sorted((root/'packages/db/migrations').glob('*.sql'))[0]
loaded=subprocess.run(['psql',base+'/'+partial,'-X','-q','-v','ON_ERROR_STOP=1','-f',str(initial)],text=True,capture_output=True)
assert loaded.returncode==0,loaded.stderr
sql(partial,'CREATE TABLE schema_migrations (nome text PRIMARY KEY, aplicada_em timestamptz NOT NULL DEFAULT now())')
result=migrate(partial)
recorded=int(sql(partial,'SELECT count(*) FROM schema_migrations'))
missing=sql(partial,"SELECT to_regclass('public.staff_users') IS NULL")
print(json.dumps({'scenario':'Retomada após 0001 aplicada e ainda não registrada','exit_code':result.returncode,'recorded_as_applied':recorded,'staff_users_missing':missing=='t','last_errors':result.stderr.splitlines()[-4:],'conclusion':'O migrador adota todo o baseline 0083 com base apenas na presença de uma tabela, marcando migrações que não foram executadas.'},ensure_ascii=False))
assert result.returncode!=0 and recorded>=83 and missing=='t'
