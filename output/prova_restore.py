"""Check the app role after restoring with the exact flags used by the restore drill."""
from pathlib import Path
from urllib.parse import urlparse
import os, subprocess, json
root=Path(__file__).resolve().parents[1]
runtime=Path('/home/ec2-user/codex-tmp/barbearia-audit-runtime')
admin=os.environ['ADMIN_DATABASE_URL']; assert urlparse(admin).hostname=='127.0.0.1'
base=admin.rsplit('/',1)[0]; source='barbearia_audit_independent'; restored='barbearia_audit_restored'
def sql(db,query):
 return subprocess.check_output(['psql',base+'/'+db,'-X','-q','-tA','-v','ON_ERROR_STOP=1','-c',query],text=True).strip()
official=subprocess.run(['bash','scripts/ensaio-de-restauracao.sh',source],cwd=root,env=os.environ,text=True,capture_output=True)
print(json.dumps({'scenario':'Ensaio oficial de restore','exit_code':official.returncode,'last_output':official.stdout.splitlines()[-4:]},ensure_ascii=False))
assert official.returncode==0,official.stderr[-2000:]
sql('postgres',f'DROP DATABASE IF EXISTS {restored} WITH (FORCE)');sql('postgres',f'CREATE DATABASE {restored}')
dump=runtime/'independent-restore.sql'
subprocess.run(['pg_dump',base+'/'+source,'--format=plain','--no-owner','--no-privileges','--file='+str(dump)],check=True,capture_output=True)
result=subprocess.run(['psql',base+'/'+restored,'-X','-q','-v','ON_ERROR_STOP=1','-f',str(dump)],text=True,capture_output=True)
assert result.returncode==0,result.stderr[-2000:]
query="SELECT has_table_privilege('barbearia_app','public.customers','SELECT')"
before=sql(source,query);after=sql(restored,query)
attempt=subprocess.run(['psql',base+'/'+restored,'-X','-q','-v','ON_ERROR_STOP=1','-c',"SET ROLE barbearia_app; SELECT count(*) FROM customers;"],text=True,capture_output=True)
print(json.dumps({'scenario':'Role da aplicação após restore com --no-privileges','select_before':before,'select_after':after,'app_query_exit':attempt.returncode,'app_query_error':attempt.stderr.strip(),'official_drill_reported_success':official.returncode==0},ensure_ascii=False))
assert before=='t' and after=='f' and attempt.returncode!=0
old='barbearia_audit_oldschema'
sql('postgres',f'DROP DATABASE IF EXISTS {old} WITH (FORCE)');sql('postgres',f'CREATE DATABASE {old}')
for path in sorted((root/'packages/db/migrations').glob('*.sql'))[:25]:
 r=subprocess.run(['psql',base+'/'+old,'-X','-q','-v','ON_ERROR_STOP=1','-f',str(path)],capture_output=True,text=True)
 assert r.returncode==0,r.stderr[-2000:]
stale=subprocess.run(['bash','scripts/ensaio-de-restauracao.sh',old],cwd=root,env=os.environ,text=True,capture_output=True)
print(json.dumps({'scenario':'Ensaio oficial com banco antigo da migração 0025','exit_code':stale.returncode,'current_head':'0119','schema_current':False,'last_output':stale.stdout.splitlines()[-5:]},ensure_ascii=False))
assert stale.returncode==0,stale.stderr[-2000:]
